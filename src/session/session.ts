import { newId } from '../utils.js';
import type { Message } from '../types.js';
import { FileSessionStore } from './store.js';
import type { Checkpoint, SessionData, SessionStore } from './types.js';

export interface CreateSessionOptions {
  id?: string;
  store?: SessionStore;
  metadata?: Record<string, unknown>;
}

/** Mutable conversation state. Call `save()` after modifying it. */
export class Session {
  readonly id: string;
  readonly createdAt: number;
  updatedAt: number;
  messages: Message[];
  checkpoints: Checkpoint[];
  metadata: Record<string, unknown>;

  constructor(data: SessionData, private readonly store: SessionStore) {
    this.id = data.id;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.messages = data.messages;
    this.checkpoints = data.checkpoints;
    this.metadata = data.metadata;
  }

  static async create(options: CreateSessionOptions = {}): Promise<Session> {
    const store = options.store ?? new FileSessionStore();
    const now = Date.now();
    const session = new Session(
      {
        id: options.id ?? newId(),
        createdAt: now,
        updatedAt: now,
        messages: [],
        checkpoints: [],
        metadata: options.metadata ?? {},
      },
      store,
    );
    await session.save();
    return session;
  }

  static async load(id: string, store: SessionStore = new FileSessionStore()): Promise<Session | null> {
    const data = await store.load(id);
    return data ? new Session(data, store) : null;
  }

  static list(store: SessionStore = new FileSessionStore()) {
    return store.list();
  }

  addMessage(message: Message): void {
    this.messages.push(message);
    this.updatedAt = Date.now();
  }

  setMessages(messages: Message[]): void {
    this.messages = messages;
    this.updatedAt = Date.now();
  }

  truncate(messageCount: number): void {
    this.messages = this.messages.slice(0, messageCount);
    this.updatedAt = Date.now();
  }

  toData(): SessionData {
    return {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messages: this.messages,
      checkpoints: this.checkpoints,
      metadata: this.metadata,
    };
  }

  save(): Promise<void> {
    return this.store.save(this.toData());
  }
}
