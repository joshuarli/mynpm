#!/usr/bin/env -S node --experimental-strip-types
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadConfig } from './config.ts';
import type { MynpmConfig } from './config.ts';
import { errorCode, MynpmError, exitCodeFor } from './errors.ts';
import type { Inventory, PackageManager, PackageRecord, PackageSourceKind, ProjectRecord, ProjectSnapshot } from './inventory.ts';
import { mergeProject } from './inventory.ts';
import { loadInventory, updateInventory } from './inventory-store.ts';
import { parseNpmLock } from './lock-npm.ts';
import { parsePnpmLock, pnpmBuildPackageKeys } from './lock-pnpm.ts';
import { addPackages } from './resolve.ts';
import { fetchInventory, verifyInventory, isRestrictedAddress } from './acquire.ts';
import { publishSite } from './publish.ts';
import { validateInventory } from './validate.ts';
import { isIP } from 'node:net';
import { captureProjectSnapshot } from './project-snapshot.ts';
import { Cause, Effect } from 'effect';

const commandNames = ['import-lock', 'add', 'plan', 'fetch', 'verify', 'publish', 'validate', 'doctor'] as const;
type Command = typeof commandNames[number];
type PackageManagerPin = { raw: string; manager: PackageManager; version: string };
type PackageIdentity = {
  name: string;
  version: string;
  sourceKinds: PackageSourceKind[];
  targets: string[];
};
type InventorySummary = {
  schemaVersion: 1;
  publicBaseUrl: string;
  targets: string[];
  projectCount: number;
  packageCount: number;
  packages: PackageIdentity[];
  blockedSources: PackageIdentity[];
};
type SourceFinding = {
  kind: 'local-source' | 'git-source' | 'unknown-source' | 'private-host' | 'credentialed-registry-source' | 'third-party-download';
  host: string;
};
type CommonArguments = { config?: string; statedir?: string };
type ParsedArguments =
  | (CommonArguments & { command: 'import-lock'; project: string; targets: string[]; positionals: [string] })
  | (CommonArguments & { command: 'add'; manager: PackageManager; targets: string[]; positionals: [string, ...string[]] })
  | (CommonArguments & { command: 'plan'; json: boolean; positionals: [] })
  | (CommonArguments & { command: 'fetch'; positionals: [] })
  | (CommonArguments & { command: 'verify'; positionals: [] })
  | (CommonArguments & { command: 'publish'; sitedir?: string; positionals: [] })
  | (CommonArguments & { command: 'validate'; client: PackageManager; positionals: [] })
  | (CommonArguments & { command: 'doctor'; positionals: [string] });
type RawArguments = {
  command?: Command;
  config?: string;
  statedir?: string;
  sitedir?: string;
  targets: string[];
  project?: string;
  manager?: string;
  client?: string;
  json: boolean;
  positionals: string[];
};

const commands = new Set<string>(commandNames);
const valueOptions = new Set(['--config', '--state-dir', '--site-dir', '--target', '--project', '--manager', '--client']);
const commandUsage = 'usage: mynpm [--config path] [--state-dir path] [--site-dir path] [--target id] command';
const packageManagerPinPattern = /^(npm|pnpm)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)(?:\+sha512\.[A-Za-z0-9+/=_-]+)?$/;

function isCommand(value: string): value is Command {
  return commands.has(value);
}

