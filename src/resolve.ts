import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Effect } from 'effect';
import { MynpmError } from './errors.ts';
import type { MynpmConfig, TargetConfig } from './config.ts';
import { mergeProject } from './inventory.ts';
import type { Inventory, PackageManager, ProjectRecord } from './inventory.ts';
import { updateInventory } from './inventory-store.ts';
import { parseNpmLock } from './lock-npm.ts';
import { parsePnpmLock } from './lock-pnpm.ts';
import { runProcess } from './process.ts';
import { assertRestorableProjectSnapshot } from './project-snapshot.ts';

type RootPin = { name: string; version: string };
type ResolverRuntime = { path: string; locale: string; temporaryDirectory: string };
type ResolveTargetOptions = {
  manager: PackageManager;
  roots: readonly RootPin[];
  target: TargetConfig;
  config: MynpmConfig;
  workspace: string;
  runtime: ResolverRuntime;
};
type AddPackagesOptions = {
  manager: PackageManager;
  specs: readonly string[];
  requestedTargets: readonly string[];
  config: MynpmConfig;
  stateDirectory: string;
  cwd?: string;
};

const managerVersions: Readonly<Record<PackageManager, string>> = Object.freeze({ npm: '12.2.1', pnpm: '12.15.0' });
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const operationTimeout = 60 * 60 * 1000;

function parseRootPins(values: readonly string[]): RootPin[] {
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

function targetsFor(config: MynpmConfig, requestedTargets: readonly string[]): TargetConfig[] {
  const ids = requestedTargets.length > 0 ? requestedTargets : config.targets.map(target => target.id);
  const available = new Map(config.targets.map(target => [target.id, target]));
  if (new Set(ids).size !== ids.length) throw new MynpmError('input', 'target IDs must be unique');
  return [...ids].sort().map(id => {
    const target = available.get(id);
    if (target === undefined) throw new MynpmError('input', `target is not configured: ${id}`);
    return target;
  });
}

function toolEnvironment(workspace: string, target: TargetConfig, registry: string, runtime: ResolverRuntime): Record<string, string> {
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
    ...('libc' in target ? { npm_config_libc: target.libc } : {}),
    pnpm_config_store_dir: store,
    COREPACK_HOME: join(workspace, 'corepack'),
  };
}

function operationFailure(cause: unknown, message: string): MynpmError {
  return cause instanceof MynpmError ? cause : new MynpmError('operation', message, { cause });
}

function inputFailure(cause: unknown, message: string): MynpmError {
  return cause instanceof MynpmError ? cause : new MynpmError('input', message, { cause });
}

function ensureDirectory(path: string): Effect.Effect<void, MynpmError> {
  return Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }),
    catch: cause => operationFailure(cause, `could not create directory ${path}`),
  });
}

