import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAppServer } from '../src/server/app.js';
import {
  applyGitHubUpdate,
  checkGitHubUpdate,
  parseGitHubSource,
  rollbackLatestUpdate,
} from '../src/server/updater.js';
import { buildZip, parseZip } from '../src/server/zip.js';

function listen(server: ReturnType<typeof createAppServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function close(server: ReturnType<typeof createAppServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('parseGitHubSource parses repo, tree branch (encoded), and zip links, and rejects non-GitHub hosts', () => {
  const repo = parseGitHubSource('Berber86/harness');
  assert.equal(repo.owner, 'Berber86');
  assert.equal(repo.repo, 'harness');
  assert.equal(repo.branch, null);
  assert.equal(repo.kind, 'repo');

  const branch = parseGitHubSource('https://github.com/Berber86/harness/tree/arena%2Faff222c8-harness');
  assert.equal(branch.owner, 'Berber86');
  assert.equal(branch.repo, 'harness');
  assert.equal(branch.branch, 'arena/aff222c8-harness');
  assert.equal(branch.kind, 'branch');

  const zip = parseGitHubSource('https://codeload.github.com/Berber86/harness/zip/refs/heads/main');
  assert.equal(zip.kind, 'zip');
  assert.equal(zip.branch, 'main');

  assert.throws(() => parseGitHubSource('https://evil.example.com/a/b'), /github\.com/);
});

test('parseZip round-trips buildZip and handles GitHub-style data descriptor headers', () => {
  const archive = buildZip([
    { name: 'repo-main/', data: Buffer.alloc(0) },
    { name: 'repo-main/hello.txt', data: Buffer.from('Привет, мир!', 'utf8') },
    { name: 'repo-main/sub/data.json', data: Buffer.from('{"ok":true}', 'utf8') },
  ]);
  const parsed = parseZip(archive);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.name, 'repo-main/hello.txt');
  assert.equal(parsed[0]!.data.toString('utf8'), 'Привет, мир!');
  assert.equal(parsed[1]!.name, 'repo-main/sub/data.json');

  // Simulate data-descriptor flag (0x0008) & zeroed local sizes (as codeload.github.com uses).
  const mutated = Buffer.from(archive);
  mutated.writeUInt16LE(0x0808, 6);
  mutated.writeUInt32LE(0, 14);
  mutated.writeUInt32LE(0, 18);
  mutated.writeUInt32LE(0, 22);
  const parsedDescriptor = parseZip(mutated);
  assert.equal(parsedDescriptor.length, 2);
});

test('applyGitHubUpdate protects workspace/secrets, backs up overwritten files, and rollback restores them', async () => {
  const appDir = await mkdtemp(path.join(tmpdir(), 'harness-updater-'));
  try {
    await mkdir(path.join(appDir, 'web'), { recursive: true });
    await mkdir(path.join(appDir, 'workspace'), { recursive: true });
    await mkdir(path.join(appDir, '.harness', 'sessions'), { recursive: true });

    await writeFile(path.join(appDir, 'web', 'app.js'), 'const ver = 1;\n', 'utf8');
    await writeFile(path.join(appDir, 'workspace', 'my-site.html'), '<h1>Мой проект</h1>', 'utf8');
    await writeFile(path.join(appDir, '.harness', 'sessions', 's1.json'), '{"id":"s1"}', 'utf8');
    await writeFile(path.join(appDir, '.env'), 'SECRET=keep', 'utf8');

    const updateZip = buildZip([
      { name: 'harness-test/web/app.js', data: Buffer.from('const ver = 2;\n', 'utf8') },
      { name: 'harness-test/src/added.ts', data: Buffer.from('export const x = 42;\n', 'utf8') },
      { name: 'harness-test/workspace/my-site.html', data: Buffer.from('<h1>SHOULD NOT OVERWRITE</h1>') },
      { name: 'harness-test/.env', data: Buffer.from('SECRET=wiped') },
    ]);

    const fetchFn = async (url: string) => {
      if (url.includes('/commits/')) {
        return new Response(
          JSON.stringify({
            sha: 'abc1234567890',
            commit: { message: 'Новая фича', committer: { date: '2026-11-26T10:00:00Z' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('codeload.github.com')) {
        return new Response(new Uint8Array(updateZip), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const check = await checkGitHubUpdate('https://github.com/Berber86/harness/tree/test-branch', appDir, fetchFn);
    assert.equal(check.hasUpdate, true);
    assert.equal(check.remoteSha, 'abc1234567890');
    assert.equal(check.remoteMessage, 'Новая фича');

    const applied = await applyGitHubUpdate('https://github.com/Berber86/harness/tree/test-branch', appDir, {
      fetchFn,
    });
    assert.equal(applied.filesWritten, 2);
    assert.deepEqual(applied.skippedProtected.sort(), ['.env', 'workspace/my-site.html']);
    assert.equal(await readFile(path.join(appDir, 'web', 'app.js'), 'utf8'), 'const ver = 2;\n');
    assert.equal(await readFile(path.join(appDir, 'src', 'added.ts'), 'utf8'), 'export const x = 42;\n');
    assert.equal(await readFile(path.join(appDir, 'workspace', 'my-site.html'), 'utf8'), '<h1>Мой проект</h1>');
    assert.equal(await readFile(path.join(appDir, '.env'), 'utf8'), 'SECRET=keep');

    const checkAfter = await checkGitHubUpdate('https://github.com/Berber86/harness/tree/test-branch', appDir, fetchFn);
    assert.equal(checkAfter.hasUpdate, false);

    const rolled = await rollbackLatestUpdate(appDir);
    assert.equal(rolled.filesRestored, 1);
    assert.equal(rolled.filesRemoved, 1);
    assert.equal(await readFile(path.join(appDir, 'web', 'app.js'), 'utf8'), 'const ver = 1;\n');
    await assert.rejects(readFile(path.join(appDir, 'src', 'added.ts')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(appDir, 'workspace', 'my-site.html'), 'utf8'), '<h1>Мой проект</h1>');
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

test('web app exposes /api/update/status, check, SSE apply, rollback and restart', async () => {
  const appDir = await mkdtemp(path.join(tmpdir(), 'harness-web-upd-'));
  await mkdir(path.join(appDir, 'web'), { recursive: true });
  await writeFile(path.join(appDir, 'web', 'index.html'), '<h1>v1</h1>', 'utf8');

  const updateZip = buildZip([
    { name: 'harness-main/web/index.html', data: Buffer.from('<h1>v2</h1>', 'utf8') },
  ]);
  let restarted = false;

  const server = createAppServer({
    appDir,
    webDir: path.resolve(process.cwd(), 'web'),
    onRestart: () => {
      restarted = true;
    },
    fetchFn: async (url) => {
      if (url.includes('/commits/')) {
        return new Response(
          JSON.stringify({ sha: 'deadbeef', commit: { message: 'Update UI' } }),
          { status: 200 },
        );
      }
      if (url.includes('codeload.github.com')) {
        return new Response(new Uint8Array(updateZip), { status: 200 });
      }
      return new Response('', { status: 404 });
    },
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const statusRes = await fetch(`${base}/api/update/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as { canRestart: boolean; backups: unknown[] };
    assert.equal(statusJson.canRestart, true);
    assert.equal(statusJson.backups.length, 0);

    const checkRes = await fetch(`${base}/api/update/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'https://github.com/Berber86/harness/tree/main' }),
    });
    const checkJson = (await checkRes.json()) as { hasUpdate: boolean; remoteSha: string };
    assert.equal(checkJson.hasUpdate, true);
    assert.equal(checkJson.remoteSha, 'deadbeef');

    const applyRes = await fetch(`${base}/api/update/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'https://github.com/Berber86/harness/tree/main' }),
    });
    assert.equal(applyRes.status, 200);
    const applyEvents = (await applyRes.text())
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
    const done = applyEvents.find((e: { type: string }) => e.type === 'done');
    assert.equal(done?.result?.filesWritten, 1);
    assert.equal(await readFile(path.join(appDir, 'web', 'index.html'), 'utf8'), '<h1>v2</h1>');

    const rollbackRes = await fetch(`${base}/api/update/rollback`, { method: 'POST' });
    assert.equal(rollbackRes.status, 200);
    assert.equal(await readFile(path.join(appDir, 'web', 'index.html'), 'utf8'), '<h1>v1</h1>');

    const restartRes = await fetch(`${base}/api/update/restart`, { method: 'POST' });
    const restartJson = (await restartRes.json()) as { restarting: boolean };
    assert.equal(restartJson.restarting, true);
    assert.equal(restarted, true);
  } finally {
    await close(server);
    await rm(appDir, { recursive: true, force: true });
  }
});
