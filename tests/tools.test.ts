import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createBashTool,
  createEditTool,
  createListFilesTool,
  createReadTool,
  createSearchTool,
  createWriteTool,
  validateArguments,
} from '../src/index.js';
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

test('read supports offset and limit line ranges', async () => {
  const { cwd, context, cleanup } = await setup();
  try {
    await writeFile(path.join(cwd, 'lines.txt'), 'a\nb\nc\nd\ne\n', 'utf8');
    const read = createReadTool();
    const slice = await read.execute({ path: 'lines.txt', offset: 2, limit: 3 }, context);
    assert.equal(slice, '[Lines 2-4 of 6 in lines.txt]\n2: b\n3: c\n4: d');
  } finally {
    await cleanup();
  }
});

test('edit performs exact single-match replacements, handles CRLF and tracks files', async () => {
  const { cwd, context, tracked, cleanup } = await setup();
  try {
    await writeFile(path.join(cwd, 'code.ts'), 'const a = 1;\nconst b = 1;\n', 'utf8');
    const edit = createEditTool();

    const ok = await edit.execute({ path: 'code.ts', oldText: 'const a = 1;', newText: 'const a = 42;' }, context);
    assert.match(String(ok), /Edited code\.ts/);
    assert.deepEqual(tracked, ['code.ts']);
    assert.equal(await readFile(path.join(cwd, 'code.ts'), 'utf8'), 'const a = 42;\nconst b = 1;\n');

    const missing = await edit.execute({ path: 'code.ts', oldText: 'const z = 9;', newText: 'x' }, context);
    assert.equal((missing as { isError?: boolean }).isError, true);

    await writeFile(path.join(cwd, 'dup.txt'), 'foo\nfoo\n', 'utf8');
    const dup = await edit.execute({ path: 'dup.txt', oldText: 'foo', newText: 'bar' }, context);
    assert.equal((dup as { isError?: boolean }).isError, true);

    await writeFile(path.join(cwd, 'win.txt'), 'line1\r\nline2\r\n', 'utf8');
    const crlf = await edit.execute({ path: 'win.txt', oldText: 'line1\nline2', newText: 'line1\nupdated' }, context);
    assert.match(String(crlf), /Edited win\.txt/);
    assert.equal(await readFile(path.join(cwd, 'win.txt'), 'utf8'), 'line1\r\nupdated\r\n');
  } finally {
    await cleanup();
  }
});

test('list_files and search work cross-platform and skip ignored folders', async () => {
  const { cwd, context, cleanup } = await setup();
  try {
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await mkdir(path.join(cwd, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(cwd, 'README.md'), 'Hello world\n', 'utf8');
    await writeFile(path.join(cwd, 'src', 'app.ts'), 'export function greet() {\n  return "Hello";\n}\n', 'utf8');
    await writeFile(path.join(cwd, 'node_modules', 'pkg', 'index.js'), 'Hello ignored\n', 'utf8');
    await writeFile(path.join(cwd, 'bin.dat'), Buffer.from([0, 1, 2, 72, 101, 108, 108, 111]));

    const listFiles = createListFilesTool();
    const listed = await listFiles.execute({}, context);
    assert.equal(listed, 'bin.dat\nREADME.md\nsrc/app.ts');

    const search = createSearchTool();
    const found = await search.execute({ query: 'hello' }, context);
    assert.equal(found, 'README.md:1: Hello world\nsrc/app.ts:2: return "Hello";');

    const exact = await search.execute({ query: 'hello', caseSensitive: true }, context);
    assert.equal(exact, 'No matches for "hello"');
  } finally {
    await cleanup();
  }
});
