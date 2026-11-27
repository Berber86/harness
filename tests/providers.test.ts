import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicProvider, openaiCompatibleProvider, toOpenAIMessages } from '../src/index.js';
import type { ProviderStreamEvent } from '../src/index.js';
import { collect } from './helpers.js';

function sseResponse(chunks: Array<[string, unknown]>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const [event, payload] of chunks) {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const model = { provider: 'openai', model: 'test-model' };
const messages = [
  { id: 's', role: 'system' as const, content: 'Be concise', createdAt: 0 },
  { id: 'u', role: 'user' as const, content: 'Hello', createdAt: 0 },
];
const tools = [
  {
    name: 'write',
    description: 'Write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

test('OpenAI-compatible provider normalizes text, tool deltas and usage', async () => {
  let captured: { url: string; body: any; headers: any } | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    captured = {
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: init?.headers as Record<string, string>,
    };
    return sseResponse([
      ['message', { choices: [{ delta: { content: 'Hi' }, index: 0 }] }],
      ['message', { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write', arguments: '{"pa' } }] }, index: 0 }] }],
      ['message', { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }, index: 0 }] }],
      ['message', { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }],
      ['message', { usage: { prompt_tokens: 12, completion_tokens: 7 }, choices: [] }],
      ['message', '[DONE]'],
    ]);
  };
  const provider = openaiCompatibleProvider({
    apiKey: 'test-key',
    baseURL: 'https://example.test/v1',
    fetch: fakeFetch,
  });
  const events = await collect(provider.chat({ model, messages, tools }));

  assert.equal(captured?.url, 'https://example.test/v1/chat/completions');
  assert.equal(captured?.headers.authorization, 'Bearer test-key');
  assert.equal(captured?.body.messages[0].role, 'system');
  assert.equal(captured?.body.tools[0].type, 'function');
  assert.deepEqual(
    events.map((event) => event.type),
    ['text_delta', 'tool_call', 'tool_call', 'done'],
  );
  assert.equal(events[0]?.type === 'text_delta' && events[0].text, 'Hi');
  const second = events[1];
  assert.ok(second?.type === 'tool_call' && second.id === 'c1' && second.name === 'write');
  assert.ok(second.type === 'tool_call' && second.argumentsDelta === '{"pa');
  const third = events[2];
  assert.ok(third?.type === 'tool_call' && third.argumentsDelta === 'th":"a.txt"}');
  const doneEvent = events.at(-1);
  assert.ok(doneEvent?.type === 'done' && doneEvent.stopReason === 'tool_use');
  assert.deepEqual(doneEvent.usage, { inputTokens: 12, outputTokens: 7 });
});

test('Anthropic provider maps content blocks, tool inputs and stop reason', async () => {
  let captured: { url: string; body: any; headers: any } | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    captured = {
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: init?.headers as Record<string, string>,
    };
    return sseResponse([
      ['message_start', { message: { usage: { input_tokens: 20 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't1', name: 'write' } }],
      ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } }],
      ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }],
    ]);
  };
  const provider = anthropicProvider({ apiKey: 'secret', fetch: fakeFetch });
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.chat({
    model: { provider: 'anthropic', model: 'claude-test' },
    messages,
    tools,
  })) {
    events.push(event);
  }

  assert.equal(captured?.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured?.headers['x-api-key'], 'secret');
  assert.equal(captured?.body.system, 'Be concise');
  assert.equal(captured?.body.tools[0].input_schema.type, 'object');
  assert.deepEqual(events.map((event) => event.type), ['tool_call', 'tool_call', 'done']);
  const first = events[0];
  assert.ok(first?.type === 'tool_call' && first.id === 't1' && first.name === 'write');
  const doneEvent = events.at(-1);
  assert.ok(doneEvent?.type === 'done' && doneEvent.stopReason === 'tool_use');
  assert.deepEqual(doneEvent.usage, { inputTokens: 20, outputTokens: 9 });
});

test('provider reports HTTP errors as error events', async () => {
  const fakeFetch: typeof fetch = async () => new Response('bad key', { status: 401 });
  const provider = anthropicProvider({ apiKey: 'wrong', fetch: fakeFetch });
  const events = await collect(provider.chat({ model, messages, tools: [] }));
  assert.equal(events.length, 1);
  assert.ok(events[0]?.type === 'error' && /401/.test(events[0].error.message));
});

test('OpenAI-compatible provider retries transient fetch failed errors and exposes cause on persistent failure', async () => {
  let calls = 0;
  let retryHeaders: Record<string, string> | undefined;
  const recoveringFetch: typeof fetch = async (_input, init) => {
    calls++;
    if (calls === 1) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }),
      });
    }
    retryHeaders = init?.headers as Record<string, string>;
    return sseResponse([
      ['message', { choices: [{ delta: { content: 'Recovered' }, index: 0 }] }],
      ['message', { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }],
      ['message', '[DONE]'],
    ]);
  };
  const okProvider = openaiCompatibleProvider({ apiKey: 'k', fetch: recoveringFetch });
  const okEvents = await collect(okProvider.chat({ model, messages, tools: [] }));
  assert.equal(calls, 2);
  assert.equal(retryHeaders?.connection, 'close');
  assert.equal(okEvents[0]?.type === 'text_delta' && okEvents[0].text, 'Recovered');

  const failingFetch: typeof fetch = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
    });
  };
  const failProvider = openaiCompatibleProvider({ apiKey: 'k', fetch: failingFetch });
  const failEvents = await collect(failProvider.chat({ model, messages, tools: [] }));
  assert.equal(failEvents.length, 1);
  assert.ok(
    failEvents[0]?.type === 'error' &&
      /fetch failed/.test(failEvents[0].error.message) &&
      /ETIMEDOUT/.test(failEvents[0].error.message),
  );
});

test('toOpenAIMessages converts mid-conversation system updates into system-reminder user messages', () => {
  const mapped = toOpenAIMessages([
    { id: 's0', role: 'system', content: 'HEAD', createdAt: 0 },
    { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
    { id: 's1', role: 'system', content: 'MODE: ACT', createdAt: 2 },
    { id: 'u2', role: 'user', content: 'do it', createdAt: 3 },
  ]);
  assert.equal(mapped[0]?.role, 'system');
  assert.equal(mapped[1]?.role, 'user');
  assert.equal(mapped[2]?.role, 'user');
  assert.match(String(mapped[2]?.content), /<system-reminder>[\s\S]*MODE: ACT/);
});
