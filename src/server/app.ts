import http from 'node:http';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  Agent,
  DEFAULT_ROLE_PRESETS,
  FileSessionStore,
  Session,
  buildLeadSystemPrompt,
  createDefaultTools,
  createDelegateTool,
  openaiCompatibleProvider,
  resolveWithin,
  rollbackToCheckpoint,
} from '../index.js';
import type { AgentRole, Checkpoint, ModelProvider, RoleToolName, Tool } from '../index.js';
import { buildZip } from './zip.js';

const DEFAULT_BASE_URL = 'https://api.hydraai.ru/v1';
const DEFAULT_SYSTEM_PROMPT = `Ты дружелюбный помощник по программированию. Отвечай по-русски, коротко и понятно.
Рабочая папка — это песочница: меняй файлы только внутри неё. Перед изменением файла прочитай его.
Используй инструмент write для записи файлов и bash только для простых команд проверки. Объясняй, что ты сделал.`;

export interface AppServerOptions {
  workspaceDir?: string;
  sessionDir?: string;
  webDir?: string;
  baseURL?: string;
  systemPrompt?: string;
  providerFactory?: (options: { apiKey: string; baseURL: string; model: string }) => ModelProvider;
}

interface FileInfo {
  path: string;
  size: number;
  updatedAt: number;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendSse(res: http.ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 1_000_000) throw new Error('Запрос слишком большой');
  }
  return body;
}

/** Offline provider so the browser UI can be tried before an API key is available. */
function createDemoProvider(activeRoles: AgentRole[] = []): ModelProvider {
  return {
    name: 'demo',
    async *chat({ messages, tools }) {
      const hasDelegate = tools.some((tool) => tool.name === 'delegate');
      const canWrite = tools.some((tool) => tool.name === 'write');
      const toolAlreadyUsed = messages.some((message) => message.role === 'tool');

      if (hasDelegate && activeRoles.length > 0) {
        const chosen = activeRoles[0]!;
        if (!toolAlreadyUsed) {
          yield {
            type: 'tool_call',
            index: 0,
            id: 'demo-delegate',
            name: 'delegate',
            argumentsDelta: JSON.stringify({
              role: chosen.id,
              task: chosen.tools?.includes('write')
                ? 'Создай файл demo-note.txt с коротким приветствием.'
                : 'Прочитай файл README.txt и кратко опиши его.',
            }),
          };
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          for (const part of [
            'Готово! ',
            `Как руководитель, я передал задачу роли «${chosen.name}» (модель: ${chosen.model.model}). Можешь проверить результат в папке workspace или нажать «Откатить».`,
          ]) {
            yield { type: 'text_delta', text: part };
          }
          yield { type: 'done', stopReason: 'end_turn' };
        }
        return;
      }

      if (!toolAlreadyUsed) {
        if (canWrite) {
          yield {
            type: 'tool_call',
            index: 0,
            id: 'demo-call',
            name: 'write',
            argumentsDelta: JSON.stringify({
              path: 'demo-note.txt',
              content: 'Привет! Это файл из демо-режима.\n',
            }),
          };
        } else {
          yield {
            type: 'tool_call',
            index: 0,
            id: 'demo-call',
            name: 'read',
            argumentsDelta: JSON.stringify({ path: 'README.txt' }),
          };
        }
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        for (const part of [
          'Готово! ',
          canWrite
            ? 'Я создал файл demo-note.txt в папке workspace. Нажми «Откатить», чтобы увидеть, как работает отмена.'
            : 'Я проверил файл README.txt в папке workspace.',
        ]) {
          yield { type: 'text_delta', text: part };
        }
        yield { type: 'done', stopReason: 'end_turn' };
      }
    },
  };
}

interface IncomingRole {
  id?: string;
  name?: string;
  description?: string;
  instructions?: string;
  model?: string;
  enabled?: boolean;
  tools?: unknown;
}

const VALID_ROLE_TOOLS = new Set<RoleToolName>(['read', 'write', 'bash']);

