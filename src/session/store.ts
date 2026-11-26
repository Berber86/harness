import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionData, SessionStore, SessionSummary } from './types.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Append-safe (atomic replace) JSON session store, one file per session. */
export class FileSessionStore implements SessionStore {
  constructor(public readonly directory: string = path.join('.harness', 'sessions')) {}

  private pathFor(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid session id: ${id}`);
    return path.join(this.directory, `${id}.json`);
  }

  async save(data: SessionData): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.pathFor(data.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
    await rename(temporary, target);
  }

  async load(id: string): Promise<SessionData | null> {
    try {
      const raw = await readFile(this.pathFor(id), 'utf8');
      return JSON.parse(raw) as SessionData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(): Promise<SessionSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const summaries: SessionSummary[] = [];
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      const id = file.slice(0, -'.json'.length);
      const data = await this.load(id);
      if (!data) continue;
      summaries.push({
        id: data.id,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messageCount: data.messages.length,
      });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
