import type { Message, ModelConfig, ModelProvider } from '../types.js';
import { estimateTokens, newId } from '../utils.js';
import type { Session } from './session.js';

export interface ContextOptions {
  /** Approximate token budget that triggers compaction. Default: 16000. */
  maxTokens?: number;
  /** Number of most recent messages always kept verbatim. Default: 6. */
  keepRecent?: number;
  enabled?: boolean;
  /** Compact older messages even when total tokens are below maxTokens. */
  force?: boolean;
}

export interface CompactionResult {
  summary: string;
  removedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
}

function tokensIn(message: Message): number {
  const extras = message.toolCalls || message.toolResults
    ? JSON.stringify({ calls: message.toolCalls, results: message.toolResults })
    : '';
  return estimateTokens(message.content + extras);
}

export function estimateSessionTokens(session: Session): number {
  return session.messages.reduce((total, message) => total + tokensIn(message), 0);
}

async function summarize(
  provider: ModelProvider,
  model: ModelConfig,
  transcript: string,
): Promise<string> {
  const now = Date.now();
  const messages: Message[] = [
    {
      id: newId(),
      role: 'system',
      content:
        'You compress a coding-agent conversation into a dense summary. Preserve the user\'s goals, decisions, file paths, code snippets, tool outcomes and unresolved tasks. Do not answer the conversation; only summarize it.',
      createdAt: now,
    },
    { id: newId(), role: 'user', content: transcript, createdAt: now },
  ];
  let text = '';
  for await (const event of provider.chat({ model, messages, tools: [] })) {
    if (event.type === 'text_delta') text += event.text;
    else if (event.type === 'error') throw event.error;
  }
  return text.trim();
}

/** Replaces old messages with a model-written summary when the budget is exceeded. */
export async function compactIfNeeded(
  session: Session,
  provider: ModelProvider,
  model: ModelConfig,
  options: ContextOptions = {},
): Promise<CompactionResult | null> {
  if (options.enabled === false) return null;
  const maxTokens = options.maxTokens ?? 16_000;
  const tokensBefore = estimateSessionTokens(session);
  if (!options.force && tokensBefore <= maxTokens) return null;

  let leadingSystem = 0;
  while (session.messages[leadingSystem]?.role === 'system') leadingSystem++;
  const protectedMessages = session.messages.slice(0, leadingSystem);
  const rest = session.messages.slice(leadingSystem);

  let keep = Math.max(1, options.keepRecent ?? 6);
  while (
    keep > 1 &&
    [...protectedMessages, ...rest.slice(-keep)].reduce((sum, message) => sum + tokensIn(message), 0) > maxTokens
  ) {
    keep--;
  }
  if (rest.length <= keep) return null;

  const older = rest.slice(0, rest.length - keep);
  const recent = rest.slice(rest.length - keep);
  const transcript = older
    .map((message) => {
      const tools = message.toolCalls || message.toolResults
        ? `\n  tools: ${JSON.stringify({ calls: message.toolCalls, results: message.toolResults })}`
        : '';
      return `[${message.role}] ${message.content}${tools}`;
    })
    .join('\n\n')
    .slice(0, 120_000);

  let summary: string;
  try {
    summary = await summarize(provider, model, transcript);
    if (!summary) throw new Error('Summarizer returned an empty response');
  } catch {
    summary = `Earlier conversation (${older.length} messages) exceeded the context budget and was truncated. Continue from the most recent messages.`;
  }

  const summaryMessage: Message = {
    id: newId(),
    role: 'system',
    content: `Summary of earlier conversation:\n${summary}`,
    createdAt: Date.now(),
    meta: { kind: 'compaction', compactedMessages: older.length },
  };
  session.setMessages([...protectedMessages, summaryMessage, ...recent]);
  await session.save();
  return {
    summary,
    removedMessages: older.length - 1,
    tokensBefore,
    tokensAfter: estimateSessionTokens(session),
  };
}
