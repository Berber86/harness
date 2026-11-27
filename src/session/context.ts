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
  mode?: 'micro' | 'summary';
}

const MICRO_COMPACT_THRESHOLD = 400;

function tokensIn(message: Message): number {
  const extras = message.toolCalls || message.toolResults
    ? JSON.stringify({ calls: message.toolCalls, results: message.toolResults })
    : '';
  return estimateTokens(message.content + extras);
}

export function estimateSessionTokens(session: Session): number {
  return session.messages.reduce((total, message) => total + tokensIn(message), 0);
}

/** Ensures we never split a recent slice right between an assistant's toolCalls and its toolResults. */
function findSafeRecentStart(rest: Message[], desiredKeep: number): number {
  let idx = Math.max(0, rest.length - desiredKeep);
  while (idx > 0 && rest[idx]?.role === 'tool') {
    idx--;
  }
  return idx;
}

/** Replaces bulky tool outputs older than `recentStart` with compact placeholders at zero LLM cost. */
function microCompactOlderToolResults(rest: Message[], recentStart: number): number {
  let compactedCount = 0;
  for (let i = 0; i < recentStart; i++) {
    const msg = rest[i]!;
    if (msg.role !== 'tool' || msg.meta?.microCompacted) continue;
    const rawLen = msg.content.length;
    const hasLongResult =
      rawLen > MICRO_COMPACT_THRESHOLD ||
      Boolean(msg.toolResults?.some((r) => r.content.length > MICRO_COMPACT_THRESHOLD));
    if (!hasLongResult) continue;

    const toolName = msg.toolResults?.[0]?.name ?? 'tool';
    const placeholder = `[Старый результат «${toolName}» скрыт для экономии (${rawLen} симв.). При необходимости вызови инструмент снова.]`;
    msg.content = placeholder;
    if (msg.toolResults) {
      msg.toolResults = msg.toolResults.map((r) =>
        r.content.length > MICRO_COMPACT_THRESHOLD
          ? {
              ...r,
              content: `[Старый результат «${r.name ?? toolName}» скрыт (${r.content.length} симв.)]`,
            }
          : r,
      );
    }
    msg.meta = { ...msg.meta, microCompacted: true };
    compactedCount++;
  }
  return compactedCount;
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
  let recentStart = findSafeRecentStart(rest, keep);
  while (
    recentStart < rest.length - 1 &&
    [...protectedMessages, ...rest.slice(recentStart)].reduce((sum, message) => sum + tokensIn(message), 0) > maxTokens
  ) {
    keep = Math.max(1, keep - 1);
    const nextStart = findSafeRecentStart(rest, keep);
    if (nextStart === recentStart) break;
    recentStart = nextStart;
  }
  if (recentStart <= 0) return null;

  // Stage 1 (free): hide bulky old tool outputs before paying for an LLM summary call.
  if (!options.force) {
    const microCount = microCompactOlderToolResults(rest, recentStart);
    if (microCount > 0) {
      const tokensAfterMicro = estimateSessionTokens(session);
      if (tokensAfterMicro <= maxTokens) {
        await session.save();
        return {
          summary: `Скрыты старые выводы инструментов (${microCount}) для экономии токенов.`,
          removedMessages: 0,
          tokensBefore,
          tokensAfter: tokensAfterMicro,
          mode: 'micro',
        };
      }
    }
  }

  const older = rest.slice(0, recentStart);
  const recent = rest.slice(recentStart);
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
    mode: 'summary',
  };
}
