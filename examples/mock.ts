/**
 * Runs the whole harness with a fake provider — no API key needed.
 * `npm run demo`
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../src/index.js';
import type { ModelProvider, ProviderStreamEvent, ToolCall } from '../src/index.js';

const demoProvider: ModelProvider = {
  name: 'demo',
  async *chat({ messages }): AsyncGenerator<ProviderStreamEvent> {
    const toolResultSeen = messages.some((message) => message.role === 'tool');
    if (!toolResultSeen) {
      const call: ToolCall = {
        id: 'demo-call-1',
        name: 'write',
        arguments: { path: 'hello.txt', content: 'Hello from harness!\n' },
      };
      yield { type: 'tool_call', index: 0, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments) };
      yield { type: 'done', stopReason: 'tool_use' };
    } else {
      for (const word of ['Файл ', 'создан.']) yield { type: 'text_delta', text: word };
      yield { type: 'done', stopReason: 'end_turn' };
    }
  },
};

const cwd = await mkdtemp(path.join(tmpdir(), 'harness-demo-'));
try {
  const agent = new Agent({
    model: { provider: 'demo', model: 'demo-model' },
    provider: demoProvider,
    cwd,
    sessionDir: path.join(cwd, 'sessions'),
    systemPrompt: 'You are a concise coding agent.',
  });

  for await (const event of agent.stream('Создай hello.txt')) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text);
        break;
      case 'tool_start':
        console.log(`\n→ tool ${event.call.name}(${JSON.stringify(event.call.arguments)})`);
        break;
      case 'tool_end':
        console.log(`← ${event.result.content}`);
        break;
      case 'compacted':
        console.log(`\n[context compacted: removed ${event.removedMessages} messages]`);
        break;
      case 'checkpoint':
        console.log(`\n[checkpoint ${event.checkpointId}]`);
        break;
      case 'done':
        console.log(`\n[done: ${event.result.stopReason}, ${event.result.turns} turn(s)]`);
        break;
    }
  }

  const session = await agent.getSession();
  const checkpoint = session.checkpoints.at(-1);
  console.log(`\nhello.txt: ${JSON.stringify(await readFile(path.join(cwd, 'hello.txt'), 'utf8'))}`);
  if (checkpoint) {
    await agent.rollback(checkpoint.id);
    console.log(`after rollback: ${checkpoint.changes.length} file change(s) reverted, messages: ${session.messages.length}`);
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
