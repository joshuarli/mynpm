#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadConfig } from './config.mjs';
import { MynpmError, exitCodeFor } from './errors.mjs';
import { createEmptyInventory, mergeProject } from './inventory.mjs';
import { loadInventory, updateInventory } from './inventory-store.mjs';
import { parseNpmLock } from './lock-npm.mjs';
import { parsePnpmLock } from './lock-pnpm.mjs';
import { addPackages } from './resolve.mjs';
import { fetchInventory, verifyInventory, isRestrictedAddress } from './acquire.mjs';
import { publishSite } from './publish.mjs';
import { validateInventory } from './validate.mjs';
import { isIP } from 'node:net';
import { pnpmBuildPackageKeys } from './lock-pnpm.mjs';

const commands = new Set(['import-lock', 'add', 'plan', 'fetch', 'verify', 'publish', 'validate', 'doctor']);
const valueOptions = new Set(['--config', '--state-dir', '--site-dir', '--target', '--project', '--manager', '--client']);
const commandUsage = 'usage: mynpm [--config path] [--state-dir path] [--site-dir path] [--target id] command';
const packageManagerPinPattern = /^(npm|pnpm)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)(?:\+sha512\.[A-Za-z0-9+/=_-]+)?$/;

function usage(message) {
  throw new MynpmError('usage', `${message}\n${commandUsage}`);
}

function parseArguments(argv) {
  let command;
  const options = { targets: [], positionals: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!command && commands.has(argument)) {
      command = argument;
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
        options[argument.slice(2).replaceAll('-', '')] = value;
      }
      continue;
    }
    if (argument.startsWith('-')) usage(`unknown option: ${argument}`);
    if (!command) usage(`unknown command: ${argument}`);
    options.positionals.push(argument);
  }
  if (!command) usage('a command is required');
  if (options.json && command !== 'plan') usage('--json is only valid with plan');
  if (options.project && command !== 'import-lock') usage('--project is only valid with import-lock');
  if (options.manager && command !== 'add') usage('--manager is only valid with add');
  if (options.client && command !== 'validate') usage('--client is only valid with validate');
  if (options.sitedir && command !== 'publish') usage('--site-dir is only valid with publish');
  if (command === 'plan' && options.positionals.length !== 0) usage('plan does not take positional arguments');
  if (command === 'import-lock' && options.positionals.length !== 1) usage('import-lock requires one lockfile path');
  if (command === 'import-lock' && !options.project) usage('import-lock requires --project');
  if (command === 'add' && options.positionals.length === 0) usage('add requires at least one exact package pin');
  if (command === 'add' && !['npm', 'pnpm'].includes(options.manager)) usage('add requires --manager npm or pnpm');
  if (command === 'doctor' && options.positionals.length !== 1) usage('doctor requires one project path');
  if (command === 'validate' && !['npm', 'pnpm'].includes(options.client)) usage('validate requires --client npm or pnpm');
  if (['fetch', 'verify', 'publish', 'validate'].includes(command) && options.positionals.length !== 0) usage(`${command} does not take positional arguments`);
  if (options.targets.length > 0 && !['import-lock', 'add'].includes(command)) usage('--target is only valid with import-lock or add');
  return { command, ...options };
}

function currentTargetId(config) {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const cpu = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  let libc = null;
  if (os === 'linux') {
    const report = process.report?.getReport();
    libc = report?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
  }
  const target = config.targets.find(item => item.os === os && item.cpu === cpu && (item.libc ?? null) === libc);
  if (!target) throw new MynpmError('input', `the current platform is not configured as a target: ${os ?? process.platform}/${cpu ?? process.arch}/${libc ?? ''}`);
  return target.id;
}

