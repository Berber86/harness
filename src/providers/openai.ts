import type { ChatRequest, ModelProvider, ProviderStreamEvent, StopReason, Usage } from '../types.js';
import { toOpenAIMessages } from './messages.js';
import { parseSSE } from './sse.js';

export interface OpenAICompatibleOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}

const STOP_REASONS: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'error',
};

/**
 * OpenAI-compatible streaming API. Works with OpenAI, OpenRouter, Ollama and
 * any local server exposing /chat/completions.
 */
export function openaiCompatibleProvider(options: OpenAICompatibleOptions = {}): ModelProvider {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const baseURL = (options.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    name: 'openai-compatible',
    async *chat(request: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const body: Record<string, unknown> = {
        model: request.model.model,
        messages: toOpenAIMessages(request.messages),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (request.model.maxTokens !== undefined) body.max_tokens = request.model.maxTokens;
      if (request.model.temperature !== undefined) body.temperature = request.model.temperature;
      if (request.tools.length) {
        body.tools = request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }

      let response: Response;
      try {
        response = await fetchImpl(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        yield { type: 'error', error: error instanceof Error ? error : new Error(String(error)) };
        return;
      }
      if (!response.ok) {
        yield {
          type: 'error',
          error: new Error(`OpenAI-compatible API ${response.status}: ${(await response.text()).slice(0, 2000)}`),
        };
        return;
      }

      let finishReason: StopReason = 'stop';
      let usage: Usage | undefined;
      try {
        for await (const event of parseSSE(response)) {
          if (event.data === '[DONE]') break;
          let payload: Record<string, any>;
          try {
            payload = JSON.parse(event.data);
          } catch {
            continue;
          }
          if (payload.error) {
            yield { type: 'error', error: new Error(payload.error.message ?? 'Stream error') };
            return;
          }
          if (payload.usage) {
            usage = {
              inputTokens: payload.usage.prompt_tokens,
              outputTokens: payload.usage.completion_tokens,
            };
          }
          const choice = payload.choices?.[0];
          if (!choice) continue;
          for (const delta of choice.delta?.tool_calls ?? []) {
            yield {
              type: 'tool_call',
              index: delta.index ?? 0,
              id: delta.id,
              name: delta.function?.name,
              argumentsDelta: delta.function?.arguments,
            };
          }
          if (typeof choice.delta?.content === 'string' && choice.delta.content) {
            yield { type: 'text_delta', text: choice.delta.content };
          }
          if (choice.finish_reason) {
            finishReason = STOP_REASONS[choice.finish_reason] ?? 'end_turn';
          }
        }
      } catch (error) {
        yield { type: 'error', error: error instanceof Error ? error : new Error(String(error)) };
        return;
      }
      yield { type: 'done', stopReason: finishReason, usage };
    },
  };
}
