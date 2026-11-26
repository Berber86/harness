import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createBashTool, createReadTool, createWriteTool, validateArguments } from '../src/index.js';
import type { ToolContext } from '../src/index.js';

async function setup() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'harness-tools-'));
  const tracked: string[] = [];
  const context: ToolContext = {
    cwd,
    trackFile: (filePath) => {
      tracked.push(filePath);
    },
  };
  return { cwd, context, tracked, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test('read and write tools work inside the workspace', async () => {
  const { cwd, context, tracked, cleanup } = await setup();
  try {
    const write = createWriteTool();
    const result = await write.execute({ path: 'src/main.ts', content: 'export const x = 1;\n' }, context);
    assert.match(String(result), /Wrote src\/main\.ts/);
    assert.deepEqual(tracked, ['src/main.ts']);
    assert.equal(await readFile(path.join(cwd, 'src', 'main.ts'), 'utf8'), 'export const x = 1;\n');

    const read = createReadTool();
    assert.equal(await read.execute({ path: 'src/main.ts' }, context), 'export const x = 1;\n');
  } finally {
    await cleanup();
  }
});

test('tools reject paths outside the workspace, including symlinks', async () => {
  const { cwd, context, cleanup } = await setup();
  try {
    const outside = path.join(tmpdir(), `harness-outside-${Date.now()}.txt`);
    await writeFile(outside, 'secret', 'utf8');
    await symlink(outside, path.join(cwd, 'link.txt'));
    const read = createReadTool();
    await assert.rejects(read.execute({ path: '../outside.txt' }, context), /escapes workspace/);
    await assert.rejects(read.execute({ path: 'link.txt' }, context), /escapes workspace/);
    await rm(outside, { force: true });
  } finally {
    await cleanup();
  }
});

test('bash tool runs commands in the workspace and reports failures', async () => {
  const { cwd, context, cleanup } = await setup();
  try {
    const bash = createBashTool();
    const ok = await bash.execute({ command: 'printf hello' }, context);
    assert.match(String(ok), /hello/);
    const failed = await bash.execute({ command: 'exit 7' }, context);
    assert.equal(typeof failed, 'object');
    assert.equal((failed as { isError?: boolean }).isError, true);
  } finally {
    await cleanup();
  }
});

test('validateArguments checks required fields and primitive types', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  };
  assert.deepEqual(validateArguments(schema, { path: 'a', content: 'b' }), []);
  assert.deepEqual(validateArguments(schema, { path: 3 }), [
    'arguments.content is required',
    'arguments.path must be a string',
  ]);
});
