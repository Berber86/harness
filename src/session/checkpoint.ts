import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '../types.js';
import { hashText, newId, readFileIfExists, resolveWithin } from '../utils.js';
import type { Session } from './session.js';
import type { Checkpoint, FileChange } from './types.js';

const MAX_CHECKPOINTS = 100;

/** Captures the state of files touched during a run, then rolls them back. */
export class CheckpointTracker {
  private readonly before = new Map<string, string | null>();
  private readonly startMessageCount: number;
  private readonly startLastMessageId?: string;

  constructor(private readonly root: string, session?: Session) {
    this.startMessageCount = session?.messages.length ?? 0;
    this.startLastMessageId = session?.messages.at(-1)?.id;
  }

  async track(filePath: string): Promise<void> {
    const absolute = await resolveWithin(this.root, filePath);
    if (!this.before.has(absolute)) {
      this.before.set(absolute, await readFileIfExists(absolute));
    }
  }

  async finalize(session: Session, label: string): Promise<Checkpoint> {
    const changes: FileChange[] = [];
    for (const [absolute, before] of this.before) {
      const after = await readFileIfExists(absolute);
      const beforeHash = before === null ? null : hashText(before);
      const afterHash = after === null ? null : hashText(after);
      if (beforeHash === afterHash) continue;
      changes.push({
        path: path.relative(this.root, absolute) || path.basename(absolute),
        before,
        after,
        beforeHash,
        afterHash,
      });
    }
    const checkpoint: Checkpoint = {
      id: newId(),
      sessionId: session.id,
      createdAt: Date.now(),
      label,
      messageCount: this.startMessageCount,
      ...(this.startLastMessageId ? { lastMessageId: this.startLastMessageId } : {}),
      changes,
    };
    session.checkpoints = [...session.checkpoints, checkpoint].slice(-MAX_CHECKPOINTS);
    await session.save();
    return checkpoint;
  }
}

/** Restores both files and the conversation to the state recorded in a checkpoint. */
export async function rollbackToCheckpoint(
  session: Session,
  checkpointId: string,
  root: string,
): Promise<Checkpoint> {
  const index = session.checkpoints.findIndex((checkpoint) => checkpoint.id === checkpointId);
  if (index === -1) throw new Error(`Checkpoint not found: ${checkpointId}`);
  const checkpoint = session.checkpoints[index]!;

  for (const change of checkpoint.changes) {
    const absolute = await resolveWithin(root, change.path);
    if (change.before === null) {
      await rm(absolute, { force: true });
    } else {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, change.before, 'utf8');
    }
  }

  const messageIndex = checkpoint.lastMessageId
    ? session.messages.findIndex((message: Message) => message.id === checkpoint.lastMessageId)
    : -1;
  session.setMessages(
    messageIndex >= 0 ? session.messages.slice(0, messageIndex + 1) : session.messages.slice(0, checkpoint.messageCount),
  );
  session.checkpoints = session.checkpoints.slice(0, index + 1);
  session.metadata.lastCheckpointId = checkpoint.id;
  await session.save();
  return checkpoint;
}
