import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWithin } from '../index.js';
import { parseZip } from './zip.js';
import type { ZipEntry } from './zip.js';

export const DEFAULT_UPDATE_REPO = 'Berber86/harness';
const ALLOWED_HOSTS = ['github.com', 'codeload.github.com', 'githubusercontent.com', 'api.github.com'];
const PROTECTED_PREFIXES = ['.git/', '.harness/', 'workspace/', 'node_modules/'];
const PROTECTED_FILES = new Set(['.env', 'config.local.json']);
const BACKUPS_KEEP = 3;
const MAX_ZIP_BYTES = 60 * 1024 * 1024;

export interface ParsedGitHubSource {
  owner: string;
  repo: string;
  branch: string | null;
  kind: 'repo' | 'branch' | 'zip';
  url: string;
}

export interface UpdateState {
  source: string;
  owner?: string;
  repo?: string;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  commitDate?: string;
  updatedAt?: string;
  filesWritten?: number;
}

export interface UpdateBackupInfo {
  id: string;
  path: string;
  createdAt: string;
  commitSha: string;
  filesCount: number;
  files: string[];
  newFiles: string[];
}

export interface UpdateCheckResult {
  source: string;
  owner: string;
  repo: string;
  branch: string;
  localSha: string | null;
  remoteSha: string | null;
  remoteMessage: string;
  remoteDate: string;
  hasUpdate: boolean;
}

export interface ApplyUpdateResult {
  zipUrl: string;
  source: string;
  branch: string | null;
  commitSha: string | null;
  filesWritten: number;
  skippedProtected: string[];
  packageJsonChanged: boolean;
  backupId: string;
}

export interface RollbackUpdateResult {
  backupId: string;
  commitSha: string;
  filesRestored: number;
  filesRemoved: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function parseGitHubSource(source: string): ParsedGitHubSource {
  let text = String(source || '').trim();
  if (!text) {
    throw new Error('Укажи ссылку на GitHub (репозиторий, ветку или .zip архив).');
  }

  // Support shorthand owner/repo like "Berber86/harness".
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    const [owner, rawRepo] = text.split('/');
    const repo = rawRepo!.endsWith('.git') ? rawRepo!.slice(0, -4) : rawRepo!;
    return {
      owner: owner!,
      repo,
      branch: null,
      kind: 'repo',
      url: `https://github.com/${owner}/${repo}`,
    };
  }

  if (!/^https?:\/\//i.test(text)) {
    text = `https://${text}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('Некорректная ссылка на GitHub.');
  }

  if (!isAllowedHost(parsed.hostname)) {
    throw new Error('Разрешены только ссылки на github.com (репозиторий, ветка или .zip).');
  }

  const cleanPath = parsed.pathname;
  if (cleanPath.toLowerCase().endsWith('.zip') || parsed.hostname.toLowerCase() === 'codeload.github.com') {
    const parts = cleanPath.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    return {
      owner: parts[0] ?? '',
      repo: parts[1] ?? '',
      branch: branchFromZipUrl(text),
      kind: 'zip',
      url: text,
    };
  }

  const parts = cleanPath.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('Ссылка должна указывать на репозиторий вида github.com/owner/repo.');
  }
  const owner = parts[0]!;
  const repo = parts[1]!.endsWith('.git') ? parts[1]!.slice(0, -4) : parts[1]!;

  let branch: string | null = null;
  if (parts.length >= 4 && parts[2] === 'tree') {
    branch = decodeURIComponent(parts.slice(3).join('/'));
  } else if (parts.length >= 5 && parts[2] === 'archive' && parts[3] === 'refs' && parts[4] === 'heads') {
    branch = decodeURIComponent(parts.slice(5).join('/'));
  } else if (parts.length >= 3 && parts[2] === 'archive') {
    branch = decodeURIComponent(parts.slice(3).join('/'));
  }

  branch = branch?.replace(/^\/+|\/+$/g, '') || null;
  return {
    owner,
    repo,
    branch,
    kind: branch ? 'branch' : 'repo',
    url: text,
  };
}

export function branchFromZipUrl(url: string): string | null {
  for (const marker of ['/zip/refs/heads/', '/archive/refs/heads/', '/zip/', '/archive/']) {
    const idx = url.indexOf(marker);
    if (idx < 0) continue;
    let tail = url.slice(idx + marker.length).split('?')[0]!.split('#')[0]!;
    if (tail.toLowerCase().endsWith('.zip')) tail = tail.slice(0, -4);
    tail = decodeURIComponent(tail.replace(/^\/+|\/+$/g, ''));
    if (tail) return tail;
  }
  return null;
}

export function codeloadZipUrl(owner: string, repo: string, branch: string): string {
  const encodedBranch = branch.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/refs/heads/${encodedBranch}`;
}

export function isProtectedPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.includes('\0')) return true;
  if (PROTECTED_FILES.has(norm)) return true;
  return PROTECTED_PREFIXES.some((prefix) => norm === prefix.slice(0, -1) || norm.startsWith(prefix));
}

