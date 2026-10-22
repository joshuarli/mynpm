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
    pnpm_config_pm_on_fail: 'ignore',
    pnpm_config_trust_lockfile: 'true',
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

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function canonicalText(value) {
  return JSON.stringify(canonicalValue(value));
}

async function pnpmDocuments(text) {
  let yaml;
  try {
    yaml = await import('yaml');
  } catch (cause) {
    throw new MynpmError('operation', 'pnpm validation requires the pinned yaml@2.9.1 dependency; install locked project dependencies', { cause });
  }
  let documents;
  try {
    documents = yaml.parseAllDocuments(text, { uniqueKeys: true });
  } catch (cause) {
    throw new MynpmError('input', 'pnpm lockfile is not valid YAML', { cause });
  }
  const errors = documents.flatMap(document => document.errors);
  if (errors.length > 0) throw new MynpmError('input', `pnpm lockfile contains invalid YAML: ${errors[0].message}`, { cause: errors[0] });
  return { yaml, values: documents.map(document => document.toJS({ maxAliasCount: 100 })) };
}

async function parseProjectLock(manager, text, options) {
  if (manager === 'npm') {
    try {
      return parseNpmLock(JSON.parse(text), options);
    } catch (cause) {
      if (cause instanceof MynpmError) throw cause;
      throw new MynpmError('input', 'npm package-lock.json is not valid JSON', { cause });
    }
  }
  return parsePnpmLock(text, options);
}

function projectWithoutSnapshot(project) {
  return { ...project, snapshot: null };
}

function workspaceFileMap(snapshot) {
  return new Map(snapshot.workspaceFiles.map(file => [file.path, file.contents]));
}

function safeLocalPath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/^file:/, '').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) return null;
  return normalized;
}

async function assertSnapshotRestorable(project) {
  const snapshot = project.snapshot;
  if (snapshot === null || snapshot.manifest === null) fail('input', `validation requires an imported package.json snapshot for ${project.id}`);
  const files = workspaceFileMap(snapshot);
  if (project.manager === 'npm') {
    const lock = JSON.parse(snapshot.lockfile);
    for (const entry of Object.values(lock.packages ?? {})) {
      if (entry?.link !== true || typeof entry.resolved !== 'string') continue;
      const workspacePath = safeLocalPath(entry.resolved);
      if (workspacePath === null || !files.has(`${workspacePath}/package.json`)) {
        fail('input', `validation cannot restore local workspace ${entry.resolved} for ${project.id}`);
      }
    }
    for (const item of project.packages) {
      if (item.sourceKind === 'local' && item.flags.link !== true && item.version !== null) {
        fail('input', `validation cannot restore local file package ${item.name}@${item.version} for ${project.id}`);
      }
    }
  } else {
    const importers = project.importers.filter(importer => importer !== '.');
    for (const importer of importers) {
      if (!files.has(`${importer}/package.json`)) fail('input', `validation cannot restore pnpm workspace importer ${importer} for ${project.id}`);
    }
    if (importers.length > 0 && !files.has('pnpm-workspace.yaml')) {
      fail('input', `validation cannot restore pnpm workspace configuration for ${project.id}`);
    }
    for (const item of project.packages) {
      if (item.sourceKind === 'local' && item.flags.link !== true && item.version !== null) {
        fail('input', `validation cannot restore local pnpm package ${item.name}@${item.version} for ${project.id}`);
      }
    }
  }
}

async function assertSnapshotMatchesProject(project, target) {
  await assertSnapshotRestorable(project);
  const restored = await parseProjectLock(project.manager, project.snapshot.lockfile, {
    projectId: project.id,
    packageManagerPin: project.packageManagerPin,
    lockfilePath: project.lockfilePath,
    targetIds: project.targets,
    snapshot: null,
  });
  if (canonicalText(projectWithoutSnapshot(restored)) !== canonicalText(projectWithoutSnapshot(project))) {
    fail('corrupt', `saved ${project.manager} lockfile no longer matches imported project ${project.id}`);
  }
  const manifest = JSON.parse(project.snapshot.manifest);
  if ((manifest.packageManager ?? null) !== project.packageManagerPin) {
    fail('corrupt', `saved package.json pin no longer matches imported project ${project.id}`);
  }
  const expectedPackageManagerPin = `${project.manager}@${managerVersions[project.manager]}`;
  if (project.packageManagerPin !== null && project.packageManagerPin.replace(/\+sha512\..*$/, '') !== expectedPackageManagerPin) {
    fail('input', `validation requires ${expectedPackageManagerPin}; project ${project.id} is pinned to ${project.packageManagerPin}`);
  }
  const unsupported = project.packages.find(item => item.version !== null && supportsTarget(item.platform, target) && item.sourceKind !== 'registry' && item.sourceKind !== 'local');
  if (unsupported) fail('input', `validation rejects ${unsupported.sourceKind} source ${unsupported.name}@${unsupported.version}`);
}