function normalizeRoles(raw: IncomingRole[] | undefined, fallbackModel: string): AgentRole[] {
  if (!Array.isArray(raw)) return [];
  const roles: AgentRole[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 48) : '';
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 80) : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const tools = Array.isArray(item.tools)
      ? item.tools.filter((t): t is RoleToolName => typeof t === 'string' && VALID_ROLE_TOOLS.has(t as RoleToolName))
      : undefined;
    const modelName = typeof item.model === 'string' && item.model.trim() ? item.model.trim() : fallbackModel;
    roles.push({
      id,
      name,
      description: typeof item.description === 'string' && item.description.trim()
        ? item.description.trim().slice(0, 300)
        : `Выполняет задачи для роли «${name}»`,
      instructions: typeof item.instructions === 'string' && item.instructions.trim()
        ? item.instructions.trim().slice(0, 2000)
        : `Ты — ${name}. Выполняй задачи аккуратно внутри рабочей папки workspace.`,
      model: { provider: 'hydra', model: modelName, maxTokens: 4096 },
      enabled: Boolean(item.enabled),
      tools: tools && tools.length ? tools : ['read', 'write', 'bash'],
      maxTurns: 8,
    });
  }
  return roles;
}

function publicCheckpoint(checkpoint: Checkpoint) {
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    label: checkpoint.label,
    changes: checkpoint.changes.map((change) => ({
      path: change.path,
      before: change.before?.slice(0, 300) ?? null,
      after: change.after?.slice(0, 300) ?? null,
    })),
  };
}

/**
 * Local web app: serves the browser UI and proxies agent events over SSE.
 * The API key is supplied by the browser per request and is never persisted.
 */
