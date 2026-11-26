import type { Message } from '../types.js';

export interface FileChange {
  /** Workspace-relative path. */
  path: string;
  before: string | null;
  after: string | null;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  createdAt: number;
  label: string;
  messageCount: number;
  lastMessageId?: string;
  changes: FileChange[];
}

export interface SessionData {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  checkpoints: Checkpoint[];
  metadata: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionStore {
  save(data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  list(): Promise<SessionSummary[]>;
}