function packageArtifact(project, item, artifacts) {
  const artifact = artifacts.find(record => record.name === item.name && record.version === item.version);
  integrityKey(item.integrity, artifact, `${item.name}@${item.version}`);
  return artifact;
}

function localTarballUrl(registry, digest) {
  return new URL(`../tarballs/${digest}.tgz`, registry).href;
}

function unavailableTarballUrl(registry) {
  return new URL('../tarballs/unavailable.tgz', registry).href;
}

function rewriteNpmLock(project, target, artifacts, registry) {
  const lock = JSON.parse(project.snapshot.lockfile);
  for (const item of project.packages) {
    if (item.version === null || item.sourceKind === 'local') continue;
    if (item.sourceKind !== 'registry') fail('input', `validation cannot migrate ${item.sourceKind} source ${item.name}@${item.version}`);
    const entry = lock.packages?.[item.key];
    if (!entry || typeof entry !== 'object') fail('corrupt', `saved npm lockfile is missing ${item.key}`);
    entry.resolved = supportsTarget(item.platform, target)
      ? localTarballUrl(registry, packageArtifact(project, item, artifacts).artifact.sha512)
      : unavailableTarballUrl(registry);
  }
  return `${JSON.stringify(lock, null, 2)}\n`;
}

async function rewritePnpmLock(project, target, artifacts, registry) {
  const { yaml, values } = await pnpmDocuments(project.snapshot.lockfile);
  const packages = new Map(project.packages.map(item => [item.key, item]));
  for (const document of values) {
    for (const [key, entry] of Object.entries(document.packages ?? {})) {
      const item = packages.get(key);
      if (!item || item.version === null || item.sourceKind === 'local') continue;
      if (item.sourceKind !== 'registry') {
        if (supportsTarget(item.platform, target)) fail('input', `validation cannot migrate ${item.sourceKind} source ${item.name}@${item.version}`);
        continue;
      }
      if (!entry.resolution || typeof entry.resolution !== 'object') fail('corrupt', `saved pnpm lockfile is missing package resolution for ${item.name}@${item.version}`);
      entry.resolution.tarball = supportsTarget(item.platform, target)
        ? localTarballUrl(registry, packageArtifact(project, item, artifacts).artifact.sha512)
        : unavailableTarballUrl(registry);
    }
  }
  const documentMarker = /^\s*---(?:\s|$)/.test(project.snapshot.lockfile) ? '---\n' : '';
  return documentMarker + values.map(value => yaml.stringify(value).trimEnd()).join('\n---\n') + '\n';
}

async function assertMigrationPreservesGraph(project, migratedLock) {
  if (project.manager === 'npm') {
    const original = JSON.parse(project.snapshot.lockfile);
    const migrated = JSON.parse(migratedLock);
    for (const item of project.packages) {
      if (item.version === null || item.sourceKind !== 'registry') continue;
      const originalEntry = original.packages?.[item.key];
      const migratedEntry = migrated.packages?.[item.key];
      if (!originalEntry || !migratedEntry) fail('corrupt', `saved npm lockfile is missing ${item.key}`);
      originalEntry.resolved = 'mynpm-local-tarball';
      migratedEntry.resolved = 'mynpm-local-tarball';
    }
    if (canonicalText(original) !== canonicalText(migrated)) fail('conflict', `registry migration changed the saved npm dependency graph for ${project.id}`);
    return;
  }
  const original = (await pnpmDocuments(project.snapshot.lockfile)).values;
  const migrated = (await pnpmDocuments(migratedLock)).values;
  for (const item of project.packages) {
    if (item.version === null || item.sourceKind !== 'registry') continue;
    const originalEntries = original.map(document => document.packages?.[item.key]).filter(Boolean);
    const migratedEntries = migrated.map(document => document.packages?.[item.key]).filter(Boolean);
    if (originalEntries.length === 0 || migratedEntries.length === 0) fail('corrupt', `saved pnpm lockfile is missing ${item.name}@${item.version}`);
    for (const entry of [...originalEntries, ...migratedEntries]) {
      entry.resolution.tarball = 'mynpm-local-tarball';
    }
  }
  if (canonicalText(original) !== canonicalText(migrated)) fail('conflict', `registry migration changed the saved pnpm dependency graph for ${project.id}`);
}

