import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MynpmError } from './errors.mjs';
import { mergeProject } from './inventory.mjs';
import { updateInventory } from './inventory-store.mjs';
import { parseNpmLock } from './lock-npm.mjs';
import { parsePnpmLock } from './lock-pnpm.mjs';
import { runProcess } from './process.mjs';

const managerVersions = Object.freeze({ npm: '12.2.1', pnpm: '12.15.0' });
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const operationTimeout = 60 * 60 * 1000;

function parseRootPins(values) {
  const roots = values.map(value => {
    const separator = value.startsWith('@') ? value.lastIndexOf('@') : value.indexOf('@');
    if (separator <= 0 || separator === value.length - 1) {
      throw new MynpmError('input', `add requires an exact package pin: ${value}`);
    }
    const name = value.slice(0, separator);
    const version = value.slice(separator + 1);
    if (!packageNamePattern.test(name) || !versionPattern.test(version)) {
      throw new MynpmError('input', `add requires an exact package pin: ${value}`);
    }
    return { name, version };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const names = roots.map(root => root.name);
  if (new Set(names).size !== names.length) throw new MynpmError('input', 'add accepts only one exact version per root package');
  return roots;
}

function targetIds(config, requestedTargets) {
  const ids = requestedTargets.length > 0 ? requestedTargets : config.targets.map(target => target.id);
  const available = new Set(config.targets.map(target => target.id));
  if (new Set(ids).size !== ids.length) throw new MynpmError('input', 'target IDs must be unique');
  for (const id of ids) if (!available.has(id)) throw new MynpmError('input', `target is not configured: ${id}`);
  return [...ids].sort();
}

function toolEnvironment(workspace, target, registry, runtime) {
  const home = join(workspace, 'home');
  const cache = join(workspace, 'cache');
  const store = join(workspace, 'store');
  const config = join(workspace, 'npmrc');
  return {
    PATH: runtime.path,
    LANG: runtime.locale,
    LC_ALL: 'C',
    CI: 'true',
    HOME: home,
    TMPDIR: runtime.temporaryDirectory,
    npm_config_userconfig: config,
    npm_config_cache: cache,
    npm_config_registry: registry,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fetch_timeout: '600000',
    npm_config_os: target.os,
    npm_config_cpu: target.cpu,
    npm_config_node_version: target.node,
    ...(target.libc ? { npm_config_libc: target.libc } : {}),
    pnpm_config_store_dir: store,
    COREPACK_HOME: join(workspace, 'corepack'),
  };
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

async function resolveTarget({ manager, roots, target, config, workspace, runtime, signal }) {
  const packageManagerPin = `${manager}@${managerVersions[manager]}`;
  const projectDirectory = join(workspace, target.id);
  await ensureDirectory(projectDirectory);
  const manifest = {
    name: 'mynpm-resolution',
    version: '0.0.0',
    private: true,
    packageManager: packageManagerPin,
    dependencies: Object.fromEntries(roots.map(root => [root.name, root.version])),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(projectDirectory, 'package.json'), manifestText, { flag: 'wx' });
  const environment = toolEnvironment(workspace, target, config.upstreamRegistry, runtime);
  await ensureDirectory(environment.HOME);
  await ensureDirectory(environment.npm_config_cache);
  await ensureDirectory(environment.pnpm_config_store_dir);
  await writeFile(environment.npm_config_userconfig, `registry=${config.upstreamRegistry}\naudit=false\nfund=false\nignore-scripts=true\n`);
  const version = (await runProcess(manager, ['--version'], {
    cwd: projectDirectory,
    env: environment,
    signal,
    timeoutMs: 30_000,
  })).stdout.trim().split(/\s+/)[0];
  if (version !== managerVersions[manager]) {
    throw new MynpmError('operation', `${manager} ${managerVersions[manager]} is required for add; found ${version || 'no version output'}`);
  }
  const args = manager === 'npm'
    ? ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...roots.map(root => `${root.name}@${root.version}`)]
    : ['install', '--lockfile-only', '--ignore-scripts', ...roots.map(root => `${root.name}@${root.version}`)];
  await runProcess(manager, args, {
    cwd: projectDirectory,
    env: environment,
    signal,
    timeoutMs: operationTimeout,
  });
  const lockfileName = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
  const lockfilePath = join(projectDirectory, lockfileName);
  let lockText;
  try {
    lockText = await readFile(lockfilePath, 'utf8');
  } catch (cause) {
    throw new MynpmError('operation', `${manager} did not create ${lockfileName}`, { cause });
  }
  const parseOptions = {
    projectId: `add-${manager}-${target.id}`,
    packageManagerPin,
    lockfilePath: `add/${manager}/${target.id}/${lockfileName}`,
    targetIds: [target.id],
    snapshot: { manifest: manifestText, lockfile: lockText, workspaceFiles: [] },
  };
  const project = manager === 'npm'
    ? parseNpmLock(parseJson(lockText), parseOptions)
    : await parsePnpmLock(lockText, parseOptions);
  verifyRootSelections(project, roots, target, manager);
  const unsupported = project.packages.find(pkg => !['registry'].includes(pkg.sourceKind));
  if (unsupported) {
    throw new MynpmError('input', `add rejected ${unsupported.sourceKind} source ${unsupported.name}${unsupported.version ? `@${unsupported.version}` : ''}`);
  }
  return project;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('input', 'npm produced an invalid package-lock.json', { cause });
  }
}

function verifyRootSelections(project, roots, target, manager) {
  const observed = project.roots.filter(root => root.importer === '.' && root.group === 'dependencies');
  if (manager === 'npm' && observed.length !== roots.length) {
    throw new MynpmError('conflict', `resolved root set differs for target ${target.id}`);
  }
  for (const expected of roots) {
    const selected = observed.filter(root => root.requestedName === expected.name);
    if (selected.length === 0 || selected.some(root => root.packageName !== expected.name || root.packageVersion !== expected.version)) {
      throw new MynpmError('conflict', `resolver did not select ${expected.name}@${expected.version} for target ${target.id}`);
    }
  }
}

export async function addPackages({ manager, specs, requestedTargets, config, stateDirectory, cwd = process.cwd(), signal }) {
  const roots = parseRootPins(specs);
  const runtime = {
    path: process.env.PATH ?? '',
    locale: process.env.LANG ?? 'C',
    temporaryDirectory: resolve(cwd, '.work', 'tmp'),
  };
  const targets = targetIds(config, requestedTargets).map(id => config.targets.find(target => target.id === id));
  const scratchRoot = resolve(cwd, '.work', 'tmp');
  await ensureDirectory(scratchRoot);
  const workspace = await mkdtemp(join(scratchRoot, 'mynpm-add-'));
  try {
    const projects = [];
    for (const target of targets) {
      projects.push(await resolveTarget({ manager, roots, target, config, workspace, runtime, signal }));
    }
    await updateInventory(stateDirectory, inventory => projects.reduce((result, project) => mergeProject(result, project), inventory));
    process.stdout.write(`Added ${roots.length} root pins for ${targets.map(target => target.id).join(', ')} with ${manager}@${managerVersions[manager]}.\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export { managerVersions };
