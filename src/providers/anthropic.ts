import type { ChatRequest, ModelProvider, ProviderStreamEvent, StopReason } from '../types.js';
import { fetchWithRetry, formatNetworkError } from './fetch-retry.js';
import { toAnthropicMessages } from './messages.js';
import { parseSSE } from './sse.js';

export interface AnthropicOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'end_turn',
};

/** Anthropic Messages API with streaming and tool use. */
export function anthropicProvider(options: AnthropicOptions = {}): ModelProvider {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const baseURL = options.baseURL ?? 'https://api.anthropic.com/v1';
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    name: 'anthropic',
    async *chat(request: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      if (!apiKey) {
        yield { type: 'error', error: new Error('ANTHROPIC_API_KEY is not set') };
        return;
      }
      let pendingInputTokens: number | undefined;
      const { system, messages } = toAnthropicMessages(request.messages);
      const body: Record<string, unknown> = {
        model: request.model.model,
        messages,
        max_tokens: request.model.maxTokens ?? 8192,
        stream: true,
      };
      if (system) body.system = system;
      if (request.model.temperature !== undefined) body.temperature = request.model.temperature;
      if (request.tools.length) {
        body.tools = request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        }));
      }

      let response: Response;
      try {
        response = await fetchWithRetry(fetchImpl, `${baseURL}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey.trim(),
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        yield { type: 'error', error: formatNetworkError(error) };
        return;
      }
      if (!response.ok) {
        yield {
          type: 'error',
          error: new Error(`Anthropic API ${response.status}: ${(await response.text()).slice(0, 2000)}`),
        };
        return;
      }

      try {
        for await (const event of parseSSE(response)) {
          if (event.data === '[DONE]') break;
          let payload: Record<string, any>;
          try {
            payload = JSON.parse(event.data);
          } catch {
            continue;
          }
          switch (event.event) {
            case 'content_block_start': {
              const block = payload.content_block;
              if (block?.type === 'tool_use') {
                const hasInput = block.input && Object.keys(block.input).length > 0;
                yield {
                  type: 'tool_call',
                  index: payload.index as number,
                  id: block.id,
                  name: block.name,
                  argumentsDelta: hasInput ? JSON.stringify(block.input) : '',
                };
              }
              break;
            }
            case 'content_block_delta': {
              const delta = payload.delta;
              if (delta?.type === 'text_delta') yield { type: 'text_delta', text: delta.text ?? '' };
              if (delta?.type === 'input_json_delta') {
                yield {
                  type: 'tool_call',
                  index: payload.index as number,
                  argumentsDelta: delta.partial_json ?? '',
                };
              }
              break;
            }
            case 'message_start':
              pendingInputTokens = payload.message?.usage?.input_tokens;
              break;
            case 'message_delta':
              yield {
                type: 'done',
                stopReason: STOP_REASONS[payload.delta?.stop_reason] ?? payload.delta?.stop_reason ?? 'end_turn',
                usage: {
                  inputTokens: payload.usage?.input_tokens ?? pendingInputTokens,
                  outputTokens: payload.usage?.output_tokens,
                },
              };
              break;
            case 'error':
              yield { type: 'error', error: new Error(payload.error?.message ?? 'Anthropic stream error') };
              break;
          }
        }
      } catch (error) {
        yield { type: 'error', error: formatNetworkError(error) };
      }
    },
  };
}
