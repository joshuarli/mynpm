import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, relative, resolve, sep } from 'node:path';
import { MynpmError } from './errors.mjs';
import { loadInventory } from './inventory-store.mjs';
import { parseNpmLock } from './lock-npm.mjs';
import { parsePnpmLock } from './lock-pnpm.mjs';
import { managerVersions } from './resolve.mjs';
import { publishSite } from './publish.mjs';
import { runProcess } from './process.mjs';

const clientTimeoutMilliseconds = 60 * 60 * 1000;

function fail(category, message, options) {
  throw new MynpmError(category, message, options);
}

function targetForCurrentPlatform(config) {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const cpu = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  let libc = null;
  if (os === 'linux') libc = process.report?.getReport()?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
  const target = config.targets.find(item => item.os === os && item.cpu === cpu && (item.libc ?? null) === libc);
  if (!target) fail('input', `the current platform is not a configured target: ${os ?? process.platform}/${cpu ?? process.arch}/${libc ?? ''}`);
  return target;
}

function supportsTarget(platform, target) {
  for (const [field, value] of [['os', target.os], ['cpu', target.cpu], ['libc', target.libc]]) {
    const values = platform[field];
    if (values === null || value === null || value === undefined) continue;
    const excluded = values.filter(item => item.startsWith('!')).map(item => item.slice(1));
    const included = values.filter(item => !item.startsWith('!'));
    if (excluded.includes(value) || (included.length > 0 && !included.includes(value))) return false;
  }
  return true;
}

function packageSlug(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || 'project';
}

function importerRoots(project, importer) {
  return project.roots.filter(root => root.importer === importer);
}

function buildManifest(project, roots, manager) {
  const dependencies = {};
  for (const root of roots) {
    const group = dependencies[root.group] ?? {};
    const specifier = root.requestedName === root.packageName
      ? root.packageVersion
      : `npm:${root.packageName}@${root.packageVersion}`;
    if (Object.hasOwn(group, root.requestedName) && group[root.requestedName] !== specifier) {
      fail('input', `validation found conflicting root specifiers for ${root.requestedName}`);
    }
    group[root.requestedName] = specifier;
    dependencies[root.group] = group;
  }
  return {
    name: `mynpm-validation-${packageSlug(project.id)}-${packageSlug(roots[0].importer)}`,
    version: '1.0.0',
    private: true,
    packageManager: `${manager}@${managerVersions[manager]}`,
    ...dependencies,
  };
}

function integrityKey(value, artifactRecord, identity) {
  if (!artifactRecord) fail('corrupt', `no verified artifact is available for ${identity}`);
  const expected = new Map([['sha512', artifactRecord.artifact.sha512]]);
  if (artifactRecord.artifact.shasum !== null) expected.set('sha1', artifactRecord.artifact.shasum);
  if (value !== null) {
    for (const token of value.split(/\s+/)) {
      const [claim] = token.split('?', 1);
      const separator = claim.indexOf('-');
      const algorithm = claim.slice(0, separator);
      const digest = claim.slice(separator + 1);
      const expectedDigest = expected.get(algorithm);
      if (expectedDigest === undefined || Buffer.from(digest, 'base64').toString('hex') !== expectedDigest) {
        fail('conflict', `${algorithm || 'unknown'} integrity does not match verified artifact for ${identity}`);
      }
    }
  }
  return artifactRecord.artifact.integrity;
}

function packageSelection(project, target, artifacts, { allowLocalHost = false, localOrigin } = {}) {
  const artifactByIdentity = new Map(artifacts.map(record => [`${record.name}\0${record.version}`, record]));
  const selected = new Map();
  for (const item of project.packages) {
    if (allowLocalHost && item.sourceKind === 'local' && item.version !== null) {
      fail('conflict', `validation lock contains a local source for ${item.name}@${item.version}`);
    }
    if (item.version === null || item.sourceKind === 'local' || !supportsTarget(item.platform, target)) continue;
    if (!allowLocalHost && item.sourceKind !== 'registry') continue;
    if (allowLocalHost) {
      if (item.sourceKind === 'git') fail('conflict', `validation lock contains a git source for ${item.name}@${item.version}`);
      if (item.resolved !== null) {
        let resolved;
        try {
          resolved = new URL(item.resolved);
        } catch (cause) {
          throw new MynpmError('conflict', `validation lock contains an invalid source for ${item.name}@${item.version}`, { cause });
        }
        if (resolved.origin !== localOrigin) fail('conflict', `validation lock resolved ${item.name}@${item.version} outside the local static site`);
      }
    }
    const identity = `${item.name}@${item.version}`;
    const key = `${identity}\0${integrityKey(item.integrity, artifactByIdentity.get(`${item.name}\0${item.version}`), identity)}`;
    selected.set(key, { identity, integrity: key.slice(key.indexOf('\0') + 1) });
  }
  return [...selected.values()].sort((left, right) => left.identity.localeCompare(right.identity) || left.integrity.localeCompare(right.integrity));
}