function stateFilePath(appDir: string): string {
  return path.join(appDir, '.harness', 'update-state.json');
}

function backupsRootDir(appDir: string): string {
  return path.join(appDir, '.harness', 'update-backups');
}

export async function readUpdateState(appDir: string): Promise<UpdateState | null> {
  try {
    const raw = await readFile(stateFilePath(appDir), 'utf8');
    return JSON.parse(raw) as UpdateState;
  } catch {
    return null;
  }
}

async function writeUpdateState(appDir: string, state: UpdateState): Promise<void> {
  const target = stateFilePath(appDir);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(state, null, 2), 'utf8');
}

export async function detectLocalGitInfo(appDir: string): Promise<{ branch: string | null; sha: string | null }> {
  try {
    const head = (await readFile(path.join(appDir, '.git', 'HEAD'), 'utf8')).trim();
    if (head.startsWith('ref: ')) {
      const refPath = head.slice(5).trim();
      const branch = refPath.startsWith('refs/heads/') ? refPath.slice('refs/heads/'.length) : refPath;
      let sha: string | null = null;
      try {
        sha = (await readFile(path.join(appDir, '.git', refPath), 'utf8')).trim();
      } catch {
        // Might be in packed-refs; ignore cleanly.
      }
      return { branch, sha };
    }
    return { branch: null, sha: head || null };
  } catch {
    return { branch: null, sha: null };
  }
}

export async function getDefaultUpdateSource(appDir: string): Promise<string> {
  const saved = await readUpdateState(appDir);
  if (saved?.source) return saved.source;
  const git = await detectLocalGitInfo(appDir);
  if (git.branch) {
    return `https://github.com/${DEFAULT_UPDATE_REPO}/tree/${git.branch}`;
  }
  return `https://github.com/${DEFAULT_UPDATE_REPO}`;
}