function targetIdsFor(config, requestedTargets) {
  const targetIds = requestedTargets.length > 0 ? requestedTargets : [currentTargetId(config)];
  const available = new Set(config.targets.map(target => target.id));
  for (const targetId of targetIds) {
    if (!available.has(targetId)) throw new MynpmError('input', `target is not configured: ${targetId}`);
  }
  if (new Set(targetIds).size !== targetIds.length) throw new MynpmError('input', 'target IDs must be unique');
  return [...targetIds].sort();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function inventorySummary(config, inventory) {
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

function printPlan(config, inventory, json) {
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

async function importLock(arguments_, config, cwd) {
  const lockfilePath = resolve(cwd, arguments_.positionals[0]);
  let text;
  try {
    text = await readFile(lockfilePath, 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new MynpmError('input', `lockfile does not exist: ${lockfilePath}`, { cause });
    throw new MynpmError('operation', `could not read lockfile: ${lockfilePath}`, { cause });
  }
  const packageManagerPin = await loadPackageManagerPin(dirname(lockfilePath));
  const lockManager = /\.ya?ml$/i.test(lockfilePath) ? 'pnpm' : 'npm';
  if (packageManagerPin && packageManagerPin.manager !== lockManager) {
    throw new MynpmError('input', `packageManager pin ${packageManagerPin.raw} does not match ${lockManager} lockfile`);
  }
  const project = /\.ya?ml$/i.test(lockfilePath)
    ? await parsePnpmLock(text, {
      projectId: arguments_.project,
      packageManagerPin: packageManagerPin?.raw ?? null,
      lockfilePath: relative(cwd, lockfilePath).split(sep).join('/'),
      targetIds: targetIdsFor(config, arguments_.targets),
    })
    : parseNpmLock(parseJsonLock(text, lockfilePath), {
      projectId: arguments_.project,
      packageManagerPin: packageManagerPin?.raw ?? null,
      lockfilePath: relative(cwd, lockfilePath).split(sep).join('/'),
      targetIds: targetIdsFor(config, arguments_.targets),
    });
  const stateDirectory = resolve(cwd, arguments_.statedir ?? 'state');
  await updateInventory(stateDirectory, inventory => mergeProject(inventory, project));
  process.stdout.write(`Imported ${project.packages.length} package entries for ${project.id} (${project.targets.join(', ')}).\n`);
  if (packageManagerPin) process.stdout.write(`Package manager pin: ${packageManagerPin.raw}\n`);
}

function parseJsonLock(text, lockfilePath) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('input', `npm lockfile is not valid JSON: ${lockfilePath}`, { cause });
  }
}

async function loadPackageManagerPin(projectDirectory) {
  let text;
  try {
    text = await readFile(join(projectDirectory, 'package.json'), 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw new MynpmError('operation', `could not read package.json: ${projectDirectory}`, { cause });
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('input', `package.json is not valid JSON: ${projectDirectory}`, { cause });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new MynpmError('input', `package.json must contain an object: ${projectDirectory}`);
  }
  if (manifest.packageManager === undefined) return null;
  if (typeof manifest.packageManager !== 'string') {
    throw new MynpmError('input', `packageManager pin is unsupported: ${projectDirectory}`);
  }
  const match = packageManagerPinPattern.exec(manifest.packageManager);
  if (!match) throw new MynpmError('input', `packageManager pin is unsupported: ${projectDirectory}`);
  return { raw: manifest.packageManager, manager: match[1], version: match[2] };
}

async function optionalFileExists(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new MynpmError('input', `project lockfile is not a regular file: ${filePath}`);
    return true;
  } catch (cause) {
    if (cause.code === 'ENOENT') return false;
    throw new MynpmError('operation', `could not inspect project lockfile: ${filePath}`, { cause });
  }
}

function packageIdentities(inventory) {
  const identities = new Map();
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

async function doctor(arguments_, config, cwd) {
  const projectPath = resolve(cwd, arguments_.positionals[0]);
  const packageManagerPin = await loadPackageManagerPin(projectPath);
  const npmLockPath = join(projectPath, 'package-lock.json');
  const pnpmLockPath = join(projectPath, 'pnpm-lock.yaml');
  const hasNpmLock = await optionalFileExists(npmLockPath);
  const hasPnpmLock = await optionalFileExists(pnpmLockPath);
  let manager = packageManagerPin?.manager;
  if (manager === undefined) {
    if (hasNpmLock === hasPnpmLock) {
      throw new MynpmError('input', `project must contain exactly one npm or pnpm lockfile: ${projectPath}`);
    }
    manager = hasNpmLock ? 'npm' : 'pnpm';
  }
  const lockfilePath = manager === 'npm' ? npmLockPath : pnpmLockPath;
  if (!(manager === 'npm' ? hasNpmLock : hasPnpmLock)) {
    throw new MynpmError('input', `project ${packageManagerPin.raw} does not have its matching lockfile: ${projectPath}`);
  }
  let text;
  try {
    text = await readFile(lockfilePath, 'utf8');
  } catch (cause) {
    throw new MynpmError('operation', `could not read project lockfile: ${lockfilePath}`, { cause });
  }
  const parseOptions = {
    projectId: 'doctor',
    packageManagerPin: packageManagerPin?.raw ?? null,
    lockfilePath: manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml',
    targetIds: ['doctor'],
  };
  let npmLock;
  if (manager === 'npm') npmLock = parseJsonLock(text, lockfilePath);
  const project = manager === 'npm'
    ? parseNpmLock(npmLock, parseOptions)
    : await parsePnpmLock(text, parseOptions);
  const scriptKeys = manager === 'npm'
    ? project.packages.filter(item => npmLock.packages[item.key]?.hasInstallScript === true).map(item => item.key)
    : await pnpmBuildPackageKeys(text);
  const scriptKeySet = new Set(scriptKeys);
  const sourceFindings = project.packages.map(item => ({ item, finding: sourceFinding(item) })).filter(entry => entry.finding !== null);
  const rootManifest = await loadProjectManifest(projectPath);
  const lifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepare'].filter(name => typeof rootManifest.scripts?.[name] === 'string');
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
  process.stdout.write('Compare exact package/version/integrity selections and run a fresh-cache install before considering any change to the original project.\n');
}

async function loadProjectManifest(projectPath) {
  let text;
  try {
    text = await readFile(join(projectPath, 'package.json'), 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') return {};
    throw new MynpmError('operation', `could not read package.json: ${projectPath}`, { cause });
  }
  try {
    const manifest = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new TypeError('manifest is not an object');
    return manifest;
  } catch (cause) {
    throw new MynpmError('input', `package.json is not valid JSON: ${projectPath}`, { cause });
  }
}

function sourceFinding(item) {
  if (item.sourceKind === 'registry') return null;
  if (item.sourceKind === 'local') return { kind: 'local-source', host: 'project path' };
  if (item.sourceKind === 'git') return { kind: 'git-source', host: 'git URL' };
  if (item.sourceKind === 'unknown') return { kind: 'unknown-source', host: 'no resolved URL' };
  let host = 'invalid URL';
  try {
    host = new URL(item.resolved).hostname.toLowerCase().replace(/\.$/, '');
  } catch {}
  const family = isIP(host);
  const privateHost = family !== 0
    ? isRestrictedAddress(host, family)
    : ['localhost', 'local', 'internal', 'lan'].some(suffix => host === suffix || host.endsWith(`.${suffix}`)) || !host.includes('.');
  if (privateHost) return { kind: 'private-host', host };
  if (host === 'registry.npmjs.org') return { kind: 'credentialed-registry-source', host };
  return { kind: 'third-party-download', host };
}

function packageDownloadRisks(name) {
  const risks = [];
  if (name === 'electron' || name === '@electron/get') risks.push('browser or runtime download');
  if (/^(?:playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core|cypress)$/.test(name)) risks.push('browser download');
  if (/^(?:prisma|@prisma\/(?:client|engines))$/.test(name)) risks.push('native engine download');
  if (/^(?:node-gyp|node-pre-gyp|@mapbox\/node-pre-gyp)$/.test(name)) risks.push('native build or Node.js header download');
  if (/^(?:esbuild|@esbuild\/.+|@swc\/.+|sharp|@img\/sharp-.+|@next\/swc-.+|@napi-rs\/.+|@parcel\/watcher)$/.test(name)) risks.push('native binary or build');
  return risks;
}

async function execute(argv, signal) {
  const parsed = parseArguments(argv);
  const cwd = process.cwd();
  const configPath = resolve(cwd, parsed.config ?? 'mynpm.json');
  const config = await loadConfig(configPath);
  const stateDirectory = resolve(cwd, parsed.statedir ?? 'state');
  if (parsed.command === 'plan') {
    const inventory = await loadInventory(stateDirectory);
    printPlan(config, inventory, parsed.json === true);
    return;
  }
  if (parsed.command === 'import-lock') {
    await importLock(parsed, config, cwd);
    return;
  }
  if (parsed.command === 'doctor') {
    await doctor(parsed, config, cwd);
    return;
  }
  if (parsed.command === 'add') {
    await addPackages({
      manager: parsed.manager,
      specs: parsed.positionals,
      requestedTargets: parsed.targets,
      config,
      stateDirectory,
      cwd,
      signal,
    });
    return;
  }
  if (parsed.command === 'fetch') {
    const result = await fetchInventory({ stateDirectory, config, signal });
    process.stdout.write(`Verified ${result.verifiedCount} package artifacts; downloaded ${result.downloadedBytes} bytes, reused ${result.reusedCount}.\n`);
    return;
  }
  if (parsed.command === 'verify') {
    const result = await verifyInventory({ stateDirectory, config });
    process.stdout.write(`Verified ${result.verifiedCount} package artifacts.\n`);
    return;
  }
  if (parsed.command === 'publish') {
    const siteDirectory = resolve(cwd, parsed.sitedir ?? '.work/site');
    const result = await publishSite({ stateDirectory, siteDirectory, config });
    process.stdout.write(`${result.noOp ? 'Already published' : 'Published'} generation ${result.generationId} (${result.packageCount} packages, ${result.versionCount} versions).\n`);
    return;
  }
  if (parsed.command === 'validate') {
    const result = await validateInventory({ client: parsed.client, stateDirectory, config, signal, cwd });
    process.stdout.write(`Validated ${result.client}@${result.version} on Node ${result.nodeVersion} for ${result.target}: ${result.packageCount} package selections across ${result.projectCount} roots and ${result.requestCount} local HTTP requests.\n`);
    for (const executable of result.executables) process.stdout.write(`Executed ${executable.name}: ${executable.output}\n`);
    return;
  }
  throw new MynpmError('operation', `${parsed.command} is not available in the current implementation checkpoint`);
}

const shutdown = new AbortController();
const abort = () => shutdown.abort(new MynpmError('cancelled', 'command was cancelled'));
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
try {
  await execute(process.argv.slice(2), shutdown.signal);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mynpm: ${message}\n`);
  process.exitCode = exitCodeFor(error);
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