async function lockGraph(manager, text, project) {
  if (manager === 'npm') {
    let lock;
    try {
      lock = JSON.parse(text);
    } catch (cause) {
      throw new MynpmError('input', `npm package-lock.json is not valid JSON for ${project.id}`, { cause });
    }
    for (const item of project.packages) {
      if (item.version === null || item.sourceKind !== 'registry') continue;
      const entry = lock.packages?.[item.key];
      if (!entry) fail('corrupt', `saved npm lockfile is missing ${item.key}`);
      entry.resolved = 'mynpm-local-tarball';
    }
    return lock;
  }
  const { values } = await pnpmDocuments(text);
  for (const item of project.packages) {
    if (item.version === null || item.sourceKind !== 'registry') continue;
    const entries = values.map(document => document.packages?.[item.key]).filter(Boolean);
    if (entries.length === 0) fail('corrupt', `saved pnpm lockfile is missing ${item.key}`);
    for (const entry of entries) {
      entry.resolution.tarball = 'mynpm-local-tarball';
    }
  }
  return values;
}

async function assertLockfileMatches(manager, expectedText, actualText, project) {
  const expected = await lockGraph(manager, expectedText, project);
  const actual = await lockGraph(manager, actualText, project);
  if (canonicalText(expected) !== canonicalText(actual)) fail('conflict', `${manager} changed the saved dependency graph for ${project.id}`);
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

async function writeProjectSnapshot(projectDirectory, project, lockText, lockfileName) {
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(projectDirectory, 'package.json'), project.snapshot.manifest, { flag: 'wx' });
  await writeFile(join(projectDirectory, lockfileName), lockText, { flag: 'wx' });
  for (const file of project.snapshot.workspaceFiles) {
    const filePath = join(projectDirectory, ...file.path.split('/'));
    const parent = filePath.slice(0, filePath.lastIndexOf('/'));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(filePath, file.contents, { flag: 'wx' });
  }
}

async function assertProjectFilesUnchanged(projectDirectory, project, lockfileName) {
  const files = [
    { path: 'package.json', contents: project.snapshot.manifest },
    ...project.snapshot.workspaceFiles,
  ];
  for (const file of files) {
    if (file.path === lockfileName) continue;
    let actual;
    try {
      actual = await readFile(join(projectDirectory, ...file.path.split('/')), 'utf8');
    } catch (cause) {
      throw new MynpmError('operation', `client removed project snapshot file ${file.path} for ${project.id}`, { cause });
    }
    if (actual !== file.contents) fail('conflict', `${project.manager} changed project snapshot file ${file.path} for ${project.id}`);
  }
}

