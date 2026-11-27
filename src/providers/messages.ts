import type { Message } from '../types.js';

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown };

/** Converts universal messages to Anthropic's system + content-block format. */
export function toAnthropicMessages(messages: Message[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const result: AnthropicMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      const results = [];
      while (i < messages.length && messages[i]?.role === 'tool') {
        const toolMessage = messages[i]!;
        for (const toolResult of toolMessage.toolResults ?? []) {
          results.push({
            type: 'tool_result',
            tool_use_id: toolResult.toolCallId,
            content: toolResult.content,
            is_error: toolResult.isError ?? false,
          });
        }
        i++;
      }
      i--;
      if (results.length) result.push({ role: 'user', content: results });
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      result.push({ role: 'assistant', content: blocks.length ? blocks : '' });
      continue;
    }
    result.push({ role: 'user', content: message.content || ' ' });
  }

  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    messages: result,
  };
}

/** Converts universal messages to the OpenAI-compatible chat format. */
export function toOpenAIMessages(messages: Message[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  let seenConversation = false;
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        if (seenConversation) {
          // Many OpenAI-compatible gateways reject mid-conversation system roles.
          result.push({ role: 'user', content: `<system-reminder>\n${message.content}\n</system-reminder>` });
        } else {
          result.push({ role: 'system', content: message.content });
        }
        break;
      case 'user':
        seenConversation = true;
        result.push({ role: 'user', content: message.content });
        break;
      case 'assistant':
        seenConversation = true;
        result.push({
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        });
        break;
      case 'tool':
        seenConversation = true;
        for (const toolResult of message.toolResults ?? []) {
          result.push({
            role: 'tool',
            tool_call_id: toolResult.toolCallId,
            content: toolResult.content,
          });
        }
        break;
    }
  }
  return result;
}
