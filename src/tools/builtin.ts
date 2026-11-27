import { exec } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '../types.js';
import { resolveWithin, truncate } from '../utils.js';
import { checkBashCommandSafety } from './safety.js';

const execAsync = promisify(exec);
const MAX_OUTPUT = 12_000;
/** Checkpoints store full file contents, so keep individual writes bounded. */
const MAX_FILE_BYTES = 1_000_000;
const IGNORED_DIRS = new Set(['node_modules', '.git', '.harness', 'dist', '__pycache__', '.venv']);

export function createReadTool(): Tool<{
  path: string;
  offset?: number;
  limit?: number;
  maxChars?: number;
}> {
  return {
    name: 'read',
    description:
      'Read a UTF-8 text file inside the workspace. Pass offset (1-based line) and limit (line count) to read large files in small chunks and save tokens.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        offset: { type: 'number', description: 'Optional 1-based starting line number' },
        limit: { type: 'number', description: 'Optional maximum number of lines to return' },
        maxChars: { type: 'number', description: 'Optional character limit (default 12000)' },
      },
      required: ['path'],
    },
    async execute(args, context) {
      const absolute = await resolveWithin(context.cwd, args.path);
      const content = await readFile(absolute, 'utf8');
      const maxChars = args.maxChars ?? MAX_OUTPUT;

      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, Math.floor(args.offset ?? 1));
        const count = args.limit !== undefined ? Math.max(1, Math.floor(args.limit)) : lines.length;
        const slice = lines.slice(start - 1, start - 1 + count);
        const end = start - 1 + slice.length;
        const numbered = slice.map((line, idx) => `${start + idx}: ${line}`).join('\n');
        const header = `[Lines ${slice.length ? start : 0}-${end} of ${lines.length} in ${args.path}]\n`;
        return truncate(header + numbered, maxChars);
      }

      if (content.length > maxChars) {
        const totalLines = content.split(/\r?\n/).length;
        return (
          truncate(content, maxChars) +
          `\n[File has ${totalLines} lines. Pass offset and limit to read specific sections.]`
        );
      }
      return content;
    },
  };
}

export function createEditTool(): Tool<{ path: string; oldText: string; newText: string }> {
  return {
    name: 'edit',
    description:
      'Replace an exact snippet in an existing file inside the workspace. Prefer this over write for small edits to save tokens.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        oldText: { type: 'string', description: 'Exact existing text to replace (must match once)' },
        newText: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    async execute(args, context) {
      if (!args.oldText) {
        return { content: 'oldText must not be empty', isError: true };
      }
      const absolute = await resolveWithin(context.cwd, args.path);
      let content: string;
      try {
        content = await readFile(absolute, 'utf8');
      } catch (error) {
        return {
          content: `Cannot read ${args.path}: ${(error as Error).message}`,
          isError: true,
        };
      }

      let updated: string | undefined;
      const exactCount = content.split(args.oldText).length - 1;
      if (exactCount === 1) {
        updated = content.replace(args.oldText, () => args.newText);
      } else if (exactCount > 1) {
        return {
          content: `oldText matched ${exactCount} places in ${args.path}. Include more surrounding lines so it matches only once.`,
          isError: true,
        };
      } else if (content.includes('\r\n')) {
        // Handle CRLF files when model sends LF-normalized oldText.
        const normContent = content.replace(/\r\n/g, '\n');
        const normOld = args.oldText.replace(/\r\n/g, '\n');
        const normCount = normContent.split(normOld).length - 1;
        if (normCount === 1) {
          const normNew = args.newText.replace(/\r\n/g, '\n');
          updated = normContent.replace(normOld, () => normNew).replace(/\n/g, '\r\n');
        } else if (normCount > 1) {
          return {
            content: `oldText matched ${normCount} places in ${args.path}. Include more surrounding lines so it matches only once.`,
            isError: true,
          };
        }
      }

      if (updated === undefined) {
        return {
          content: `oldText was not found in ${args.path}. Read the file first and copy the exact lines.`,
          isError: true,
        };
      }

      const bytes = Buffer.byteLength(updated);
      if (bytes > MAX_FILE_BYTES) {
        return {
          content: `File is too large for a checkpointed edit (${bytes} bytes, limit ${MAX_FILE_BYTES})`,
          isError: true,
        };
      }

      await context.trackFile(args.path);
      await writeFile(absolute, updated, 'utf8');
      return `Edited ${args.path} (${bytes} bytes)`;
    },
  };
}