export function createAppServer(options: AppServerOptions = {}): http.Server {
  const workspaceDir = options.workspaceDir ?? path.resolve(process.cwd(), 'workspace');
  const sessionDir = options.sessionDir ?? path.resolve(process.cwd(), '.harness', 'sessions');
  const webDir = options.webDir ?? path.resolve(process.cwd(), 'web');
  const baseURL = (options.baseURL ?? process.env.HYDRA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const store = new FileSessionStore(sessionDir);

  async function listFiles(): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    async function walk(directory: string, prefix: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (['node_modules', '.git', '.harness'].includes(entry.name)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, relative);
        } else if (files.length < 500) {
          const info = await stat(absolute);
          files.push({ path: relative, size: info.size, updatedAt: info.mtimeMs });
        }
      }
    }
    await mkdir(workspaceDir, { recursive: true });
    await walk(workspaceDir, '');
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    const allowed: Record<string, string> = {
      '/': 'index.html',
      '/index.html': 'index.html',
      '/styles.css': 'styles.css',
      '/app.js': 'app.js',
    };
    const file = allowed[pathname];
    if (!file) {
      sendJson(res, 404, { error: 'Страница не найдена' });
      return;
    }
    try {
      const content = await readFile(path.join(webDir, file));
      const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      sendJson(res, 404, { error: 'Файл интерфейса не найден' });
    }
  }

  async function handleModels(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('demo') === '1') {
      sendJson(res, 200, { models: ['demo-model'] });
      return;
    }
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      sendJson(res, 400, { error: 'Сначала вставьте ключ HydraAI' });
      return;
    }
    try {
      const response = await fetch(`${baseURL}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        sendJson(res, response.status, { error: `HydraAI ответил ${response.status}. Проверьте ключ.` });
        return;
      }
      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const models = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string')
        .slice(0, 300);
      sendJson(res, 200, { models });
    } catch (error) {
      sendJson(res, 502, { error: `Не удалось получить модели: ${(error as Error).message}` });
    }
  }

  async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: {
      prompt?: string;
      apiKey?: string;
      model?: string;
      sessionId?: string;
      demo?: boolean;
      roles?: IncomingRole[];
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Некорректный запрос' });
      return;
    }
    if (!body.prompt?.trim() || (!body.demo && (!body.apiKey?.trim() || !body.model?.trim()))) {
      sendJson(res, 400, { error: 'Нужны сообщение, ключ и модель' });
      return;
    }

    const leadModel = body.model?.trim() || 'demo-model';
    const allRoles = normalizeRoles(body.roles, leadModel);
    const activeRoles = allRoles.filter((role) => role.enabled);

    const resolveModelProvider = (modelName: string): ModelProvider =>
      body.demo
        ? createDemoProvider(activeRoles)
        : options.providerFactory
          ? options.providerFactory({ apiKey: body.apiKey!, baseURL, model: modelName })
          : openaiCompatibleProvider({ apiKey: body.apiKey!, baseURL });

    const session =
      (body.sessionId ? await Session.load(body.sessionId, store) : null) ??
      (await Session.create({ store }));
    const provider = resolveModelProvider(leadModel);
    const activeRoleById = new Map(activeRoles.map((role) => [role.id, role]));

    const tools: Tool[] = [...createDefaultTools()];
    if (activeRoles.length) {
      tools.push(
        createDelegateTool({
          roles: activeRoles,
          resolveRoleProvider: (role) => resolveModelProvider(role.model.model),
          context: { maxTokens: 24_000, keepRecent: 6 },
          onSubagentEvent(role, subEvent) {
            if (subEvent.type === 'tool_start') {
              sendSse(res, {
                type: 'activity',
                text: `  ↳ [${role.name}] инструмент «${subEvent.call.name}»`,
                detail: JSON.stringify(subEvent.call.arguments).slice(0, 220),
              });
            } else if (subEvent.type === 'tool_end') {
              sendSse(res, {
                type: 'activity',
                text: `  ↳ [${role.name}] ${subEvent.result.isError ? 'ошибка инструмента' : 'готово'}`,
                detail: subEvent.result.content.slice(0, 220),
              });
            } else if (subEvent.type === 'loop_detected') {
              sendSse(res, {
                type: 'activity',
                text: `  ↳ [${role.name}] автостоп: защита от зацикливания`,
              });
            }
          },
        }),
      );
    }

    const agent = new Agent({
      model: { provider: 'hydra', model: leadModel, maxTokens: 4096 },
      provider,
      tools,
      session,
      cwd: workspaceDir,
      systemPrompt: buildLeadSystemPrompt(systemPrompt, activeRoles),
      maxTurns: 12,
      context: { maxTokens: 32_000, keepRecent: 6 },
    });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    sendSse(res, { type: 'started', sessionId: session.id });

    const controller = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) controller.abort();
    });

    try {
      for await (const event of agent.stream(body.prompt, { signal: controller.signal })) {
        switch (event.type) {
          case 'run_start':
            break;
          case 'text_delta':
            sendSse(res, { type: 'text', text: event.text });
            break;
          case 'tool_start':
            if (event.call.name === 'delegate') {
              const roleId = typeof event.call.arguments.role === 'string' ? event.call.arguments.role : '';
              const role = activeRoleById.get(roleId);
              sendSse(res, {
                type: 'activity',
                text: role
                  ? `🤝 Передаю задачу: «${role.name}» (${role.model.model})`
                  : `🤝 Передаю задачу роли «${roleId}»`,
                detail: typeof event.call.arguments.task === 'string' ? event.call.arguments.task.slice(0, 260) : '',
              });
            } else {
              sendSse(res, {
                type: 'activity',
                text: `Использую инструмент «${event.call.name}»`,
                detail: JSON.stringify(event.call.arguments).slice(0, 300),
              });
            }
            break;
          case 'tool_end':
            sendSse(res, {
              type: 'activity',
              text: event.result.isError ? 'Инструмент сообщил об ошибке' : 'Инструмент выполнен',
              detail: event.result.content.slice(0, 300),
            });
            break;
          case 'compacted':
            sendSse(res, { type: 'notice', text: 'Разговор стал длинным — я сократил старые сообщения.' });
            break;
          case 'loop_detected':
            sendSse(res, {
              type: 'notice',
              text: 'Сработал автостоп (защита от зацикливания): помощник остановился, чтобы не тратить лишние токены.',
            });
            break;
          case 'error':
            sendSse(res, { type: 'error', message: event.error.message });
            break;
          case 'checkpoint':
            sendSse(res, { type: 'checkpoint', checkpointId: event.checkpointId });
            break;
          case 'done': {
            const last = session.checkpoints.at(-1);
            sendSse(res, {
              type: 'done',
              result: {
                sessionId: session.id,
                text: event.result.text,
                stopReason: event.result.stopReason,
                checkpointId: event.result.checkpointId,
                changes: last ? publicCheckpoint(last).changes : [],
              },
              files: await listFiles(),
            });
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      sendSse(res, { type: 'error', message: (error as Error).message });
    } finally {
      finished = true;
      res.end();
    }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname.startsWith('/api/')) {
          switch (url.pathname) {
            case '/api/files':
              sendJson(res, 200, { files: await listFiles() });
              return;
            case '/api/sessions':
              sendJson(res, 200, { sessions: await store.list() });
              return;
            case '/api/session': {
              const session = await Session.load(url.searchParams.get('id') ?? '', store);
              if (!session) {
                sendJson(res, 404, { error: 'Чат не найден' });
                return;
              }
              sendJson(res, 200, {
                session: {
                  id: session.id,
                  messages: session.messages.map((message) => ({
                    role: message.role,
                    content: message.content,
                    tools: message.toolCalls?.map((call) => call.name) ?? [],
                  })),
                  checkpoints: session.checkpoints.map(publicCheckpoint),
                },
              });
              return;
            }
            case '/api/file': {
              const absolute = await resolveWithin(workspaceDir, url.searchParams.get('path') ?? '');
              sendJson(res, 200, { path: url.searchParams.get('path'), content: await readFile(absolute, 'utf8') });
              return;
            }
            case '/api/download': {
              const requested = url.searchParams.get('path') ?? '';
              const absolute = await resolveWithin(workspaceDir, requested);
              const data = await readFile(absolute);
              const filename = path.basename(absolute).replace(/["\r\n]/g, '_');
              res.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-length': data.length,
                'content-disposition': `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
              });
              res.end(req.method === 'HEAD' ? undefined : data);
              return;
            }
            case '/api/download-all': {
              const files = await listFiles();
              const entries = [];
              let totalBytes = 0;
              for (const file of files) {
                if (totalBytes + file.size > 50 * 1024 * 1024) break;
                const absolute = await resolveWithin(workspaceDir, file.path);
                const data = await readFile(absolute);
                totalBytes += data.length;
                entries.push({ name: file.path, data });
              }
              const archive = buildZip(entries);
              res.writeHead(200, {
                'content-type': 'application/zip',
                'content-length': archive.length,
                'content-disposition': 'attachment; filename="workspace.zip"',
              });
              res.end(req.method === 'HEAD' ? undefined : archive);
              return;
            }
            case '/api/models':
              await handleModels(req, res);
              return;
            case '/api/roles':
              sendJson(res, 200, { roles: DEFAULT_ROLE_PRESETS });
              return;
          }
        }
        await serveStatic(req, res, url.pathname);
        return;
      }

      if (req.method === 'POST') {
        switch (url.pathname) {
          case '/api/chat':
            await handleChat(req, res);
            return;
          case '/api/rollback': {
            const body = JSON.parse(await readBody(req)) as { sessionId?: string; checkpointId?: string };
            const session = body.sessionId ? await Session.load(body.sessionId, store) : null;
            if (!session || !body.checkpointId) {
              sendJson(res, 404, { error: 'Чат или точка восстановления не найдена' });
              return;
            }
            const checkpoint = await rollbackToCheckpoint(session, body.checkpointId, workspaceDir);
            sendJson(res, 200, {
              checkpoint: publicCheckpoint(checkpoint),
              messages: session.messages.length,
              files: await listFiles(),
            });
            return;
          }
        }
      }
      sendJson(res, 404, { error: 'Неизвестный адрес' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
      else sendSse(res, { type: 'error', message: (error as Error).message });
      if (!res.writableEnded) res.end();
    }
  });
}
