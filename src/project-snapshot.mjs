import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { MynpmError } from './errors.mjs';

function safeProjectPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')) {
    throw new MynpmError('input', `${label} is not a safe project-relative path`);
  }
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new MynpmError('input', `${label} is not a safe project-relative path`);
  }
  return segments;
}

async function readProjectFile(projectRoot, relativePath, { optional = false } = {}) {
  const segments = safeProjectPath(relativePath, 'project snapshot path');
  let directory = projectRoot;
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    const info = await lstat(directory).catch(cause => {
      if (optional && cause.code === 'ENOENT') return null;
      throw new MynpmError('input', `could not inspect project snapshot path ${relativePath}`, { cause });
    });
    if (info === null) return null;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new MynpmError('input', `project snapshot path is not a regular directory: ${relativePath}`);
    }
  }
  const filePath = join(directory, segments.at(-1));
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new MynpmError('input', `project snapshot path is not a regular file: ${relativePath}`);
    return await handle.readFile('utf8');
  } catch (cause) {
    if (optional && cause.code === 'ENOENT') return null;
    if (cause instanceof MynpmError) throw cause;
    throw new MynpmError('input', `could not read project snapshot path ${relativePath}`, { cause });
  } finally {
    await handle?.close();
  }
}

function sanitizedLockfileText(text, manager) {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, value => {
    try {
      const url = new URL(value);
      const hasCredentials = url.username !== '' || url.password !== '' || url.search !== '';
      url.username = '';
      url.password = '';
      url.search = '';
      if (manager === 'pnpm' || hasCredentials) url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  });
}

function npmWorkspacePaths(lock) {
  const paths = new Set();
  for (const entry of Object.values(lock.packages ?? {})) {
    if (entry?.link !== true || typeof entry.resolved !== 'string') continue;
    const target = entry.resolved.replace(/^file:/, '').replace(/^\.\//, '');
    if (target.startsWith('/') || target.includes('\\') || target.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) continue;
    paths.add(target);
  }
  return paths;
}

export async function captureProjectSnapshot({ manager, projectDirectory, lockfileText, lock, project }) {
  let projectRoot;
  try {
    projectRoot = await realpath(projectDirectory);
  } catch (cause) {
    throw new MynpmError('input', `could not resolve project directory ${projectDirectory}`, { cause });
  }
  const manifest = await readProjectFile(projectRoot, 'package.json', { optional: true });
  const workspacePaths = manager === 'pnpm'
    ? new Set(project.importers.filter(importer => importer !== '.'))
    : npmWorkspacePaths(lock);
  const workspaceFiles = [];
  for (const workspacePath of [...workspacePaths].sort()) {
    const relativePath = `${workspacePath}/package.json`;
    const contents = await readProjectFile(projectRoot, relativePath, { optional: true });
    if (contents !== null) workspaceFiles.push({ path: relativePath, contents });
  }
  if (manager === 'pnpm') {
    const contents = await readProjectFile(projectRoot, 'pnpm-workspace.yaml', { optional: true });
    if (contents !== null) workspaceFiles.push({ path: 'pnpm-workspace.yaml', contents });
  }
  return {
    manifest,
    lockfile: sanitizedLockfileText(lockfileText, manager),
    workspaceFiles,
  };
}