export function createWriteTool(): Tool<{ path: string; content: string }> {
  return {
    name: 'write',
    description:
      'Create a new file or completely overwrite a file inside the workspace. Use edit instead when modifying part of an existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        content: { type: 'string', description: 'Full new file contents' },
      },
      required: ['path', 'content'],
    },
    async execute(args, context) {
      const bytes = Buffer.byteLength(args.content);
      if (bytes > MAX_FILE_BYTES) {
        return {
          content: `File is too large for a checkpointed write (${bytes} bytes, limit ${MAX_FILE_BYTES})`,
          isError: true,
        };
      }
      const absolute = await resolveWithin(context.cwd, args.path);
      await context.trackFile(args.path);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, args.content, 'utf8');
      return `Wrote ${args.path} (${bytes} bytes)`;
    },
  };
}

export function createListFilesTool(): Tool<{ dir?: string; maxDepth?: number }> {
  return {
    name: 'list_files',
    description:
      'List files inside the workspace cross-platform (no shell needed). Skips node_modules, .git and dist.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Optional workspace-relative subdirectory (default ".")' },
        maxDepth: { type: 'number', description: 'Optional depth limit (default 4)' },
      },
    },
    async execute(args, context) {
      const baseRel = args.dir?.trim() || '.';
      const root = await resolveWithin(context.cwd, baseRel);
      const maxDepth = Math.max(1, Math.floor(args.maxDepth ?? 4));
      const results: string[] = [];
      let truncated = false;

      async function walk(dirPath: string, prefix: string, depth: number): Promise<void> {
        if (depth > maxDepth || results.length >= 200) {
          if (results.length >= 200) truncated = true;
          return;
        }
        let entries;
        try {
          entries = await readdir(dirPath, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(path.join(dirPath, entry.name), rel, depth + 1);
          } else {
            if (results.length >= 200) {
              truncated = true;
              return;
            }
            results.push(rel);
          }
        }
      }

      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) {
        return baseRel;
      }
      await walk(root, baseRel === '.' ? '' : baseRel.replace(/\/+$/, ''), 1);
      if (!results.length) return '(empty directory)';
      return results.join('\n') + (truncated ? '\n... (truncated at 200 files)' : '');
    },
  };
}

export function createSearchTool(): Tool<{
  query: string;
  path?: string;
  caseSensitive?: boolean;
}> {
  return {
    name: 'search',
    description:
      'Search for text across files in the workspace cross-platform (no shell needed). Returns path:line: text.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for' },
        path: { type: 'string', description: 'Optional file or subdirectory (default ".")' },
        caseSensitive: { type: 'boolean', description: 'Match exact letter case (default false)' },
      },
      required: ['query'],
    },
    async execute(args, context) {
      if (!args.query) {
        return { content: 'query must not be empty', isError: true };
      }
      const targetRel = args.path?.trim() || '.';
      const targetAbs = await resolveWithin(context.cwd, targetRel);
      const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
      const matches: string[] = [];
      const maxMatches = 50;

      async function searchFile(fileAbs: string, fileRel: string): Promise<void> {
        if (matches.length >= maxMatches) return;
        let info;
        try {
          info = await stat(fileAbs);
        } catch {
          return;
        }
        if (info.size > MAX_FILE_BYTES) return;
        let buf: Buffer;
        try {
          buf = await readFile(fileAbs);
        } catch {
          return;
        }
        if (buf.includes(0)) return; // skip binary files
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const hay = args.caseSensitive ? line : line.toLowerCase();
          if (hay.includes(needle)) {
            matches.push(`${fileRel}:${i + 1}: ${truncate(line.trim(), 200)}`);
            if (matches.length >= maxMatches) return;
          }
        }
      }

      async function walk(dirPath: string, prefix: string): Promise<void> {
        if (matches.length >= maxMatches) return;
        let entries;
        try {
          entries = await readdir(dirPath, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const abs = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            await walk(abs, rel);
          } else {
            await searchFile(abs, rel);
          }
        }
      }

      const info = await stat(targetAbs);
      if (info.isFile()) {
        await searchFile(targetAbs, targetRel);
      } else {
        await walk(targetAbs, targetRel === '.' ? '' : targetRel.replace(/\/+$/, ''));
      }

      if (!matches.length) return `No matches for "${args.query}"`;
      return matches.join('\n') + (matches.length >= maxMatches ? '\n... (stopped at 50 matches)' : '');
    },
  };
}

export interface BashToolOptions {
  timeout?: number;
  maxBuffer?: number;
  /** Disable the pre-execution safety guard when explicitly intended. */
  allowUnsafe?: boolean;
}

