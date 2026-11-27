import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agent, Session, buildLeadSystemPrompt, createDefaultTools, createDelegateTool } from '../src/index.js';
import type { AgentEvent, AgentRole, ProviderStreamEvent } from '../src/index.js';
import { MemoryStore, ScriptedProvider } from './helpers.js';

const text = (value: string): ProviderStreamEvent => ({ type: 'text_delta', text: value });
const done = (stopReason = 'end_turn'): ProviderStreamEvent => ({ type: 'done', stopReason });
const toolCall = (index: number, id: string, name: string, args: string): ProviderStreamEvent => ({
  type: 'tool_call',
  index,
  id,
  name,
  argumentsDelta: args,
});

async function setup() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'harness-agent-'));
  const store = new MemoryStore();
  const session = await Session.create({ store });
  return { cwd, store, session, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test('agent calls a write tool, streams events and rolls the run back', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const provider = new ScriptedProvider(
      [toolCall(0, 'call-1', 'write', '{"path":"nested/note.txt","content":"hello"}'), done('tool_use')],
      [text('Готово'), done()],
    );
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
      systemPrompt: 'You are a test agent',
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.stream('create a file')) events.push(event);

    const doneEvent = events.find((event) => event.type === 'done');
    assert.ok(doneEvent && doneEvent.type === 'done');
    assert.equal(doneEvent.result.stopReason, 'end_turn');
    assert.equal(doneEvent.result.text, 'Готово');
    assert.equal(doneEvent.result.turns, 2);
    assert.equal(await readFile(path.join(cwd, 'nested', 'note.txt'), 'utf8'), 'hello');
    assert.ok(events.some((event) => event.type === 'text_delta'));
    assert.ok(events.some((event) => event.type === 'tool_start'));
    assert.ok(events.some((event) => event.type === 'tool_end'));
    assert.equal(provider.requests[0]?.tools.length, 8);

    assert.equal(session.checkpoints.length, 1);
    const checkpoint = session.checkpoints[0]!;
    assert.equal(checkpoint.messageCount, 0);
    assert.deepEqual(
      checkpoint.changes.map((change) => change.path),
      ['nested/note.txt'],
    );
    assert.equal(checkpoint.changes[0]!.before, null);
    assert.equal(checkpoint.changes[0]!.after, 'hello');

    await agent.rollback(checkpoint.id);
    await assert.rejects(readFile(path.join(cwd, 'nested', 'note.txt')), { code: 'ENOENT' });
    assert.equal(session.messages.length, 0);
  } finally {
    await cleanup();
  }
});

test('checkpoint restores the previous contents of an overwritten file', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const target = path.join(cwd, 'file.txt');
    await writeFile(target, 'old content', 'utf8');
    const provider = new ScriptedProvider([
      toolCall(0, 'call-1', 'write', '{"path":"file.txt","content":"new content"}'),
      done('tool_use'),
    ]);
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
    });
    await agent.run('overwrite the file');
    assert.equal(await readFile(target, 'utf8'), 'new content');
    await agent.rollback(session.checkpoints[0]!.id);
    assert.equal(await readFile(target, 'utf8'), 'old content');
  } finally {
    await cleanup();
  }
});

test('authorize hook can deny a tool call', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const provider = new ScriptedProvider([
      toolCall(0, 'call-1', 'write', '{"path":"blocked.txt","content":"nope"}'),
      done('tool_use'),
    ]);
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
      authorize: () => false,
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.stream('try writing')) events.push(event);
    const toolEnd = events.find((event) => event.type === 'tool_end');
    assert.ok(toolEnd && toolEnd.type === 'tool_end');
    assert.equal(toolEnd.result.isError, true);
    assert.match(toolEnd.result.content, /rejected by policy/);
    await assert.rejects(readFile(path.join(cwd, 'blocked.txt')));
  } finally {
    await cleanup();
  }
});