async function installProject({ client, project, target, workspace, registry, localOrigin, projectNumber, dependencies }) {
  const projectDirectory = join(workspace, 'projects', `${packageSlug(project.id)}-${projectNumber}`);
  const installWorkspace = join(workspace, 'clients', `${packageSlug(project.id)}-${projectNumber}`);
  await mkdir(installWorkspace, { recursive: true, mode: 0o700 });
  const lockfileName = client === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
  const migratedLock = client === 'npm'
    ? rewriteNpmLock(project, target, dependencies.artifacts, registry)
    : await rewritePnpmLock(project, target, dependencies.artifacts, registry);
  await assertMigrationPreservesGraph(project, migratedLock);
  await writeProjectSnapshot(projectDirectory, project, migratedLock, lockfileName);
  const cacheDirectory = join(installWorkspace, 'cache');
  const environment = await createClientEnvironment(installWorkspace, registry, cacheDirectory);
  const run = dependencies.runProcess ?? runProcess;
  const args = client === 'npm'
    ? ['ci', `--registry=${registry}`, `--cache=${cacheDirectory}`, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--allow-remote=all']
    : ['install', '--frozen-lockfile', `--registry=${registry}`, `--store-dir=${join(installWorkspace, 'pnpm-store')}`, '--ignore-scripts'];
  await run(client, args, { cwd: projectDirectory, env: environment, signal: dependencies.signal, timeoutMs: clientTimeoutMilliseconds });
  let actualLock;
  try {
    actualLock = await readFile(join(projectDirectory, lockfileName), 'utf8');
  } catch (cause) {
    throw new MynpmError('operation', `${client} removed ${lockfileName} while restoring ${project.id}`, { cause });
  }
  const actualProject = await parseProjectLock(client, actualLock, {
    projectId: project.id,
    packageManagerPin: project.packageManagerPin,
    lockfilePath: lockfileName,
    targetIds: [target.id],
    snapshot: null,
  });
  await assertLockfileMatches(client, migratedLock, actualLock, project);
  const selection = packageSelection(actualProject, target, dependencies.artifacts, { allowLocalHost: true, localOrigin });
  await assertProjectFilesUnchanged(projectDirectory, project, lockfileName);
  const roots = project.roots.filter(root => root.importer === '.');
  const executables = await checkExecutables(projectDirectory, project, roots, target, environment, dependencies);
  return { selection, executables };
}

export async function validateInventory({ client, stateDirectory, config, signal, cwd = process.cwd() }, dependencies = {}) {
  if (!['npm', 'pnpm'].includes(client)) fail('input', 'validate requires client npm or pnpm');
  const target = targetForCurrentPlatform(config);
  const inventory = await loadInventory(stateDirectory);
  const projects = inventory.projects.filter(project => project.manager === client && project.targets.includes(target.id));
  if (projects.length === 0) fail('input', `inventory contains no ${client} projects for target ${target.id}`);
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
    const environment = await createClientEnvironment(workspace, `${origin}/current/`, join(workspace, 'tool-cache'));
    const version = await checkClientVersion(client, target, cwd, environment, dependencies);
    const artifacts = inventory.artifacts;
    for (const project of projects) await assertSnapshotMatchesProject(project, target);
    const expectedByProject = new Map(projects.map(project => [project, packageSelection(project, target, artifacts)]));
    let projectNumber = 0;
    const validatedSelections = new Set();
    const executableResults = [];
    let finalGenerationId;
    for (const mount of ['/mirror/', '/']) {
      const publicBaseUrl = `${origin}${mount}`;
      const published = await publishSite({ stateDirectory, siteDirectory, config }, { renderBaseUrl: publicBaseUrl });
      finalGenerationId = published.generationId;
      const registry = `${publicBaseUrl}current/`;
      for (const project of projects) {
        projectNumber += 1;
        const result = await installProject({
          client,
          project,
          target,
          workspace,
          registry,
          localOrigin: origin,
          projectNumber,
          dependencies: { ...dependencies, artifacts, signal },
        });
        compareSelections(expectedByProject.get(project), result.selection, project.id, client);
        for (const item of expectedByProject.get(project)) {
          validatedSelections.add(`${project.id}\0${item.identity}\0${item.integrity}`);
        }
        executableResults.push(...Object.entries(result.executables).map(([name, output]) => ({ name, output })));
      }
    }
    const invalidRequest = staticServer.requests.find(request => request.prefix === null);
    if (invalidRequest) fail('conflict', `validation served a request outside the local static site: ${invalidRequest.pathname}`);
    if (validatedSelections.size > 0 && staticServer.requests.length === 0) fail('operation', 'package manager made no requests to the local static site');
    return {
      client,
      version,
      nodeVersion: process.version,
      target: target.id,
      packageCount: validatedSelections.size,
      projectCount: projects.length,
      rootCount: projects.reduce((count, project) => count + project.roots.length, 0),
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
