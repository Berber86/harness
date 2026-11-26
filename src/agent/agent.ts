import { resolveProvider } from '../providers/registry.js';
import { rollbackToCheckpoint } from '../session/checkpoint.js';
import { FileSessionStore } from '../session/store.js';
import { Session } from '../session/session.js';
import type { ContextOptions } from '../session/context.js';
import type { Checkpoint, SessionStore } from '../session/types.js';
import type { AgentEvent, AgentResult, ModelConfig, ModelProvider, Tool } from '../types.js';
import { createDefaultTools } from '../tools/builtin.js';
import { runAgentLoop } from './loop.js';
import type { AuthorizeHandler, LoopDetectionOptions } from './loop.js';

export interface AgentOptions {
  model: ModelConfig;
  /** Explicit provider instance takes precedence over the registry. */
  provider?: ModelProvider;
  /** Custom provider implementations keyed by ModelConfig.provider. */
  providers?: Record<string, ModelProvider>;
  tools?: Tool[];
  systemPrompt?: string;
  session?: Session;
  store?: SessionStore;
  sessionDir?: string;
  cwd?: string;
  maxTurns?: number;
  context?: ContextOptions;
  loopDetection?: LoopDetectionOptions;
  /** Called before each tool execution; return false to deny. */
  authorize?: AuthorizeHandler;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Override the agent's session for this run (useful for forks/branches). */
  session?: Session;
}

/** High-level facade; `stream()` exposes the same events the loop produces. */
export class Agent {
  private initialized?: Promise<Session>;

  constructor(private readonly options: AgentOptions) {}

  getSession(): Promise<Session> {
    if (!this.initialized) {
      const store = this.options.store ??
        (this.options.sessionDir ? new FileSessionStore(this.options.sessionDir) : undefined);
      const session = this.options.session ?? Session.create(store ? { store } : {});
      this.initialized = Promise.resolve(session);
    }
    return this.initialized;
  }

  stream(prompt: string, runOptions: RunOptions = {}): AsyncGenerator<AgentEvent> {
    const options = this.options;
    const agent = this;
    return (async function* (): AsyncGenerator<AgentEvent> {
      const session = runOptions.session ?? await agent.getSession();
      const provider = options.provider ?? resolveProvider(options.model, options.providers);
      yield* runAgentLoop({
        session,
        prompt,
        provider,
        model: options.model,
        tools: options.tools ?? createDefaultTools(),
        cwd: options.cwd ?? process.cwd(),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        ...(options.context ? { context: options.context } : {}),
        ...(options.loopDetection ? { loopDetection: options.loopDetection } : {}),
        ...(runOptions.signal ? { signal: runOptions.signal } : {}),
        ...(options.authorize ? { authorize: options.authorize } : {}),
      });
    })();
  }

  async run(prompt: string, runOptions: RunOptions = {}): Promise<AgentResult> {
    let result: AgentResult | undefined;
    for await (const event of this.stream(prompt, runOptions)) {
      if (event.type === 'done') result = event.result;
    }
    if (!result) throw new Error('Agent run finished without a result event');
    return result;
  }

  async rollback(checkpointId: string): Promise<Checkpoint> {
    const session = await this.getSession();
    return rollbackToCheckpoint(session, checkpointId, this.options.cwd ?? process.cwd());
  }
}

export async function createAgent(options: AgentOptions): Promise<Agent> {
  const agent = new Agent(options);
  await agent.getSession();
  return agent;
}