function isPackageManager(value: unknown): value is PackageManager {
  return value === 'npm' || value === 'pnpm';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function preserveMynpmError(cause: unknown): MynpmError {
  return cause instanceof MynpmError ? cause : new MynpmError('operation', 'unexpected command failure', { cause });
}

function trySync<Value>(run: () => Value): Effect.Effect<Value, MynpmError> {
  return Effect.try({ try: run, catch: preserveMynpmError });
}

function usage(message: string): never {
  throw new MynpmError('usage', `${message}\n${commandUsage}`);
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const options: RawArguments = { targets: [], json: false, positionals: [] };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (!options.command && isCommand(argument)) {
      options.command = argument;
      continue;
    }
    if (argument === '--json') {
      if (options.json) usage('--json may only be specified once');
      options.json = true;
      continue;
    }
    if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage(`${argument} requires a value`);
      index += 1;
      if (argument === '--target') {
        options.targets.push(value);
      } else {
        if (seen.has(argument)) usage(`${argument} may only be specified once`);
        seen.add(argument);
        switch (argument) {
          case '--config': options.config = value; break;
          case '--state-dir': options.statedir = value; break;
          case '--site-dir': options.sitedir = value; break;
          case '--project': options.project = value; break;
          case '--manager': options.manager = value; break;
          case '--client': options.client = value; break;
        }
      }
      continue;
    }
    if (argument.startsWith('-')) usage(`unknown option: ${argument}`);
    if (!options.command) usage(`unknown command: ${argument}`);
    options.positionals.push(argument);
  }
  const command = options.command;
  if (!command) usage('a command is required');
  if (options.json && command !== 'plan') usage('--json is only valid with plan');
  if (options.project !== undefined && command !== 'import-lock') usage('--project is only valid with import-lock');
  if (options.manager !== undefined && command !== 'add') usage('--manager is only valid with add');
  if (options.client !== undefined && command !== 'validate') usage('--client is only valid with validate');
  if (options.sitedir !== undefined && command !== 'publish') usage('--site-dir is only valid with publish');
  if (options.targets.length > 0 && command !== 'import-lock' && command !== 'add') usage('--target is only valid with import-lock or add');
  switch (command) {
    case 'import-lock': {
      if (options.positionals.length !== 1) usage('import-lock requires one lockfile path');
      if (!options.project) usage('import-lock requires --project');
      return { command, config: options.config, statedir: options.statedir, project: options.project, targets: options.targets, positionals: [options.positionals[0]] };
    }
    case 'add': {
      if (options.positionals.length === 0) usage('add requires at least one exact package pin');
      if (!isPackageManager(options.manager)) usage('add requires --manager npm or pnpm');
      const [first, ...rest] = options.positionals;
      if (first === undefined) usage('add requires at least one exact package pin');
      return { command, config: options.config, statedir: options.statedir, manager: options.manager, targets: options.targets, positionals: [first, ...rest] };
    }
    case 'plan':
      if (options.positionals.length !== 0) usage('plan does not take positional arguments');
      return { command, config: options.config, statedir: options.statedir, json: options.json, positionals: [] };
    case 'fetch':
    case 'verify':
    case 'validate':
    case 'publish':
      if (options.positionals.length !== 0) usage(`${command} does not take positional arguments`);
      if (command === 'validate') {
        if (!isPackageManager(options.client)) usage('validate requires --client npm or pnpm');
        return { command, config: options.config, statedir: options.statedir, client: options.client, positionals: [] };
      }
      if (command === 'publish') return { command, config: options.config, statedir: options.statedir, sitedir: options.sitedir, positionals: [] };
      return { command, config: options.config, statedir: options.statedir, positionals: [] };
    case 'doctor': {
      if (options.positionals.length !== 1) usage('doctor requires one project path');
      return { command, config: options.config, statedir: options.statedir, positionals: [options.positionals[0]] };
    }
  }
}

function currentTargetId(config: MynpmConfig): string {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const cpu = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  let libc: 'glibc' | 'musl' | null = null;
  if (os === 'linux') {
    const report = process.report?.getReport();
    const header = isRecord(report) && isRecord(report.header) ? report.header : null;
    libc = typeof header?.glibcVersionRuntime === 'string' ? 'glibc' : 'musl';
  }
  const target = config.targets.find(item => item.os === os && item.cpu === cpu && ('libc' in item ? item.libc : null) === libc);
  if (!target) throw new MynpmError('input', `the current platform is not configured as a target: ${os ?? process.platform}/${cpu ?? process.arch}/${libc ?? ''}`);
  return target.id;
}

