import type { ProviderStreamEvent, SessionData, SessionStore, SessionSummary } from '../src/index.js';

export class MemoryStore implements SessionStore {
  readonly data = new Map<string, SessionData>();

  async save(data: SessionData): Promise<void> {
    this.data.set(data.id, structuredClone(data));
  }

  async load(id: string): Promise<SessionData | null> {
    const data = this.data.get(id);
    return data ? structuredClone(data) : null;
  }

  async list(): Promise<SessionSummary[]> {
    return [...this.data.values()].map((data) => ({
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: data.messages.length,
    }));
  }
}

export class ScriptedProvider {
  readonly name = 'scripted';
  readonly requests: Array<{
    model: { provider: string; model: string };
    messages: unknown[];
    tools: Array<{ name: string; parameters: { properties?: Record<string, { enum?: unknown[] }> } }>;
  }> = [];
  private readonly scripts: ProviderStreamEvent[][];

  constructor(...scripts: ProviderStreamEvent[][]) {
    this.scripts = scripts;
  }

  async *chat(request: {
    model: { provider: string; model: string };
    messages: unknown[];
    tools: Array<{ name: string; parameters: { properties?: Record<string, { enum?: unknown[] }> } }>;
  }): AsyncGenerator<ProviderStreamEvent> {
    this.requests.push({ model: request.model, messages: request.messages, tools: request.tools });
    const script = this.scripts.shift() ?? [{ type: 'done', stopReason: 'end_turn' }];
    for (const event of script) yield event;
  }
}

export async function collect(
  iterable: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