export function createBashTool(options: BashToolOptions = {}): Tool<{
  command: string;
  cwd?: string;
  timeout?: number;
}> {
  return {
    name: 'bash',
    description:
      'Run a shell command inside the workspace. Use for builds, tests and running scripts. Destructive commands or paths outside workspace are blocked.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Optional workspace-relative working directory' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 10000)' },
      },
      required: ['command'],
    },
    async execute(args, context) {
      if (!options.allowUnsafe) {
        const check = checkBashCommandSafety(args.command);
        if (!check.safe) {
          return {
            content: `Команда заблокирована фильтром безопасности: ${check.reason}`,
            isError: true,
          };
        }
      }
      const cwd = args.cwd ? await resolveWithin(context.cwd, args.cwd) : await resolveWithin(context.cwd, '.');
      try {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd,
          timeout: args.timeout ?? options.timeout ?? 10_000,
          maxBuffer: options.maxBuffer ?? 1024 * 1024,
          signal: context.signal,
        });
        return truncate(`stdout:\n${stdout}\nstderr:\n${stderr}`.trim(), MAX_OUTPUT);
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
        return {
          content: truncate(
            `Command failed: ${failure.message}\nstdout:\n${failure.stdout ?? ''}\nstderr:\n${failure.stderr ?? ''}`,
            MAX_OUTPUT,
          ),
          isError: true,
        };
      }
    },
  };
}

export function createDeleteFileTool(): Tool<{ path: string }> {
  return {
    name: 'delete_file',
    description:
      'Delete a single file inside the workspace. Captured by checkpoints so rollback can restore it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path to delete' },
      },
      required: ['path'],
    },
    async execute(args, context) {
      const cleaned = args.path.trim();
      if (!cleaned || cleaned === '.' || cleaned === './') {
        return { content: 'Refusing to delete the workspace root directory', isError: true };
      }
      const absolute = await resolveWithin(context.cwd, cleaned);
      let info;
      try {
        info = await stat(absolute);
      } catch (error) {
        return { content: `Cannot delete ${args.path}: ${(error as Error).message}`, isError: true };
      }
      if (info.isDirectory()) {
        return { content: `${args.path} is a directory; delete_file only removes files`, isError: true };
      }
      await context.trackFile(args.path);
      await rm(absolute);
      return `Deleted ${args.path}`;
    },
  };
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
    return true;
  }
  const m = /^172\.(\d+)\./.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function htmlToReadableText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');

  return stripped
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface FetchPageToolOptions {
  fetch?: typeof fetch;
  allowLocal?: boolean;
}

export function createFetchPageTool(options: FetchPageToolOptions = {}): Tool<{
  url: string;
  maxChars?: number;
}> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    name: 'fetch_page',
    description:
      'Fetch a web page (http/https) and extract readable text. Useful for reading documentation or examples from a URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http or https URL to read' },
        maxChars: { type: 'number', description: 'Optional character limit (default 10000)' },
      },
      required: ['url'],
    },
    async execute(args, context) {
      let parsed: URL;
      try {
        parsed = new URL(args.url.trim());
      } catch {
        return { content: `Invalid URL: ${args.url}`, isError: true };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { content: 'Only http:// and https:// URLs are allowed', isError: true };
      }
      if (!options.allowLocal && isBlockedHost(parsed.hostname)) {
        return { content: 'Refusing to fetch private or local network addresses', isError: true };
      }

      const signal = context.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000);
      let response: Response;
      try {
        response = await fetchImpl(parsed.toString(), {
          headers: { 'user-agent': 'harness-core/0.1', accept: 'text/html,text/plain,application/json,*/*' },
          signal,
        });
      } catch (error) {
        return { content: `Failed to fetch ${parsed.toString()}: ${(error as Error).message}`, isError: true };
      }
      if (!response.ok) {
        return { content: `Page returned HTTP ${response.status} (${response.statusText})`, isError: true };
      }

      const contentType = response.headers.get('content-type') ?? '';
      const raw = await response.text();
      const text = contentType.includes('text/html') || /^\s*<!doctype|^\s*<html/i.test(raw)
        ? htmlToReadableText(raw)
        : raw.trim();
      const limit = Math.max(500, Math.min(20_000, args.maxChars ?? 10_000));
      return `[Source: ${response.url || parsed.toString()}]\n${truncate(text || '(empty page)', limit)}`;
    },
  };
}

export function createDefaultTools(options: BashToolOptions = {}) {
  return [
    createReadTool(),
    createEditTool(),
    createWriteTool(),
    createDeleteFileTool(),
    createListFilesTool(),
    createSearchTool(),
    createFetchPageTool(),
    createBashTool(options),
  ];
}