function compareSelections(expected, actual, projectId, manager) {
  const key = item => `${item.identity}\0${item.integrity}`;
  const expectedSet = new Set(expected.map(key));
  const actualSet = new Set(actual.map(key));
  const missing = [...expectedSet].filter(item => !actualSet.has(item)).sort();
  const extra = [...actualSet].filter(item => !expectedSet.has(item)).sort();
  if (missing.length > 0 || extra.length > 0) {
    fail('conflict', `${manager} validation changed package/version/integrity selections for ${projectId}; missing ${missing.length}, added ${extra.length}`);
  }
}

function unionSelections(selections) {
  const unique = new Map(selections.map(item => [`${item.identity}\0${item.integrity}`, item]));
  return [...unique.values()].sort((left, right) => left.identity.localeCompare(right.identity) || left.integrity.localeCompare(right.integrity));
}

function clientEnvironment(workspace, registry, cacheDirectory) {
  const environment = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C',
    LC_ALL: 'C',
    HOME: join(workspace, 'home'),
    TMPDIR: resolve(process.cwd(), '.work', 'tmp'),
    XDG_CONFIG_HOME: join(workspace, 'config'),
    COREPACK_HOME: join(workspace, 'corepack'),
    CI: 'true',
    npm_config_userconfig: join(workspace, 'user.npmrc'),
    npm_config_globalconfig: join(workspace, 'global.npmrc'),
    npm_config_registry: registry,
    npm_config_cache: cacheDirectory,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '0',
    pnpm_config_store_dir: join(workspace, 'pnpm-store'),
  };
  return environment;
}

