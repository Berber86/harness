import { exec } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '../types.js';
import { resolveWithin, truncate } from '../utils.js';

const execAsync = promisify(exec);
const MAX_OUTPUT = 20_000;
/** Checkpoints store full file contents, so keep individual writes bounded. */
const MAX_FILE_BYTES = 1_000_000;

export function createReadTool(): Tool<{ path: string; maxChars?: number }> {
  return {
    name: 'read',
    description: 'Read a UTF-8 text file inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        maxChars: { type: 'number', description: 'Optional output limit (default 20000)' },
      },
      required: ['path'],
    },
    async execute(args, context) {
      const absolute = await resolveWithin(context.cwd, args.path);
      const content = await readFile(absolute, 'utf8');
      return truncate(content, args.maxChars ?? MAX_OUTPUT);
    },
  };
}

export function createWriteTool(): Tool<{ path: string; content: string }> {
  return {
    name: 'write',
    description: 'Create or overwrite a text file inside the workspace. Parent directories are created.',
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

export interface BashToolOptions {
  timeout?: number;
  maxBuffer?: number;
}

export function createBashTool(options: BashToolOptions = {}): Tool<{
  command: string;
  cwd?: string;
  timeout?: number;
}> {
  return {
    name: 'bash',
    description:
      'Run a shell command inside the workspace. Use for builds, tests and git. Changes made by shell commands are not captured by checkpoints.',
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

export function createDefaultTools(options: BashToolOptions = {}) {
  return [createReadTool(), createWriteTool(), createBashTool(options)];
}