async function fetchGitHubJson<T>(url: string, fetchFn: FetchLike): Promise<T> {
  const response = await fetchFn(url, {
    headers: {
      'user-agent': 'MyAssistant-Updater/1.0',
      accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) {
    throw new Error(`На GitHub не найдено (404): ${url}`);
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error('Превышен лимит запросов к GitHub без авторизации. Попробуй через пару минут.');
  }
  if (!response.ok) {
    throw new Error(`GitHub ответил ошибкой ${response.status}`);
  }
  return (await response.json()) as T;
}

async function resolveBranch(parsed: ParsedGitHubSource, fetchFn: FetchLike): Promise<string> {
  if (parsed.branch) return parsed.branch;
  if (!parsed.owner || !parsed.repo) {
    throw new Error('Не удалось определить репозиторий и ветку из ссылки.');
  }
  const info = await fetchGitHubJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    fetchFn,
  );
  const branch = info.default_branch?.trim();
  if (!branch) throw new Error('GitHub не сообщил основную ветку репозитория.');
  return branch;
}

export async function checkGitHubUpdate(
  source: string,
  appDir: string,
  fetchFn: FetchLike = fetch,
): Promise<UpdateCheckResult> {
  const parsed = parseGitHubSource(source);
  if (!parsed.owner || !parsed.repo) {
    throw new Error('Для проверки версии укажи ссылку на репозиторий или ветку GitHub.');
  }
  const branch = await resolveBranch(parsed, fetchFn);
  const encodedBranch = branch.split('/').map((p) => encodeURIComponent(p)).join('/');
  const commit = await fetchGitHubJson<{
    sha?: string;
    commit?: { message?: string; committer?: { date?: string } };
  }>(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodedBranch}`,
    fetchFn,
  );

  const saved = await readUpdateState(appDir);
  const git = await detectLocalGitInfo(appDir);
  const localSha = saved?.commitSha ?? git.sha ?? null;
  const remoteSha = commit.sha ?? null;

  return {
    source: parsed.url,
    owner: parsed.owner,
    repo: parsed.repo,
    branch,
    localSha,
    remoteSha,
    remoteMessage: (commit.commit?.message ?? '').split('\n')[0] ?? '',
    remoteDate: commit.commit?.committer?.date ?? '',
    hasUpdate: Boolean(remoteSha && localSha !== remoteSha),
  };
}

/** Strips the common top-level directory GitHub puts inside branch ZIPs (e.g. "harness-main/"). */
export function stripCommonTopDir(entries: ZipEntry[]): ZipEntry[] {
  if (!entries.length) return entries;
  const firstSlash = entries[0]!.name.indexOf('/');
  if (firstSlash <= 0) return entries;
  const prefix = entries[0]!.name.slice(0, firstSlash + 1);
  if (!entries.every((e) => e.name.startsWith(prefix))) return entries;
  return entries
    .map((e) => ({ name: e.name.slice(prefix.length), data: e.data }))
    .filter((e) => e.name.length > 0);
}

export async function listUpdateBackups(appDir: string): Promise<UpdateBackupInfo[]> {
  const root = backupsRootDir(appDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: UpdateBackupInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(root, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')) as {
        createdAt?: string;
        commitSha?: string;
        files?: string[];
        newFiles?: string[];
      };
      const files = Array.isArray(manifest.files) ? manifest.files : [];
      const newFiles = Array.isArray(manifest.newFiles) ? manifest.newFiles : [];
      found.push({
        id: entry.name,
        path: folder,
        createdAt: manifest.createdAt ?? '',
        commitSha: manifest.commitSha ?? '',
        filesCount: files.length + newFiles.length,
        files,
        newFiles,
      });
    } catch {
      // ignore invalid backup dir
    }
  }
  found.sort((a, b) => b.id.localeCompare(a.id));
  return found;
}

async function createUpdateBackup(appDir: string, relatives: string[], commitSha: string): Promise<UpdateBackupInfo> {
  const root = backupsRootDir(appDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  const folder = path.join(root, id);
  const filesDir = path.join(folder, 'files');
  await mkdir(filesDir, { recursive: true });

  const files: string[] = [];
  const newFiles: string[] = [];

  try {
    for (const rel of relatives) {
      const abs = await resolveWithin(appDir, rel);
      let st = null;
      try {
        st = await stat(abs);
      } catch {
        st = null;
      }
      if (st?.isFile()) {
        const dest = path.join(filesDir, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(abs, dest);
        files.push(rel);
      } else if (!st) {
        newFiles.push(rel);
      } else {
        throw new Error(`На месте файла «${rel}» лежит папка — резервная копия невозможна.`);
      }
    }

    const createdAt = new Date().toISOString();
    await writeFile(
      path.join(folder, 'manifest.json'),
      JSON.stringify({ createdAt, commitSha, files, newFiles }, null, 2),
      'utf8',
    );

    const all = await listUpdateBackups(appDir);
    for (const old of all.slice(BACKUPS_KEEP)) {
      await rm(old.path, { recursive: true, force: true });
    }

    return {
      id,
      path: folder,
      createdAt,
      commitSha,
      filesCount: files.length + newFiles.length,
      files,
      newFiles,
    };
  } catch (err) {
    await rm(folder, { recursive: true, force: true });
    throw err;
  }
}

async function restoreBackupInfo(appDir: string, backup: UpdateBackupInfo): Promise<RollbackUpdateResult> {
  const filesDir = path.join(backup.path, 'files');
  const toRestore = backup.files.filter((rel) => !isProtectedPath(rel));
  const toRemove = backup.newFiles.filter((rel) => !isProtectedPath(rel));

  for (const rel of toRestore) {
    const src = path.join(filesDir, rel);
    const st = await stat(src).catch(() => null);
    if (!st?.isFile()) {
      throw new Error(`В резервной копии не найден файл «${rel}» — откат невозможен.`);
    }
  }

  let filesRestored = 0;
  for (const rel of toRestore) {
    const dest = await resolveWithin(appDir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(filesDir, rel), dest);
    filesRestored += 1;
  }

  let filesRemoved = 0;
  for (const rel of toRemove) {
    const dest = await resolveWithin(appDir, rel);
    try {
      await rm(dest, { force: false });
      filesRemoved += 1;
    } catch {
      // already absent
    }
  }

  await rm(backup.path, { recursive: true, force: true });
  return {
    backupId: backup.id,
    commitSha: backup.commitSha,
    filesRestored,
    filesRemoved,
  };
}

export async function rollbackLatestUpdate(appDir: string): Promise<RollbackUpdateResult> {
  const backups = await listUpdateBackups(appDir);
  if (!backups.length) {
    throw new Error('Резервных копий обновлений пока нет — откатывать нечего.');
  }
  return restoreBackupInfo(appDir, backups[0]!);
}

export interface ApplyUpdateOptions {
  fetchFn?: FetchLike;
  onProgress?: (stage: 'download' | 'backup' | 'install', text: string) => void;
}

export async function applyGitHubUpdate(
  source: string,
  appDir: string,
  options: ApplyUpdateOptions = {},
): Promise<ApplyUpdateResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const report = options.onProgress;
  const parsed = parseGitHubSource(source);

  let branch = parsed.branch;
  let zipUrl: string;
  let commitSha: string | null = null;
  let commitMessage = '';
  let commitDate = '';

  if (parsed.kind === 'zip') {
    zipUrl = parsed.url;
  } else {
    branch = await resolveBranch(parsed, fetchFn);
    zipUrl = codeloadZipUrl(parsed.owner, parsed.repo, branch);
    try {
      const check = await checkGitHubUpdate(parsed.url, appDir, fetchFn);
      commitSha = check.remoteSha;
      commitMessage = check.remoteMessage;
      commitDate = check.remoteDate;
    } catch {
      // Optional metadata lookup; ZIP download can still proceed if API is rate-limited.
    }
  }

  report?.('download', `Скачиваю архив с GitHub (${branch ?? 'zip'})…`);
  const zipRes = await fetchFn(zipUrl, {
    headers: { 'user-agent': 'MyAssistant-Updater/1.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (zipRes.status === 404) {
    throw new Error(`Архив на GitHub не найден (404). Проверь ссылку и имя ветки.`);
  }
  if (!zipRes.ok) {
    throw new Error(`Не удалось скачать архив обновления (код ${zipRes.status}).`);
  }

  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  if (zipBuf.length > MAX_ZIP_BYTES) {
    throw new Error('Архив обновления слишком большой.');
  }

  const rawEntries = parseZip(zipBuf);
  const stripped = stripCommonTopDir(rawEntries);
  if (!stripped.length) {
    throw new Error('В скачанном архиве нет файлов.');
  }

  const writable: ZipEntry[] = [];
  const skippedProtected: string[] = [];
  for (const entry of stripped) {
    const norm = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (isProtectedPath(norm)) {
      skippedProtected.push(norm);
      continue;
    }
    // Validate safe target path within appDir before touching anything.
    await resolveWithin(appDir, norm);
    writable.push({ name: norm, data: entry.data });
  }

  if (!writable.length) {
    throw new Error('В архиве не нашлось файлов программы для обновления.');
  }

  const prevState = await readUpdateState(appDir);
  const git = await detectLocalGitInfo(appDir);
  const prevSha = prevState?.commitSha ?? git.sha ?? '';

  report?.('backup', `Создаю резервную копию (${writable.length} файлов)…`);
  const backup = await createUpdateBackup(
    appDir,
    writable.map((e) => e.name),
    prevSha,
  );

  report?.('install', `Устанавливаю обновление (${writable.length} файлов)…`);
  let packageJsonChanged = false;
  try {
    for (const entry of writable) {
      const dest = await resolveWithin(appDir, entry.name);
      if (entry.name === 'package.json') {
        const oldPkg = await readFile(dest, 'utf8').catch(() => '');
        if (oldPkg !== entry.data.toString('utf8')) packageJsonChanged = true;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, entry.data);
    }
  } catch (err) {
    await restoreBackupInfo(appDir, backup).catch(() => {});
    throw new Error(`Ошибка при установке обновления (всё возвращено назад): ${(err as Error).message}`);
  }

  await writeUpdateState(appDir, {
    source: parsed.url,
    owner: parsed.owner || undefined,
    repo: parsed.repo || undefined,
    branch: branch ?? undefined,
    commitSha: commitSha ?? undefined,
    commitMessage: commitMessage || undefined,
    commitDate: commitDate || undefined,
    updatedAt: new Date().toISOString(),
    filesWritten: writable.length,
  });

  return {
    zipUrl,
    source: parsed.url,
    branch,
    commitSha,
    filesWritten: writable.length,
    skippedProtected,
    packageJsonChanged,
    backupId: backup.id,
  };
}