test('context compaction summarizes old messages and keeps recent ones', async () => {
  const { session, cleanup } = await setup();
  try {
    for (let i = 0; i < 8; i++) {
      session.messages.push({
        id: `old-${i}`,
        role: 'user',
        content: 'word '.repeat(300),
        createdAt: Date.now(),
      });
    }
    const provider = new ScriptedProvider([text('A dense summary'), done()], [text('ok'), done()]);
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd: process.cwd(),
      context: { maxTokens: 500, keepRecent: 2 },
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.stream('continue')) events.push(event);
    const compacted = events.find((event) => event.type === 'compacted');
    assert.ok(compacted && compacted.type === 'compacted');
    assert.equal(compacted.summary, 'A dense summary');
    assert.ok(session.messages.some((message) => message.meta?.kind === 'compaction'));
    assert.ok(session.messages.length < 10);
    assert.equal(provider.requests.length, 2);
  } finally {
    await cleanup();
  }
});

test('agent stops after maxTurns while tools keep being requested', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const scripts = Array.from({ length: 3 }, () => [
      toolCall(0, 'call-1', 'bash', '{"command":"echo hi"}'),
      done('tool_use'),
    ]);
    const provider = new ScriptedProvider(...scripts);
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
      maxTurns: 2,
    });
    const result = await agent.run('run a command');
    assert.equal(result.stopReason, 'max_turns');
    assert.equal(result.turns, 2);
    assert.equal(provider.requests.length, 2);
  } finally {
    await cleanup();
  }
});

test('malformed tool arguments produce an error result without crashing the run', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const provider = new ScriptedProvider(
      [toolCall(0, 'call-1', 'write', '{bad json'), done('tool_use')],
      [text('recovered'), done()],
    );
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
      tools: createDefaultTools(),
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.stream('bad call')) events.push(event);
    const toolEnd = events.find((event) => event.type === 'tool_end');
    assert.ok(toolEnd && toolEnd.type === 'tool_end');
    assert.equal(toolEnd.result.isError, true);
    assert.match(toolEnd.result.content, /Invalid tool arguments/);
    assert.equal(events.at(-1)?.type, 'done');
  } finally {
    await cleanup();
  }
});

test('loop protection stops repeated identical tool calls before running the 3rd repeat', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    await writeFile(path.join(cwd, 'a.txt'), 'hello', 'utf8');
    let executions = 0;
    const readTool = createDefaultTools()[0]!;
    const countedRead = {
      ...readTool,
      async execute(args: { path: string }, context: Parameters<typeof readTool.execute>[1]) {
        executions++;
        return readTool.execute(args, context);
      },
    };
    const scripts = Array.from({ length: 5 }, (_, i) => [
      toolCall(0, `call-${i}`, 'read', '{"path":"a.txt"}'),
      done('tool_use'),
    ]);
    const provider = new ScriptedProvider(...scripts);
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
      tools: [countedRead],
      maxTurns: 10,
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.stream('keep reading')) events.push(event);

    const loopEvent = events.find((event) => event.type === 'loop_detected');
    assert.ok(loopEvent && loopEvent.type === 'loop_detected');
    assert.match(loopEvent.reason, /Repeated identical tool call/);
    const doneEvent = events.find((event) => event.type === 'done');
    assert.ok(doneEvent && doneEvent.type === 'done');
    assert.equal(doneEvent.result.stopReason, 'loop_detected');
    assert.equal(doneEvent.result.turns, 3);
    assert.equal(executions, 2);

    // Every assistant tool call must have a matching tool result in session history.
    const toolCallIds = session.messages.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []);
    const toolResultIds = session.messages.flatMap((m) => m.toolResults?.map((r) => r.toolCallId) ?? []);
    assert.deepEqual(toolResultIds, toolCallIds);
  } finally {
    await cleanup();
  }
});