function targetIdsFor(config: MynpmConfig, requestedTargets: readonly string[]): string[] {
  const targetIds = requestedTargets.length > 0 ? requestedTargets : [currentTargetId(config)];
  const available = new Set(config.targets.map(target => target.id));
  for (const targetId of targetIds) {
    if (!available.has(targetId)) throw new MynpmError('input', `target is not configured: ${targetId}`);
  }
  if (new Set(targetIds).size !== targetIds.length) throw new MynpmError('input', 'target IDs must be unique');
  return [...targetIds].sort();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function inventorySummary(config: MynpmConfig, inventory: Inventory): InventorySummary {
  const packages = packageIdentities(inventory);
  return {
    schemaVersion: 1,
    publicBaseUrl: config.publicBaseUrl,
    targets: config.targets.map(target => target.id).sort(),
    projectCount: inventory.projects.length,
    packageCount: packages.length,
    packages,
    blockedSources: packages.filter(item => item.sourceKinds.some(kind => !['registry', 'local'].includes(kind))),
  };
}

function printPlan(config: MynpmConfig, inventory: Inventory, json: boolean): void {
  const summary = inventorySummary(config, inventory);
  if (json) {
    process.stdout.write(`${JSON.stringify(stableValue(summary), null, 2)}\n`);
    return;
  }
  process.stdout.write(`Static registry: ${summary.publicBaseUrl}\n`);
  process.stdout.write(`Configured targets: ${summary.targets.join(', ')}\n`);
  process.stdout.write(`Imported projects: ${summary.projectCount}\n`);
  process.stdout.write(`Observed package versions: ${summary.packageCount}\n`);
  process.stdout.write(`Sources requiring review: ${summary.blockedSources.length}\n`);
}

function importLock(arguments_: Extract<ParsedArguments, { command: 'import-lock' }>, config: MynpmConfig, cwd: string): Effect.Effect<void, MynpmError> {
  return Effect.gen(function* () {
    const lockfilePath = resolve(cwd, arguments_.positionals[0]);
    const text = yield* Effect.tryPromise({
      try: signal => readFile(lockfilePath, { encoding: 'utf8', signal }),
      catch: cause => errorCode(cause) === 'ENOENT'
        ? new MynpmError('input', `lockfile does not exist: ${lockfilePath}`, { cause })
        : new MynpmError('operation', `could not read lockfile: ${lockfilePath}`, { cause }),
    });
    const packageManagerPin = yield* loadPackageManagerPin(dirname(lockfilePath));
    const lockManager = /\.ya?ml$/i.test(lockfilePath) ? 'pnpm' : 'npm';
    if (packageManagerPin && packageManagerPin.manager !== lockManager) {
      return yield* Effect.fail(new MynpmError('input', `packageManager pin ${packageManagerPin.raw} does not match ${lockManager} lockfile`));
    }
    const options = yield* trySync(() => ({
      projectId: arguments_.project,
      packageManagerPin: packageManagerPin?.raw ?? null,
      lockfilePath: relative(cwd, lockfilePath).split(sep).join('/'),
      targetIds: targetIdsFor(config, arguments_.targets),
    }));
    const parsedLock = lockManager === 'npm' ? yield* trySync(() => parseJsonLock(text, lockfilePath)) : null;
    const parseProject = (snapshot: ProjectSnapshot | null): Effect.Effect<ProjectRecord, MynpmError> => lockManager === 'pnpm'
      ? parsePnpmLock(text, { ...options, snapshot })
      : trySync(() => parseNpmLock(parsedLock, { ...options, snapshot }));
    const initialProject = yield* parseProject(null);
    const snapshot = yield* captureProjectSnapshot({
      manager: lockManager,
      projectDirectory: dirname(lockfilePath),
      lockfileText: text,
      lock: parsedLock,
      project: initialProject,
    });
    const project = yield* parseProject(snapshot);
    const stateDirectory = resolve(cwd, arguments_.statedir ?? 'state');
    yield* updateInventory(stateDirectory, (inventory: Inventory) => mergeProject(inventory, project));
    yield* Effect.sync(() => {
      process.stdout.write(`Imported ${project.packages.length} package entries for ${project.id} (${project.targets.join(', ')}).\n`);
      if (packageManagerPin) process.stdout.write(`Package manager pin: ${packageManagerPin.raw}\n`);
    });
  });
}

function parseJsonLock(text: string, lockfilePath: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('input', `npm lockfile is not valid JSON: ${lockfilePath}`, { cause });
  }
}

