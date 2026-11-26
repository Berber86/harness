import type { ContextOptions } from '../session/context.js';
import { compactIfNeeded } from '../session/context.js';
import { CheckpointTracker } from '../session/checkpoint.js';
import type { Session } from '../session/session.js';
import type {
  AgentEvent,
  AgentResult,
  Message,
  ModelConfig,
  ModelProvider,
  StopReason,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  Usage,
} from '../types.js';
import { newId, toError, validateArguments } from '../utils.js';

export type AuthorizeHandler = (call: ToolCall) => boolean | Promise<boolean>;

export interface LoopDetectionOptions {
  /** Disable automatic loop protection when set to false. Default: true. */
  enabled?: boolean;
  /** Stop if the same tool call signature repeats this many consecutive turns. Default: 3. */
  maxRepeatedCalls?: number;
  /** Stop if a failing tool call signature repeats this many consecutive turns. Default: 2. */
  maxRepeatedFailures?: number;
  /** Stop after this many consecutive turns where every tool call failed. Default: 3. */
  maxConsecutiveErrors?: number;
}

export interface AgentLoopOptions {
  session: Session;
  prompt: string;
  provider: ModelProvider;
  model: ModelConfig;
  tools: Tool[];
  cwd: string;
  systemPrompt?: string;
  maxTurns?: number;
  context?: ContextOptions;
  loopDetection?: LoopDetectionOptions;
  signal?: AbortSignal;
  authorize?: AuthorizeHandler;
  /** Optional shared file-tracking hook (used by subagents so parent checkpoints capture their writes). */
  trackFile?: (filePath: string) => Promise<void> | void;
  /** Whether to finalize a checkpoint on this session at the end of the run. Default: true. */
  checkpoint?: boolean;
}

interface PendingCall {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

function failedResult(call: ToolCall, content: string): ToolResult {
  return { toolCallId: call.id, name: call.name, content, isError: true };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function callSignature(calls: ToolCall[]): string {
  return JSON.stringify(calls.map((call) => ({ name: call.name, arguments: canonicalValue(call.arguments) })));
}

/**
 * Low-level agent loop: one `AgentEvent` stream per user prompt.
 * UI/CLI layers can render these events however they like.
 */
export async function* runAgentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const {
    session,
    prompt,
    provider,
    model,
    tools,
    cwd,
    maxTurns = 20,
    context,
    loopDetection,
    signal,
    authorize,
  } = options;
  const loopEnabled = loopDetection?.enabled !== false;
  const maxRepeatedCalls = Math.max(2, loopDetection?.maxRepeatedCalls ?? 3);
  const maxRepeatedFailures = Math.max(2, loopDetection?.maxRepeatedFailures ?? 2);
  const maxConsecutiveErrors = Math.max(2, loopDetection?.maxConsecutiveErrors ?? 3);
  let previousSignature: string | null = null;
  let repeatedCount = 0;
  let previousTurnFailed = false;
  let consecutiveErrorTurns = 0;
  const tracker = options.checkpoint === false ? undefined : new CheckpointTracker(cwd, session);
  const trackFile = options.trackFile ?? ((filePath: string) => tracker?.track(filePath));
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  const toolDefinitions = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const usage: Usage = {};
  const systemPrompt = options.systemPrompt;

  const existingSystem = session.messages.find((message) => message.meta?.kind === 'system_prompt');
  if (systemPrompt) {
    if (!existingSystem) {
      session.addMessage({
        id: newId(),
        role: 'system',
        content: systemPrompt,
        createdAt: Date.now(),
        meta: { kind: 'system_prompt' },
      });
      await session.save();
    } else if (existingSystem.content !== systemPrompt) {
      existingSystem.content = systemPrompt;
      await session.save();
    }
  }
  session.addMessage({ id: newId(), role: 'user', content: prompt, createdAt: Date.now() });
  await session.save();
  yield { type: 'run_start', sessionId: session.id, prompt };

  let turns = 0;
  let lastText = '';
  let stopReason: StopReason = 'end_turn';
  let failed = false;
  let hasMoreTools = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      stopReason = 'error';
      failed = true;
      yield { type: 'error', error: new Error('Run aborted') };
      break;
    }
    turns = turn + 1;

    try {
      const compaction = await compactIfNeeded(session, provider, model, context);
      if (compaction) {
        yield {
          type: 'compacted',
          summary: compaction.summary,
          removedMessages: compaction.removedMessages,
        };
      }
    } catch (error) {
      failed = true;
      stopReason = 'error';
      yield { type: 'error', error: toError(error) };
      break;
    }

    const messageId = newId();
    const pending = new Map<number, PendingCall>();
    let text = '';
    let streamError: Error | undefined;
    let streamStop: StopReason = 'end_turn';

    try {
      for await (const event of provider.chat({ model, messages: session.messages, tools: toolDefinitions, signal })) {
        switch (event.type) {
          case 'text_delta':
            text += event.text;
            yield { type: 'text_delta', text: event.text, messageId };
            break;
          case 'tool_call': {
            let call = pending.get(event.index);
            if (!call) {
              call = { index: event.index, arguments: '' };
              pending.set(event.index, call);
            }
            if (event.id) call.id = event.id;
            if (event.name) call.name = event.name;
            if (event.argumentsDelta) call.arguments += event.argumentsDelta;
            break;
          }
          case 'done':
            streamStop = event.stopReason;
            if (event.usage?.inputTokens !== undefined) {
              usage.inputTokens = (usage.inputTokens ?? 0) + event.usage.inputTokens;
            }
            if (event.usage?.outputTokens !== undefined) {
              usage.outputTokens = (usage.outputTokens ?? 0) + event.usage.outputTokens;
            }
            break;
          case 'error':
            streamError = event.error;
            break;
        }
      }
    } catch (error) {
      streamError = toError(error);
    }