function resolveTarget({ manager, roots, target, config, workspace, runtime }: ResolveTargetOptions): Effect.Effect<ProjectRecord, MynpmError> {
  return Effect.gen(function*() {
    const packageManagerPin = `${manager}@${managerVersions[manager]}`;
    const projectDirectory = join(workspace, target.id);
    yield* ensureDirectory(projectDirectory);
    const manifest = {
      name: 'mynpm-resolution',
      version: '0.0.0',
      private: true,
      packageManager: packageManagerPin,
      dependencies: Object.fromEntries(roots.map(root => [root.name, root.version])),
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const resolutionManifest = manager === 'npm'
      ? manifest
      : { name: manifest.name, version: manifest.version, private: manifest.private, dependencies: manifest.dependencies };
    const resolutionManifestText = `${JSON.stringify(resolutionManifest, null, 2)}\n`;
    const manifestPath = join(projectDirectory, 'package.json');
    yield* Effect.tryPromise({
      try: signal => writeFile(manifestPath, resolutionManifestText, { flag: 'wx', signal }),
      catch: cause => operationFailure(cause, `could not write package manifest: ${manifestPath}`),
    });
    const environment = toolEnvironment(workspace, target, config.upstreamRegistry, runtime);
    yield* ensureDirectory(environment.HOME);
    yield* ensureDirectory(environment.npm_config_cache);
    yield* ensureDirectory(environment.pnpm_config_store_dir);
    yield* Effect.tryPromise({
      try: signal => writeFile(environment.npm_config_userconfig, `registry=${config.upstreamRegistry}\naudit=false\nfund=false\nignore-scripts=true\n`, { signal }),
      catch: cause => operationFailure(cause, `could not write package manager configuration: ${environment.npm_config_userconfig}`),
    });
    const version = (yield* runProcess(manager, ['--version'], {
      cwd: projectDirectory,
      env: environment,
      timeoutMs: 30_000,
    })).stdout.trim().split(/\s+/)[0];
    if (version !== managerVersions[manager]) {
      yield* Effect.fail(new MynpmError('operation', `${manager} ${managerVersions[manager]} is required for add; found ${version || 'no version output'}`));
    }
    const args = manager === 'npm'
      ? ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...roots.map(root => `${root.name}@${root.version}`)]
      : ['install', '--lockfile-only', '--ignore-scripts', ...roots.map(root => `${root.name}@${root.version}`)];
    yield* runProcess(manager, args, {
      cwd: projectDirectory,
      env: environment,
      timeoutMs: operationTimeout,
    });
    const lockfileName = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
    const lockfilePath = join(projectDirectory, lockfileName);
    const lockText = yield* Effect.tryPromise({
      try: signal => readFile(lockfilePath, { encoding: 'utf8', signal }),
      catch: cause => new MynpmError('operation', `${manager} did not create ${lockfileName}`, { cause }),
    });
    const parseOptions = {
      projectId: `add-${manager}-${target.id}`,
      packageManagerPin,
      lockfilePath: `add/${manager}/${target.id}/${lockfileName}`,
      targetIds: [target.id],
      snapshot: {
        manifest: manifestText,
        lockfile: lockText,
        workspaceFiles: [],
        npmInstallOptions: { legacyPeerDeps: null, installLinks: null },
      },
    };
    const project = manager === 'npm'
      ? yield* Effect.try({
        try: () => parseNpmLock(parseJson(lockText), parseOptions),
        catch: cause => inputFailure(cause, `could not parse ${manager} lockfile`),
      })
      : yield* parsePnpmLock(lockText, parseOptions);
    yield* Effect.try({
      try: () => assertRestorableProjectSnapshot(manager, parseOptions.snapshot),
      catch: cause => inputFailure(cause, `generated ${manager} project is not restorable`),
    });
    return yield* Effect.try({
      try: () => validateResolvedProject(project, roots, target, manager),
      catch: cause => inputFailure(cause, 'resolved project did not match requested package pins'),
    });
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('input', 'npm produced an invalid package-lock.json', { cause });
  }
}

function verifyRootSelections(project: ProjectRecord, roots: readonly RootPin[], target: TargetConfig, manager: PackageManager): void {
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

function validateResolvedProject(project: ProjectRecord, roots: readonly RootPin[], target: TargetConfig, manager: PackageManager): ProjectRecord {
  verifyRootSelections(project, roots, target, manager);
  const unsupported = project.packages.find(pkg => pkg.sourceKind !== 'registry');
  if (unsupported) {
    throw new MynpmError('input', `add rejected ${unsupported.sourceKind} source ${unsupported.name}${unsupported.version ? `@${unsupported.version}` : ''}`);
  }
  return project;
}

export function addPackages({ manager, specs, requestedTargets, config, stateDirectory, cwd = process.cwd() }: AddPackagesOptions): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    const roots = yield* Effect.try({
      try: () => parseRootPins(specs),
      catch: cause => inputFailure(cause, 'add requires exact package pins'),
    });
    const targets = yield* Effect.try({
      try: () => targetsFor(config, requestedTargets),
      catch: cause => inputFailure(cause, 'requested targets are invalid'),
    });
    const runtime = {
      path: process.env.PATH ?? '',
      locale: process.env.LANG ?? 'C',
      temporaryDirectory: resolve(cwd, '.work', 'tmp'),
    };
    const scratchRoot = resolve(cwd, '.work', 'tmp');
    yield* ensureDirectory(scratchRoot);
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(scratchRoot, 'mynpm-add-')),
        catch: cause => operationFailure(cause, `could not create resolver workspace under ${scratchRoot}`),
      }),
      workspace => Effect.gen(function*() {
        const projects: ProjectRecord[] = [];
        for (const target of targets) {
          projects.push(yield* resolveTarget({ manager, roots, target, config, workspace, runtime }));
        }
        yield* updateInventory(stateDirectory, (inventory: Inventory) => projects.reduce((result, project) => mergeProject(result, project), inventory));
        yield* Effect.sync(() => {
          process.stdout.write(`Added ${roots.length} root pins for ${targets.map(target => target.id).join(', ')} with ${manager}@${managerVersions[manager]}.\n`);
        });
      }),
      workspace => Effect.tryPromise({
        try: () => rm(workspace, { recursive: true, force: true }),
        catch: cause => operationFailure(cause, `could not remove resolver workspace: ${workspace}`),
      }),
    );
  });
}

export { managerVersions };