function loadPackageManagerPin(projectDirectory: string): Effect.Effect<PackageManagerPin | null, MynpmError> {
  return Effect.gen(function* () {
    const path = join(projectDirectory, 'package.json');
    const text = yield* Effect.tryPromise({
      try: signal => readFile(path, { encoding: 'utf8', signal }),
      catch: cause => new MynpmError('operation', `could not read package.json: ${projectDirectory}`, { cause }),
    }).pipe(Effect.catch(error => errorCode(error.cause) === 'ENOENT' ? Effect.succeed(null) : Effect.fail(error)));
    if (text === null) return null;
    return yield* trySync(() => {
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch (cause) {
        throw new MynpmError('input', `package.json is not valid JSON: ${projectDirectory}`, { cause });
      }
      if (!isRecord(manifest)) throw new MynpmError('input', `package.json must contain an object: ${projectDirectory}`);
      if (manifest.packageManager === undefined) return null;
      if (typeof manifest.packageManager !== 'string') throw new MynpmError('input', `packageManager pin is unsupported: ${projectDirectory}`);
      const match = packageManagerPinPattern.exec(manifest.packageManager);
      if (!match) throw new MynpmError('input', `packageManager pin is unsupported: ${projectDirectory}`);
      const manager = match[1];
      if (!isPackageManager(manager)) throw new MynpmError('input', `packageManager pin is unsupported: ${projectDirectory}`);
      return { raw: manifest.packageManager, manager, version: match[2] };
    });
  });
}

function optionalFileExists(filePath: string): Effect.Effect<boolean, MynpmError> {
  return Effect.tryPromise({
    try: () => stat(filePath).then(info => {
      if (!info.isFile()) throw new MynpmError('input', `project lockfile is not a regular file: ${filePath}`);
      return true;
    }),
    catch: cause => cause instanceof MynpmError
      ? cause
      : errorCode(cause) === 'ENOENT'
        ? new MynpmError('input', `missing lockfile: ${filePath}`, { cause })
        : new MynpmError('operation', `could not inspect project lockfile: ${filePath}`, { cause }),
  }).pipe(Effect.catch(error => errorCode(error.cause) === 'ENOENT' ? Effect.succeed(false) : Effect.fail(error)));
}