async function createClientEnvironment(workspace, registry, cacheDirectory) {
  const environment = clientEnvironment(workspace, registry, cacheDirectory);
  for (const directory of [environment.HOME, environment.XDG_CONFIG_HOME, cacheDirectory, environment.pnpm_config_store_dir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await writeFile(environment.npm_config_userconfig, `registry=${registry}\naudit=false\nfund=false\nignore-scripts=true\n`);
  await writeFile(environment.npm_config_globalconfig, '');
  return environment;
}

function safeStaticPath(pathname, mountPrefix) {
  if (mountPrefix !== '/' && !pathname.startsWith(mountPrefix)) return null;
  const relativePath = mountPrefix === '/' ? pathname.slice(1) : pathname.slice(mountPrefix.length);
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..' || segment.includes('\\'))) return null;
  return segments;
}

async function startStaticServer(mirrorDirectory) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const prefix = pathname.startsWith('/mirror/')
      ? '/mirror/'
      : pathname.startsWith('/current/') || pathname.startsWith('/tarballs/')
        ? '/'
        : null;
    requests.push({ method: request.method, pathname, prefix });
    if (prefix === null) {
      response.writeHead(404).end();
      return;
    }
    const segments = safeStaticPath(pathname, prefix);
    if (segments === null || segments.length === 0) {
      response.writeHead(404).end();
      return;
    }
    if (segments[0] !== 'current' && segments[0] !== 'tarballs') {
      response.writeHead(404).end();
      return;
    }
    const filePath = resolve(mirrorDirectory, ...segments);
    const pathFromRoot = relative(mirrorDirectory, filePath);
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(filePath);
      const metadata = segments[0] === 'current';
      response.writeHead(200, {
        'Content-Type': metadata ? 'application/json' : 'application/octet-stream',
        'Cache-Control': metadata ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (cause) {
      response.writeHead(cause.code === 'ENOENT' ? 404 : 500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, requests, port: server.address().port };
}

async function checkClientVersion(client, target, cwd, environment, dependencies) {
  const expected = managerVersions[client];
  if (process.version !== `v${target.node}`) {
    fail('operation', `${client} validation requires Node.js ${target.node}; found ${process.version}`);
  }
  const version = (await (dependencies.runProcess ?? runProcess)(client, ['--version'], {
    cwd,
    env: environment,
    timeoutMs: 30_000,
  })).stdout.trim().split(/\s+/)[0];
  if (version !== expected) fail('operation', `${client} ${expected} is required for validation; found ${version || 'no version output'}`);
  return version;
}

async function readLockSelection(manager, projectDirectory, projectId, target, localOrigin, artifacts) {
  const fileName = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
  let text;
  try {
    text = await readFile(join(projectDirectory, fileName), 'utf8');
  } catch (cause) {
    throw new MynpmError('operation', `${manager} did not create ${fileName}`, { cause });
  }
  let project;
  const options = { projectId, lockfilePath: fileName, targetIds: [target.id], packageManagerPin: `${manager}@${managerVersions[manager]}` };
  if (manager === 'npm') {
    try {
      project = parseNpmLock(JSON.parse(text), options);
    } catch (cause) {
      if (cause instanceof MynpmError) throw cause;
      throw new MynpmError('input', 'npm produced an invalid package-lock.json', { cause });
    }
  } else {
    project = await parsePnpmLock(text, options);
  }
  return packageSelection(project, target, artifacts, { allowLocalHost: true, localOrigin });
}

function projectGroups(project, target, manager) {
  if (!project.targets.includes(target.id)) return [];
  const unsupported = project.packages.find(item => item.version !== null && supportsTarget(item.platform, target) && item.sourceKind !== 'registry');
  if (unsupported) fail('input', `validation rejects ${unsupported.sourceKind} source ${unsupported.name}${unsupported.version ? `@${unsupported.version}` : ''}`);
  const importers = [...new Set(project.roots.map(root => root.importer))].sort();
  const groups = [];
  for (const importer of importers) {
    const roots = importerRoots(project, importer);
    if (roots.length === 0) continue;
    for (const root of roots) {
      const record = root.packageKey === null ? null : project.packages.find(item => item.key === root.packageKey);
      if (record === null || record === undefined) {
        fail('input', `validation cannot reproduce unresolved or local root ${root.requestedName} in ${project.id}`);
      }
      if (record.sourceKind !== 'registry' || record.version === null) {
        fail('input', `validation rejects ${record.sourceKind} root ${record.name}${record.version ? `@${record.version}` : ''}`);
      }
    }
    groups.push({ importer, roots, manifest: buildManifest(project, roots, manager) });
  }
  return groups;
}

async function checkExecutables(projectDirectory, project, roots, target, environment, dependencies) {
  const outputs = {};
  const typescriptVersion = roots.find(root => root.packageName === 'typescript')?.packageVersion
    ?? project.packages.find(item => item.name === 'typescript' && item.key === 'node_modules/typescript')?.version;
  if (typescriptVersion !== undefined) {
    const result = await (dependencies.runProcess ?? runProcess)(process.execPath, ['node_modules/typescript/bin/tsc', '--version'], {
      cwd: projectDirectory,
      env: environment,
      timeoutMs: 30_000,
    });
    outputs.typescript = result.stdout.trim();
    if (outputs.typescript !== `Version ${typescriptVersion}`) fail('conflict', `TypeScript executable did not report the selected version ${typescriptVersion}`);
  }
  const esbuildVersion = roots.find(root => root.packageName === 'esbuild')?.packageVersion
    ?? project.packages.find(item => item.name === 'esbuild' && item.key === 'node_modules/esbuild')?.version;
  if (esbuildVersion !== undefined) {
    const result = await (dependencies.runProcess ?? runProcess)(process.execPath, ['node_modules/esbuild/bin/esbuild', '--version'], {
      cwd: projectDirectory,
      env: environment,
      timeoutMs: 30_000,
    });
    outputs.esbuild = result.stdout.trim();
    if (outputs.esbuild !== esbuildVersion) fail('conflict', `esbuild executable did not report the selected version ${esbuildVersion}`);
  }
  return outputs;
}

async function installImporter({ client, project, group, target, workspace, registry, localOrigin, packageNumber, dependencies }) {
  const projectDirectory = join(workspace, 'projects', `${packageSlug(project.id)}-${packageNumber}`);
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  const manifest = { ...group.manifest };
  await writeFile(join(projectDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const installWorkspace = join(workspace, 'clients', `${packageSlug(project.id)}-${packageNumber}`);
  await mkdir(installWorkspace, { recursive: true, mode: 0o700 });
  const initialCache = join(installWorkspace, 'cache-before-install');
  const initialEnvironment = await createClientEnvironment(installWorkspace, registry, initialCache);
  const run = dependencies.runProcess ?? runProcess;
  if (client === 'npm') {
    await run(client, [
      'install', `--registry=${registry}`, `--cache=${initialCache}`, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0',
    ], { cwd: projectDirectory, env: initialEnvironment, signal: dependencies.signal, timeoutMs: clientTimeoutMilliseconds });
  } else {
    await run(client, [
      'install', '--lockfile-only', `--registry=${registry}`, `--store-dir=${join(installWorkspace, 'lockfile-store')}`, '--ignore-scripts',
    ], { cwd: projectDirectory, env: initialEnvironment, signal: dependencies.signal, timeoutMs: clientTimeoutMilliseconds });
  }
  const resolvedSelection = await readLockSelection(client, projectDirectory, `${project.id}-${group.importer}`, target, localOrigin, dependencies.artifacts);
  if (client === 'npm') {
    const cleanCache = join(installWorkspace, 'cache-ci');
    const cleanEnvironment = await createClientEnvironment(installWorkspace, registry, cleanCache);
    await run(client, [
      'ci', `--registry=${registry}`, `--cache=${cleanCache}`, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0',
    ], { cwd: projectDirectory, env: cleanEnvironment, signal: dependencies.signal, timeoutMs: clientTimeoutMilliseconds });
  } else {
    const cleanStore = join(installWorkspace, 'frozen-store');
    const frozenEnvironment = await createClientEnvironment(installWorkspace, registry, join(installWorkspace, 'cache-frozen'));
    await run(client, [
      'install', '--frozen-lockfile', `--registry=${registry}`, `--store-dir=${cleanStore}`, '--ignore-scripts',
    ], { cwd: projectDirectory, env: frozenEnvironment, signal: dependencies.signal, timeoutMs: clientTimeoutMilliseconds });
  }
  const executables = await checkExecutables(projectDirectory, project, group.roots, target, initialEnvironment, dependencies);
  return { selection: resolvedSelection, executables };
}

export async function validateInventory({ client, stateDirectory, config, signal, cwd = process.cwd() }, dependencies = {}) {
  if (!['npm', 'pnpm'].includes(client)) fail('input', 'validate requires client npm or pnpm');
  const target = targetForCurrentPlatform(config);
  const inventory = await loadInventory(stateDirectory);
  const projects = inventory.projects.filter(project => project.manager === client && project.targets.includes(target.id));
  if (projects.length === 0) fail('input', `inventory contains no ${client} projects for target ${target.id}`);
  const groups = projects.flatMap(project => projectGroups(project, target, client).map(group => ({ project, group })));
  if (groups.length === 0) fail('input', `inventory contains no reproducible ${client} registry roots for target ${target.id}`);
  const scratchRoot = resolve(cwd, '.work', 'tmp');
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(join(scratchRoot, 'mynpm-validate-'));
  let staticServer;
  try {
    const siteDirectory = join(workspace, 'site');
    const mirrorDirectory = join(siteDirectory, 'mirror');
    await mkdir(mirrorDirectory, { recursive: true, mode: 0o700 });
    staticServer = await startStaticServer(mirrorDirectory);
    const origin = `http://127.0.0.1:${staticServer.port}`;
    const artifacts = inventory.artifacts;
    const environment = await createClientEnvironment(workspace, `${origin}/current/`, join(workspace, 'tool-cache'));
    const version = await checkClientVersion(client, target, cwd, environment, dependencies);
    let packageNumber = 0;
    const validatedSelections = new Set();
    const executableResults = [];
    let finalGenerationId;
    for (const mount of ['/mirror/', '/']) {
      const publicBaseUrl = `${origin}${mount}`;
      const published = await publishSite({ stateDirectory, siteDirectory, config }, { renderBaseUrl: publicBaseUrl });
      finalGenerationId = published.generationId;
      const registry = `${publicBaseUrl}current/`;
      const selectionsByProject = new Map(projects.map(project => [project, []]));
      for (const { project, group } of groups) {
        packageNumber += 1;
        const result = await installImporter({
          client,
          project,
          group,
          target,
          workspace,
          registry,
          localOrigin: origin,
          packageNumber,
          dependencies: { ...dependencies, artifacts, signal },
        });
        selectionsByProject.get(project).push(...result.selection);
        executableResults.push(...Object.entries(result.executables).map(([name, output]) => ({ name, output })));
      }
      for (const project of projects) {
        const actual = unionSelections(selectionsByProject.get(project));
        const expected = packageSelection(project, target, artifacts, {});
        compareSelections(expected, actual, project.id, client);
        for (const item of expected) validatedSelections.add(`${project.id}\0${item.identity}\0${item.integrity}`);
      }
    }
    const invalidRequest = staticServer.requests.find(request => request.prefix === null);
    if (invalidRequest) fail('conflict', `validation served a request outside the local static site: ${invalidRequest.pathname}`);
    if (staticServer.requests.length === 0) fail('operation', 'package manager made no requests to the local static site');
    return {
      client,
      version,
      nodeVersion: process.version,
      target: target.id,
      packageCount: validatedSelections.size,
      projectCount: projects.length,
      requestCount: staticServer.requests.length,
      generationId: finalGenerationId,
      executables: executableResults,
    };
  } finally {
    if (staticServer) {
      staticServer.server.closeAllConnections?.();
      await new Promise((resolveClose, rejectClose) => staticServer.server.close(error => error ? rejectClose(error) : resolveClose()));
    }
    await rm(workspace, { recursive: true, force: true });
  }
}
