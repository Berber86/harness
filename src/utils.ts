import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path, { resolve } from 'node:path';
import type { JSONSchema } from './types.js';

export function newId(): string {
  return randomUUID();
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Rough approximation: ~4 characters per token for English, more for code.
  return Math.ceil(text.length / 4);
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Resolves user-supplied paths relative to `root` and rejects any escape via
 * `..` or symlinks. Returns an absolute path.
 */
export async function resolveWithin(root: string, target: string): Promise<string> {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('Path must be a non-empty string');
  }
  const base = await realpath(root).catch(() => resolve(root));
  const candidate = resolve(base, target);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (candidate !== base && !candidate.startsWith(prefix)) {
    throw new Error(`Path escapes workspace: ${target}`);
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return candidate;
  }
  if (real !== base && !real.startsWith(prefix)) {
    throw new Error(`Path escapes workspace (symlink): ${target}`);
  }
  return real;
}

export async function readFileIfExists(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Tiny JSON-Schema validator for tool arguments (objects, primitives, arrays). */
export function validateArguments(
  schema: JSONSchema,
  value: unknown,
  path = 'arguments',
): string[] {
  const errors: string[] = [];
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path} must be an object`];
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        errors.push(...validateArguments(childSchema, record[key], `${path}.${key}`));
      }
    }
    return errors;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateArguments(schema.items!, item, `${path}[${i}]`)));
    }
    return errors;
  }
  if (schema.type === 'string' && typeof value !== 'string') return [`${path} must be a string`];
  if (schema.type === 'number' && typeof value !== 'number') return [`${path} must be a number`];
  if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path} must be an integer`];
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path} must be a boolean`];
  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path} must be one of ${JSON.stringify(schema.enum)}`];
  }
  return errors;
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit < 200) return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
  const head = Math.floor(limit * 0.65);
  const tail = Math.floor(limit * 0.25);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${omitted} chars omitted] …\n${text.slice(-tail)}`;
}