function packageIdentities(inventory: Inventory): PackageIdentity[] {
  const identities = new Map<string, { name: string; version: string; sourceKinds: Set<PackageSourceKind>; targets: Set<string> }>();
  for (const project of inventory.projects) {
    for (const item of project.packages) {
      if (item.version === null) continue;
      const key = `${item.name}@${item.version}`;
      const found = identities.get(key);
      if (found) {
        for (const target of item.targets) found.targets.add(target);
        found.sourceKinds.add(item.sourceKind);
      } else {
        identities.set(key, { name: item.name, version: item.version, sourceKinds: new Set([item.sourceKind]), targets: new Set(item.targets) });
      }
    }
  }
  return [...identities.values()].map(item => ({
    name: item.name,
    version: item.version,
    sourceKinds: [...item.sourceKinds].sort(),
    targets: [...item.targets].sort(),
  })).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function doctor(arguments_: Extract<ParsedArguments, { command: 'doctor' }>, config: MynpmConfig, cwd: string): Effect.Effect<void, MynpmError> {
  return Effect.gen(function* () {
  const projectPath = resolve(cwd, arguments_.positionals[0]);
  const packageManagerPin = yield* loadPackageManagerPin(projectPath);
  const npmLockPath = join(projectPath, 'package-lock.json');
  const pnpmLockPath = join(projectPath, 'pnpm-lock.yaml');
  const hasNpmLock = yield* optionalFileExists(npmLockPath);
  const hasPnpmLock = yield* optionalFileExists(pnpmLockPath);
  let manager = packageManagerPin?.manager;
  if (manager === undefined) {
    if (hasNpmLock === hasPnpmLock) {
      return yield* Effect.fail(new MynpmError('input', `project must contain exactly one npm or pnpm lockfile: ${projectPath}`));
    }
    manager = hasNpmLock ? 'npm' : 'pnpm';
  }
  const lockfilePath = manager === 'npm' ? npmLockPath : pnpmLockPath;
  if (!(manager === 'npm' ? hasNpmLock : hasPnpmLock)) {
    return yield* Effect.fail(new MynpmError('input', `project ${packageManagerPin?.raw ?? manager} does not have its matching lockfile: ${projectPath}`));
  }
  const text = yield* Effect.tryPromise({
    try: signal => readFile(lockfilePath, { encoding: 'utf8', signal }),
    catch: cause => new MynpmError('operation', `could not read project lockfile: ${lockfilePath}`, { cause }),
  });
  const parseOptions = {
    projectId: 'doctor',
    packageManagerPin: packageManagerPin?.raw ?? null,
    lockfilePath: manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml',
    targetIds: ['doctor'],
  };
  const npmLock = manager === 'npm' ? yield* trySync(() => parseJsonLock(text, lockfilePath)) : null;
  const project = manager === 'npm'
    ? yield* trySync(() => parseNpmLock(npmLock, parseOptions))
    : yield* parsePnpmLock(text, parseOptions);
  const scriptKeys = manager === 'npm'
    ? project.packages.filter(item => npmLockPackageHasInstallScript(npmLock, item.key)).map(item => item.key)
    : yield* pnpmBuildPackageKeys(text);
  const scriptKeySet = new Set(scriptKeys);
  const sourceFindings: { item: PackageRecord; finding: SourceFinding }[] = [];
  for (const item of project.packages) {
    const finding = sourceFinding(item);
    if (finding !== null) sourceFindings.push({ item, finding });
  }
  const rootManifest = yield* loadProjectManifest(projectPath);
  const scripts = isRecord(rootManifest.scripts) ? rootManifest.scripts : {};
  const lifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepare'].filter(name => typeof scripts[name] === 'string');
  const installScriptPackages = project.packages.filter(item => scriptKeySet.has(item.key));
  const downloadRisks = project.packages.map(item => ({ item, risks: packageDownloadRisks(item.name) })).filter(entry => entry.risks.length > 0);
  process.stdout.write(`Project: ${projectPath}\n`);
  if (packageManagerPin) process.stdout.write(`Package manager pin: ${packageManagerPin.raw}\n`);
  if (sourceFindings.length === 0) {
    process.stdout.write('No lockfile sources require migration review.\n');
  } else {
    process.stdout.write(`Lockfile sources requiring migration review: ${sourceFindings.length}\n`);
    for (const { item, finding } of sourceFindings) {
      process.stdout.write(`- ${finding.kind}: ${item.name}${item.version ? `@${item.version}` : ''} (${finding.host ?? item.sourceKind})\n`);
    }
  }
  process.stdout.write(`Root lifecycle scripts: ${lifecycleScripts.length === 0 ? 'none' : lifecycleScripts.join(', ')}\n`);
  process.stdout.write(`Dependency install/build hooks in lockfile: ${installScriptPackages.length}\n`);
  for (const item of installScriptPackages) process.stdout.write(`- install/build hook: ${item.name}${item.version ? `@${item.version}` : ''}\n`);
  process.stdout.write(`Known browser/native download risks: ${downloadRisks.length}\n`);
  for (const { item, risks } of downloadRisks) process.stdout.write(`- ${item.name}${item.version ? `@${item.version}` : ''}: ${risks.join(', ')}\n`);
  const registry = new URL('current/', config.publicBaseUrl).href;
  const command = manager === 'npm'
    ? `npm install --package-lock-only --ignore-scripts --no-audit --registry=${registry} --omit-lockfile-registry-resolved`
    : `pnpm install --lockfile-only --ignore-scripts --registry=${registry}`;
  process.stdout.write(`To review migration safely, copy the project under .work and run ${packageManagerPin?.raw ?? manager} in that copy:\n${command}\n`);
  if (manager === 'npm') {
    process.stdout.write('npm replace-registry-host defaults to npmjs hosts; it does not rewrite private or third-party hosts. omit-lockfile-registry-resolved removes registry resolved URLs but does not prove the selected graph stayed exact.\n');
  } else {
    process.stdout.write('pnpm may retain explicit resolution.tarball URLs from the lockfile; inspect every rewritten source and compare the selected package/version/integrity set.\n');
  }
  yield* Effect.sync(() => process.stdout.write('Compare exact package/version/integrity selections and run a fresh-cache install before considering any change to the original project.\n'));
  });
}

function loadProjectManifest(projectPath: string): Effect.Effect<Record<string, unknown>, MynpmError> {
  return Effect.gen(function* () {
    const path = join(projectPath, 'package.json');
    const text = yield* Effect.tryPromise({
      try: signal => readFile(path, { encoding: 'utf8', signal }),
      catch: cause => new MynpmError('operation', `could not read package.json: ${projectPath}`, { cause }),
    }).pipe(Effect.catch(error => errorCode(error.cause) === 'ENOENT' ? Effect.succeed('{}') : Effect.fail(error)));
    return yield* trySync(() => {
      try {
        const manifest: unknown = JSON.parse(text);
        if (!isRecord(manifest)) throw new TypeError('manifest is not an object');
        return manifest;
      } catch (cause) {
        throw new MynpmError('input', `package.json is not valid JSON: ${projectPath}`, { cause });
      }
    });
  });
}

function npmLockPackageHasInstallScript(lock: unknown, packageKey: string): boolean {
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    throw new MynpmError('input', 'npm lockfile packages must be an object');
  }
  const packageRecord = lock.packages[packageKey];
  if (!isRecord(packageRecord)) throw new MynpmError('input', `npm lockfile package entry is malformed: ${packageKey}`);
  return packageRecord.hasInstallScript === true;
}

