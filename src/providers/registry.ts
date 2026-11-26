import type { ModelConfig, ModelProvider } from '../types.js';
import { anthropicProvider } from './anthropic.js';
import { openaiCompatibleProvider } from './openai.js';

/** Built-in providers can be replaced or extended via `AgentOptions.providers`. */
export function resolveProvider(
  model: ModelConfig,
  providers: Record<string, ModelProvider> = {},
): ModelProvider {
  const custom = providers[model.provider];
  if (custom) return custom;

  switch (model.provider) {
    case 'anthropic':
      return anthropicProvider({ apiKey: model.apiKey, baseURL: model.baseURL });
    case 'openai':
      return openaiCompatibleProvider({ apiKey: model.apiKey, baseURL: model.baseURL });
    case 'openrouter':
      return openaiCompatibleProvider({
        apiKey: model.apiKey ?? process.env.OPENROUTER_API_KEY,
        baseURL: model.baseURL ?? 'https://openrouter.ai/api/v1',
      });
    case 'ollama':
      return openaiCompatibleProvider({
        apiKey: model.apiKey ?? 'ollama',
        baseURL: model.baseURL ?? 'http://127.0.0.1:11434/v1',
      });
    default:
      throw new Error(
        `Unknown provider "${model.provider}". Pass it in AgentOptions.providers or use one of: anthropic, openai, openrouter, ollama`,
      );
  }
}