test('loop protection stops on the 2nd consecutive identical failing tool call', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const provider = new ScriptedProvider(
      [toolCall(0, 'call-1', 'read', '{"path":"missing.txt"}'), done('tool_use')],
      [toolCall(0, 'call-2', 'read', '{"path":"missing.txt"}'), done('tool_use')],
      [text('should not reach'), done()],
    );
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
    });
    const result = await agent.run('read missing');
    assert.equal(result.stopReason, 'loop_detected');
    assert.equal(result.turns, 2);
    assert.equal(provider.requests.length, 2);
  } finally {
    await cleanup();
  }
});

test('loop protection stops after consecutive failing turns even with different arguments', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const provider = new ScriptedProvider(
      [toolCall(0, 'call-1', 'read', '{"path":"missing-1.txt"}'), done('tool_use')],
      [toolCall(0, 'call-2', 'read', '{"path":"missing-2.txt"}'), done('tool_use')],
      [toolCall(0, 'call-3', 'read', '{"path":"missing-3.txt"}'), done('tool_use')],
      [text('should not reach'), done()],
    );
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
    });
    const result = await agent.run('try missing files');
    assert.equal(result.stopReason, 'loop_detected');
    assert.equal(result.turns, 3);
  } finally {
    await cleanup();
  }
});

test('loop protection does not trigger when another tool runs between reads', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const provider = new ScriptedProvider(
      [toolCall(0, 'call-1', 'write', '{"path":"a.txt","content":"v1"}'), done('tool_use')],
      [toolCall(0, 'call-2', 'read', '{"path":"a.txt"}'), done('tool_use')],
      [toolCall(0, 'call-3', 'write', '{"path":"a.txt","content":"v2"}'), done('tool_use')],
      [toolCall(0, 'call-4', 'read', '{"path":"a.txt"}'), done('tool_use')],
      [text('Готово'), done()],
    );
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
    });
    const result = await agent.run('edit and verify');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'Готово');
  } finally {
    await cleanup();
  }
});

test('loop protection can be disabled via loopDetection option', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    await writeFile(path.join(cwd, 'a.txt'), 'ok', 'utf8');
    const scripts = Array.from({ length: 4 }, (_, i) => [
      toolCall(0, `call-${i}`, 'read', '{"path":"a.txt"}'),
      done('tool_use'),
    ]);
    const provider = new ScriptedProvider(...scripts, [text('done anyway'), done()]);
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
      loopDetection: { enabled: false },
    });
    const result = await agent.run('repeat without protection');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.turns, 5);
  } finally {
    await cleanup();
  }
});

test('lead agent delegates to enabled role with separate model and parent checkpoint rolls back subagent writes', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const leadProvider = new ScriptedProvider(
      [
        toolCall(0, 'call-del', 'delegate', '{"role":"coder","task":"Create app.txt"}'),
        done('tool_use'),
      ],
      [text('Команда всё сделала'), done()],
    );
    const coderProvider = new ScriptedProvider(
      [
        toolCall(0, 'sub-1', 'write', '{"path":"app.txt","content":"console.log(1)"}'),
        done('tool_use'),
      ],
      [text('Файл app.txt создан'), done()],
    );
    const reviewerProvider = new ScriptedProvider([text('should never be called'), done()]);

    const roles: AgentRole[] = [
      {
        id: 'coder',
        name: 'Программист',
        description: 'Пишет код',
        instructions: 'Пиши код',
        model: { provider: 'scripted', model: 'cheap-coder' },
        enabled: true,
        tools: ['read', 'write'],
        provider: coderProvider,
      },
      {
        id: 'reviewer',
        name: 'Проверяющий',
        description: 'Проверяет код',
        instructions: 'Проверяй код',
        model: { provider: 'scripted', model: 'cheap-reviewer' },
        enabled: false,
        tools: ['read'],
        provider: reviewerProvider,
      },
    ];
    const activeRoles = roles.filter((role) => role.enabled);
    const delegateTool = createDelegateTool({ roles });

    const agent = new Agent({
      model: { provider: 'scripted', model: 'lead-model' },
      provider: leadProvider,
      tools: [...createDefaultTools(), delegateTool],
      systemPrompt: buildLeadSystemPrompt('Ты руководитель.', activeRoles),
      session,
      cwd,
    });

    const result = await agent.run('Сделай файл app.txt');
    assert.equal(result.text, 'Команда всё сделала');
    assert.equal(await readFile(path.join(cwd, 'app.txt'), 'utf8'), 'console.log(1)');
    assert.equal(coderProvider.requests[0]?.model.model, 'cheap-coder');
    assert.equal(coderProvider.requests[0]?.tools.map((t) => t.name).join(','), 'read,write');
    assert.equal(reviewerProvider.requests.length, 0);

    // Disabled role must not be advertised in the delegate schema.
    const delegateDef = leadProvider.requests[0]?.tools.find((t) => t.name === 'delegate');
    assert.deepEqual(delegateDef?.parameters.properties?.role?.enum, ['coder']);

    // Parent checkpoint captured the subagent write and rolls it back cleanly.
    assert.equal(session.checkpoints.length, 1);
    assert.deepEqual(session.checkpoints[0]?.changes.map((c) => c.path), ['app.txt']);
    await agent.rollback(session.checkpoints[0]!.id);
    await assert.rejects(readFile(path.join(cwd, 'app.txt')), { code: 'ENOENT' });
  } finally {
    await cleanup();
  }
});