function sourceFinding(item: PackageRecord): SourceFinding | null {
  if (item.sourceKind === 'registry') return null;
  if (item.sourceKind === 'local') return { kind: 'local-source', host: 'project path' };
  if (item.sourceKind === 'git') return { kind: 'git-source', host: 'git URL' };
  if (item.sourceKind === 'unknown') return { kind: 'unknown-source', host: 'no resolved URL' };
  let host = 'invalid URL';
  if (item.resolved !== null) {
    try {
      host = new URL(item.resolved).hostname.toLowerCase().replace(/\.$/, '');
    } catch {}
  }
  const family = isIP(host);
  const privateHost = family !== 0
    ? isRestrictedAddress(host, family)
    : ['localhost', 'local', 'internal', 'lan'].some(suffix => host === suffix || host.endsWith(`.${suffix}`)) || !host.includes('.');
  if (privateHost) return { kind: 'private-host', host };
  if (host === 'registry.npmjs.org') return { kind: 'credentialed-registry-source', host };
  return { kind: 'third-party-download', host };
}

function packageDownloadRisks(name: string): string[] {
  const risks: string[] = [];
  if (name === 'electron' || name === '@electron/get') risks.push('browser or runtime download');
  if (/^(?:playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core|cypress)$/.test(name)) risks.push('browser download');
  if (/^(?:prisma|@prisma\/(?:client|engines))$/.test(name)) risks.push('native engine download');
  if (/^(?:node-gyp|node-pre-gyp|@mapbox\/node-pre-gyp)$/.test(name)) risks.push('native build or Node.js header download');
  if (/^(?:esbuild|@esbuild\/.+|@swc\/.+|sharp|@img\/sharp-.+|@next\/swc-.+|@napi-rs\/.+|@parcel\/watcher)$/.test(name)) risks.push('native binary or build');
  return risks;
}