    if (streamError) {
      failed = true;
      stopReason = 'error';
      yield { type: 'error', error: streamError };
    } else {
      stopReason = streamStop;
    }
    lastText = text;

    const invalidArguments = new Map<string, string>();
    const calls: ToolCall[] = [...pending.values()]
      .sort((a, b) => a.index - b.index)
      .map((entry) => {
        const id = entry.id ?? `tool-${newId()}`;
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = entry.arguments ? JSON.parse(entry.arguments) : {};
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('tool arguments must be a JSON object');
          }
          args = parsed as Record<string, unknown>;
        } catch (error) {
          invalidArguments.set(id, toError(error).message);
        }
        return { id, name: entry.name ?? 'unknown', arguments: args };
      });

    const assistantMessage: Message = {
      id: messageId,
      role: 'assistant',
      content: text,
      ...(calls.length ? { toolCalls: calls } : {}),
      createdAt: Date.now(),
      meta: { stopReason },
    };
    session.addMessage(assistantMessage);
    await session.save();
    yield { type: 'message', message: assistantMessage };

    hasMoreTools = calls.length > 0 && !failed;
    if (!hasMoreTools) break;

    const signature = callSignature(calls);
    repeatedCount = signature === previousSignature ? repeatedCount + 1 : 1;
    previousSignature = signature;

    let loopReason: string | undefined;
    if (loopEnabled) {
      if (previousTurnFailed && repeatedCount >= maxRepeatedFailures) {
        loopReason = `Repeated failing tool call (${calls.map((c) => c.name).join(', ')}) ${repeatedCount} times in a row`;
      } else if (repeatedCount >= maxRepeatedCalls) {
        loopReason = `Repeated identical tool call (${calls.map((c) => c.name).join(', ')}) ${repeatedCount} times in a row`;
      }
    }
    if (loopReason) {
      for (const call of calls) {
        const skipped = failedResult(call, `Stopped by loop protection: ${loopReason}`);
        const toolMessage: Message = {
          id: newId(),
          role: 'tool',
          content: skipped.content,
          toolResults: [skipped],
          createdAt: Date.now(),
        };
        session.addMessage(toolMessage);
        await session.save();
        yield { type: 'message', message: toolMessage };
      }
      stopReason = 'loop_detected';
      hasMoreTools = false;
      yield { type: 'loop_detected', reason: loopReason };
      break;
    }

    let turnAllErrors = true;
    for (const call of calls) {
      yield { type: 'tool_start', call };
      let result: ToolResult;
      const tool = toolByName.get(call.name);
      const parseError = invalidArguments.get(call.id);
      try {
        if (parseError) {
          result = failedResult(call, `Invalid tool arguments: ${parseError}`);
        } else if (!tool) {
          result = failedResult(call, `Unknown tool: ${call.name}`);
        } else if (authorize && !(await authorize(call))) {
          result = failedResult(call, `Tool ${call.name} was rejected by policy`);
        } else {
          const validationErrors = validateArguments(tool.parameters, call.arguments);
          if (validationErrors.length) {
            result = failedResult(call, `Invalid arguments: ${validationErrors.join('; ')}`);
          } else {
            const context: ToolContext = {
              cwd,
              signal,
              trackFile,
            };
            const output = await tool.execute(call.arguments as Record<string, never>, context);
            result =
              typeof output === 'string'
                ? { toolCallId: call.id, name: call.name, content: output }
                : {
                    toolCallId: call.id,
                    name: call.name,
                    content: output.content,
                    ...(output.isError ? { isError: true } : {}),
                  };
          }
        }
      } catch (error) {
        result = failedResult(call, `Tool ${call.name} failed: ${toError(error).message}`);
      }
      if (!result.isError) turnAllErrors = false;

      const toolMessage: Message = {
        id: newId(),
        role: 'tool',
        content: result.content,
        toolResults: [result],
        createdAt: Date.now(),
      };
      session.addMessage(toolMessage);
      await session.save();
      yield { type: 'tool_end', result };
      yield { type: 'message', message: toolMessage };
    }

    previousTurnFailed = turnAllErrors;
    consecutiveErrorTurns = turnAllErrors ? consecutiveErrorTurns + 1 : 0;
    if (loopEnabled && consecutiveErrorTurns >= maxConsecutiveErrors) {
      loopReason = `Tools failed ${consecutiveErrorTurns} turns in a row`;
      stopReason = 'loop_detected';
      hasMoreTools = false;
      yield { type: 'loop_detected', reason: loopReason };
      break;
    }
  }

  if (hasMoreTools && turns >= maxTurns) stopReason = 'max_turns';
  let checkpointId: string | undefined;
  if (tracker) {
    const checkpoint = await tracker.finalize(session, prompt.slice(0, 120));
    checkpointId = checkpoint.id;
    yield { type: 'checkpoint', checkpointId };
  }
  yield {
    type: 'done',
    result: {
      sessionId: session.id,
      text: lastText,
      messages: session.messages,
      turns,
      usage,
      stopReason,
      ...(checkpointId ? { checkpointId } : {}),
    },
  };
}
