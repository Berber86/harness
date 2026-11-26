import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAppServer } from '../src/server/app.js';
import type { ProviderStreamEvent } from '../src/index.js';
import { ScriptedProvider } from './helpers.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const text = (value: string): ProviderStreamEvent => ({ type: 'text_delta', text: value });
const done = (stopReason = 'end_turn'): ProviderStreamEvent => ({ type: 'done', stopReason });
const toolCall: ProviderStreamEvent = {
  type: 'tool_call',
  index: 0,
  id: 'call-1',
  name: 'write',
  argumentsDelta: JSON.stringify({ path: 'start.txt', content: 'изменённый текст' }),
};

test('web app serves the UI, chat stream, files and rollback', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'harness-web-workspace-'));
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'harness-web-sessions-'));
  await writeFile(path.join(workspaceDir, 'start.txt'), 'исходный текст', 'utf8');

  const modelsApi = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gidra-code-auto' }, { id: 'hydra-gpt-mini' }] }));
  });
  const modelsPort = await listen(modelsApi);

  const provider = new ScriptedProvider(
    [toolCall, done('tool_use')],
    [text('Готово, текст обновлён'), done()],
  );
  const server = createAppServer({
    workspaceDir,
    sessionDir,
    webDir: path.resolve(process.cwd(), 'web'),
    baseURL: `http://127.0.0.1:${modelsPort}/v1`,
    providerFactory: () => provider,
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Мой помощник/);

    const filesResponse = await fetch(`${base}/api/files`);
    const files = (await filesResponse.json()) as { files: Array<{ path: string }> };
    assert.deepEqual(files.files.map((file) => file.path), ['start.txt']);

    const modelsResponse = await fetch(`${base}/api/models`, { headers: { 'x-api-key': 'fake-key' } });
    const models = (await modelsResponse.json()) as { models: string[] };
    assert.deepEqual(models.models, ['gidra-code-auto', 'hydra-gpt-mini']);

    const chatResponse = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Обнови файл', apiKey: 'fake-key', model: 'gidra-code-auto' }),
    });
    assert.equal(chatResponse.status, 200);
    const raw = await chatResponse.text();
    const events = raw
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
    assert.deepEqual(events.map((event: { type: string }) => event.type), [
      'started', 'activity', 'activity', 'text', 'checkpoint', 'done',
    ]);
    assert.equal(await readFile(path.join(workspaceDir, 'start.txt'), 'utf8'), 'изменённый текст');

    const doneEvent = events.find((event: { type: string }) => event.type === 'done');
    assert.equal(doneEvent.result.changes[0].path, 'start.txt');
    assert.equal(doneEvent.result.changes[0].before, 'исходный текст');

    const rollbackResponse = await fetch(`${base}/api/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: doneEvent.result.sessionId,
        checkpointId: doneEvent.result.checkpointId,
      }),
    });
    assert.equal(rollbackResponse.status, 200);
    assert.equal(await readFile(path.join(workspaceDir, 'start.txt'), 'utf8'), 'исходный текст');

    const demoModels = await fetch(`${base}/api/models?demo=1`);
    assert.deepEqual((await demoModels.json()) as { models: string[] }, { models: ['demo-model'] });
    const demoResponse = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Покажи как работает демо', demo: true }),
    });
    assert.equal(demoResponse.status, 200);
    assert.match(await demoResponse.text(), /demo-note\.txt/);
    assert.match(await readFile(path.join(workspaceDir, 'demo-note.txt'), 'utf8'), /демо-режима/);
  } finally {
    await close(server);
    await close(modelsApi);
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test('web app sends a loop protection notice when the model repeats failing calls', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'harness-web-loop-ws-'));
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'harness-web-loop-sess-'));
  const provider = new ScriptedProvider(
    [
      {
        type: 'tool_call',
        index: 0,
        id: 'call-1',
        name: 'read',
        argumentsDelta: '{"path":"nope.txt"}',
      },
      done('tool_use'),
    ],
    [
      {
        type: 'tool_call',
        index: 0,
        id: 'call-2',
        name: 'read',
        argumentsDelta: '{"path":"nope.txt"}',
      },
      done('tool_use'),
    ],
  );
  const server = createAppServer({
    workspaceDir,
    sessionDir,
    webDir: path.resolve(process.cwd(), 'web'),
    providerFactory: () => provider,
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Прочитай файл', apiKey: 'fake-key', model: 'hydra-gpt-mini' }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text())
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
    const notice = events.find((event: { type: string }) => event.type === 'notice');
    assert.ok(notice);
    assert.match(notice.text, /защита от зацикливания/i);
    const doneEvent = events.find((event: { type: string }) => event.type === 'done');
    assert.equal(doneEvent.result.stopReason, 'loop_detected');
  } finally {
    await close(server);
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test('web app routes roles to separate LLM models and rolls back subagent changes', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'harness-web-roles-ws-'));
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'harness-web-roles-sess-'));
  const requestedModels: string[] = [];

  const leadProvider = new ScriptedProvider(
    [
      {
        type: 'tool_call',
        index: 0,
        id: 'lead-1',
        name: 'delegate',
        argumentsDelta: JSON.stringify({ role: 'coder', task: 'Создай hello.js' }),
      },
      done('tool_use'),
    ],
    [
      {
        type: 'tool_call',
        index: 0,
        id: 'lead-2',
        name: 'delegate',
        argumentsDelta: JSON.stringify({ role: 'reviewer', task: 'Проверь hello.js' }),
      },
      done('tool_use'),
    ],
    [text('Программист написал, а проверяющий проверил.'), done()],
  );
  const coderProvider = new ScriptedProvider(
    [
      {
        type: 'tool_call',
        index: 0,
        id: 'c-1',
        name: 'write',
        argumentsDelta: JSON.stringify({ path: 'hello.js', content: 'export const x = 1;\n' }),
      },
      done('tool_use'),
    ],
    [text('Код написан'), done()],
  );
  const reviewerProvider = new ScriptedProvider(
    [
      {
        type: 'tool_call',
        index: 0,
        id: 'r-1',
        name: 'read',
        argumentsDelta: JSON.stringify({ path: 'hello.js' }),
      },
      done('tool_use'),
    ],
    [text('Ошибок нет'), done()],
  );

  const server = createAppServer({
    workspaceDir,
    sessionDir,
    webDir: path.resolve(process.cwd(), 'web'),
    providerFactory: ({ model }) => {
      requestedModels.push(model);
      if (model === 'coder-llm') return coderProvider;
      if (model === 'reviewer-llm') return reviewerProvider;
      return leadProvider;
    },
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const rolesResp = await fetch(`${base}/api/roles`);
    assert.equal(rolesResp.status, 200);
    const rolesJson = (await rolesResp.json()) as { roles: Array<{ id: string }> };
    assert.ok(rolesJson.roles.some((r) => r.id === 'coder'));

    const chatResp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Сделай hello.js и проверь его',
        apiKey: 'fake-key',
        model: 'lead-llm',
        roles: [
          {
            id: 'coder',
            name: 'Программист',
            description: 'Пишет код',
            instructions: 'Пиши код',
            model: 'coder-llm',
            enabled: true,
            tools: ['read', 'write'],
          },
          {
            id: 'reviewer',
            name: 'Проверяющий',
            description: 'Проверяет код',
            instructions: 'Проверяй код',
            model: 'reviewer-llm',
            enabled: true,
            tools: ['read'],
          },
          {
            id: 'docs',
            name: 'Документалист',
            description: 'Пишет доки',
            instructions: 'Пиши доки',
            model: 'docs-llm-disabled',
            enabled: false,
            tools: ['read', 'write'],
          },
        ],
      }),
    });
    assert.equal(chatResp.status, 200);
    const events = (await chatResp.text())
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));

    assert.deepEqual(requestedModels, ['lead-llm', 'coder-llm', 'reviewer-llm']);
    assert.equal(await readFile(path.join(workspaceDir, 'hello.js'), 'utf8'), 'export const x = 1;\n');
    assert.ok(
      events.some(
        (e: { type: string; text?: string }) =>
          e.type === 'activity' && e.text?.includes('Передаю задачу: «Программист» (coder-llm)'),
      ),
    );
    assert.ok(
      events.some(
        (e: { type: string; text?: string }) =>
          e.type === 'activity' && e.text?.includes('↳ [Проверяющий] инструмент «read»'),
      ),
    );

    const doneEvent = events.find((e: { type: string }) => e.type === 'done');
    assert.equal(doneEvent.result.changes[0].path, 'hello.js');

    const rollbackResp = await fetch(`${base}/api/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: doneEvent.result.sessionId,
        checkpointId: doneEvent.result.checkpointId,
      }),
    });
    assert.equal(rollbackResp.status, 200);
    await assert.rejects(readFile(path.join(workspaceDir, 'hello.js')), { code: 'ENOENT' });
  } finally {
    await close(server);
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test('web app downloads individual workspace files and full zip archive safely', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'harness-web-dl-ws-'));
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'harness-web-dl-sess-'));
  await mkdir(path.join(workspaceDir, 'app'), { recursive: true });
  await writeFile(path.join(workspaceDir, 'app', 'main.py'), 'print("привет")\n', 'utf8');
  await writeFile(path.join(workspaceDir, 'notes.txt'), 'hello', 'utf8');

  const server = createAppServer({
    workspaceDir,
    sessionDir,
    webDir: path.resolve(process.cwd(), 'web'),
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const fileResp = await fetch(`${base}/api/download?path=${encodeURIComponent('app/main.py')}`);
    assert.equal(fileResp.status, 200);
    assert.match(fileResp.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal(await fileResp.text(), 'print("привет")\n');

    const escapeResp = await fetch(`${base}/api/download?path=${encodeURIComponent('../package.json')}`);
    assert.equal(escapeResp.status, 500);

    const zipResp = await fetch(`${base}/api/download-all`);
    assert.equal(zipResp.status, 200);
    assert.equal(zipResp.headers.get('content-type'), 'application/zip');
    const buf = Buffer.from(await zipResp.arrayBuffer());
    assert.equal(buf.readUInt32LE(0), 0x04034b50); // local file header
    // Decompress first entry (app/main.py) and verify exact contents.
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const compSize = buf.readUInt32LE(18);
    const name = buf.subarray(30, 30 + nameLen).toString('utf8');
    const dataOffset = 30 + nameLen + extraLen;
    const content = inflateRawSync(buf.subarray(dataOffset, dataOffset + compSize)).toString('utf8');
    assert.equal(name, 'app/main.py');
    assert.equal(content, 'print("привет")\n');
  } finally {
    await close(server);
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test('web app supports interactive ask_user SSE pause/resume and workspace website preview', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'harness-web-ask-ws-'));
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'harness-web-ask-sess-'));
  await writeFile(path.join(workspaceDir, 'index.html'), '<h1>Мой сайт</h1>', 'utf8');

  const provider = new ScriptedProvider(
    [
      {
        type: 'tool_call',
        index: 0,
        id: 'ask-1',
        name: 'ask_user',
        argumentsDelta: JSON.stringify({
          questions: [
            {
              id: 'theme',
              question: 'Какую тему выбрать?',
              options: [
                { id: 'light', label: 'Светлую' },
                { id: 'dark', label: 'Тёмную' },
              ],
            },
          ],
        }),
      },
      done('tool_use'),
    ],
    [text('Принял ваш выбор: Тёмную!'), done()],
  );

  const server = createAppServer({
    workspaceDir,
    sessionDir,
    webDir: path.resolve(process.cwd(), 'web'),
    providerFactory: () => provider,
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const previewResp = await fetch(`${base}/preview/`);
    assert.equal(previewResp.status, 200);
    assert.match(await previewResp.text(), /<h1>Мой сайт<\/h1>/);

    const escapePreview = await fetch(`${base}/preview/..%2Fpackage.json`);
    assert.equal(escapePreview.status, 404);

    const chatResp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Сделай сайт', apiKey: 'fake-key', model: 'gidra-code-auto' }),
    });
    assert.equal(chatResp.status, 200);
    const reader = chatResp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: Array<{ type: string; requestId?: string; text?: string; result?: { text: string } }> = [];

    let answered = false;
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        events.push(ev);
        if (ev.type === 'ask_user' && !answered) {
          answered = true;
          const ansResp = await fetch(`${base}/api/answer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: ev.requestId,
              answers: [{ questionId: 'theme', selectedOptionId: 'dark', customResponse: null }],
            }),
          });
          assert.equal(ansResp.status, 200);
        }
      }
    }

    assert.equal(answered, true);
    const doneEv = events.find((e) => e.type === 'done');
    assert.equal(doneEv?.result?.text, 'Принял ваш выбор: Тёмную!');
  } finally {
    await close(server);
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});