function execute(argv: readonly string[]): Effect.Effect<void, MynpmError> {
  return Effect.gen(function* () {
    const parsed = yield* trySync(() => parseArguments(argv));
    const cwd = process.cwd();
    const configPath = resolve(cwd, parsed.config ?? 'mynpm.json');
    const config = yield* loadConfig(configPath);
    const stateDirectory = resolve(cwd, parsed.statedir ?? 'state');
    if (parsed.command === 'plan') {
      const inventory = yield* loadInventory(stateDirectory);
      yield* Effect.sync(() => printPlan(config, inventory, parsed.json === true));
      return;
    }
    if (parsed.command === 'import-lock') {
      yield* importLock(parsed, config, cwd);
      return;
    }
    if (parsed.command === 'doctor') {
      yield* doctor(parsed, config, cwd);
      return;
    }
    if (parsed.command === 'add') {
      yield* addPackages({
        manager: parsed.manager,
        specs: parsed.positionals,
        requestedTargets: parsed.targets,
        config,
        stateDirectory,
        cwd,
      });
      return;
    }
    if (parsed.command === 'fetch') {
      const result = yield* fetchInventory({ stateDirectory, config });
      yield* Effect.sync(() => process.stdout.write(`Verified ${result.verifiedCount} package artifacts; downloaded ${result.downloadedBytes} bytes, reused ${result.reusedCount}.\n`));
      return;
    }
    if (parsed.command === 'verify') {
      const result = yield* verifyInventory({ stateDirectory, config });
      yield* Effect.sync(() => process.stdout.write(`Verified ${result.verifiedCount} package artifacts.\n`));
      return;
    }
    if (parsed.command === 'publish') {
      const siteDirectory = resolve(cwd, parsed.sitedir ?? '.work/site');
      const result = yield* publishSite({ stateDirectory, siteDirectory, config });
      yield* Effect.sync(() => process.stdout.write(`${result.noOp ? 'Already published' : 'Published'} generation ${result.generationId} (${result.packageCount} packages, ${result.versionCount} versions).\n`));
      return;
    }
    if (parsed.command === 'validate') {
      const result = yield* validateInventory({ client: parsed.client, stateDirectory, config, cwd });
      yield* Effect.sync(() => {
        process.stdout.write(`Restored ${result.client}@${result.version} on Node ${result.nodeVersion} for ${result.target}: ${result.packageCount} package selections across ${result.projectCount} projects and ${result.requestCount} local HTTP requests.\n`);
        for (const executable of result.executables) process.stdout.write(`Executed ${executable.name}: ${executable.output}\n`);
      });
      return;
    }
  });
}

const shutdown = new AbortController();
const abort = () => shutdown.abort(new MynpmError('cancelled', 'command was cancelled'));
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
try {
  await Effect.runPromise(execute(process.argv.slice(2)).pipe(
    Effect.catchCause(cause => Effect.sync(() => {
      const error = Cause.hasInterruptsOnly(cause)
        ? new MynpmError('cancelled', 'command was cancelled')
        : Cause.squash(cause);
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`mynpm: ${message}\n`);
      process.exitCode = exitCodeFor(error);
    })),
  ), { signal: shutdown.signal });
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
