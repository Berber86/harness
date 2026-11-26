import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const port = Number(process.env.PORT ?? 8787);
const url = `http://localhost:${port}`;
const checkUrl = `http://127.0.0.1:${port}/api/roles`;

function openBrowser(targetUrl) {
  let browser;
  if (process.platform === 'win32') {
    browser = spawn('cmd', ['/c', 'start', '', targetUrl], { detached: true, stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    browser = spawn('open', [targetUrl], { detached: true, stdio: 'ignore' });
  } else {
    browser = spawn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' });
  }
  browser.on('error', () => {});
  browser.unref();
}

async function waitAndOpenBrowser() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(checkUrl, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        openBrowser(url);
        return;
      }
    } catch {
      // Server is still starting up.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  openBrowser(url);
}

console.log('Открываю «Мой помощник»...');
console.log('Это чёрное окно можно свернуть, но не закрывать.');

// If an earlier instance is still running on the port, ask it to exit before starting a fresh one.
try {
  await fetch(`http://127.0.0.1:${port}/__shutdown`, { method: 'POST', signal: AbortSignal.timeout(800) });
  await new Promise((resolve) => setTimeout(resolve, 400));
} catch {
  // Nothing listening yet, or older instance without /__shutdown.
}

const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = path.resolve('src', 'server', 'index.ts');
const args = existsSync(tsxCli) ? [tsxCli, entry] : ['--import', 'tsx', entry];

const child = spawn(process.execPath, args, { stdio: 'inherit' });
waitAndOpenBrowser();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

child.on('error', (error) => {
  console.error(`Не удалось запустить программу: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`Программа завершилась с ошибкой (код ${code}).`);
  }
  process.exit(code ?? 0);
});