test('delegate tool warns honestly instead of claiming success when a role hits max_turns', async () => {
  const { cwd, cleanup } = await setup();
  try {
    const coderProvider = new ScriptedProvider(
      [toolCall(0, 'c1', 'write', '{"path":"a.txt","content":"1"}'), done('tool_use')],
      [toolCall(0, 'c2', 'write', '{"path":"b.txt","content":"2"}'), done('tool_use')],
    );
    const delegateTool = createDelegateTool({
      roles: [
        {
          id: 'coder',
          name: 'Программист',
          description: 'Пишет код',
          instructions: 'Пиши код',
          model: { provider: 'scripted', model: 'cheap-coder' },
          enabled: true,
          tools: ['write'],
          maxTurns: 1,
          provider: coderProvider,
        },
      ],
    });

    const out = await delegateTool.execute(
      { role: 'coder', task: 'Сделай два файла' },
      { cwd, sessionId: 's1' },
    );
    const text = typeof out === 'string' ? out : out.content;
    assert.match(text, /статус: max_turns/);
    assert.match(text, /Работа прервана/);
    assert.doesNotMatch(text, /Задача выполнена/);
  } finally {
    await cleanup();
  }
});

test('truncated max_tokens tool JSON gives a chunking hint and recovers without false loop stop', async () => {
  const { cwd, session, cleanup } = await setup();
  try {
    const provider = new ScriptedProvider(
      [
        toolCall(0, 'call-1', 'write', '{"path":"cat.html","content":"<html>very long truncated...'),
        done('max_tokens'),
      ],
      [
        toolCall(0, 'call-2', 'write', '{"path":"cat.html","content":"<html>short skeleton'),
        done('max_tokens'),
      ],
      [
        toolCall(0, 'call-3', 'write', '{"path":"cat.html","content":"<html><body>ok</body></html>"}'),
        done('tool_use'),
      ],
      [text('Готово по частям!'), done()],
    );
    const agent = new Agent({
      model: { provider: 'scripted', model: 'mock' },
      provider,
      session,
      cwd,
    });
    const result = await agent.run('Сделай 3D модель');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'Готово по частям!');
    assert.equal(await readFile(path.join(cwd, 'cat.html'), 'utf8'), '<html><body>ok</body></html>');
    const firstToolMsg = session.messages.find((m) => m.role === 'tool');
    assert.match(firstToolMsg?.content ?? '', /max_tokens/);
    assert.match(firstToolMsg?.content ?? '', /каркас/);
  } finally {
    await cleanup();
  }
});
