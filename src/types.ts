/** Universal types shared by providers, the agent loop, tools and sessions. */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name?: string;
  content: string;
  isError?: boolean;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface JSONSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  /** Directory the tool is allowed to touch. */
  cwd: string;
  signal?: AbortSignal;
  /** Registers a file so the checkpoint can capture its state before modification. */
  trackFile(path: string): Promise<void> | void;
}

export interface Tool<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(args: Args, context: ToolContext): Promise<string | ToolOutput> | string | ToolOutput;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'length'
  | 'stop'
  | 'error'
  | 'max_turns'
  | 'loop_detected';

export interface ModelConfig {
  /** Key into the providers map, or one of the built-ins: anthropic, openai, openrouter, ollama. */
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatRequest {
  model: ModelConfig;
  messages: Message[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

/**
 * Provider output is normalized into these events: the agent loop never sees
 * vendor-specific SSE payloads.
 */
export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'done'; stopReason: StopReason; usage?: Usage }
  | { type: 'error'; error: Error };

export interface ModelProvider {
  readonly name: string;
  chat(request: ChatRequest): AsyncIterable<ProviderStreamEvent>;
}

export type AgentEvent =
  | { type: 'run_start'; sessionId: string; prompt: string }
  | { type: 'text_delta'; text: string; messageId: string }
  | { type: 'message'; message: Message }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; result: ToolResult }
  | { type: 'checkpoint'; checkpointId: string }
  | { type: 'compacted'; summary: string; removedMessages: number }
  | { type: 'loop_detected'; reason: string }
  | { type: 'done'; result: AgentResult }
  | { type: 'error'; error: Error };

export interface AgentResult {
  sessionId: string;
  text: string;
  messages: Message[];
  turns: number;
  usage: Usage;
  stopReason: StopReason;
  checkpointId?: string;
}
