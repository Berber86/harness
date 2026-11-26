import http from 'node:http';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  Agent,
  DEFAULT_ROLE_PRESETS,
  FileSessionStore,
  Session,
  buildLeadSystemPrompt,
  buildSkillSystemPrompt,
  compactIfNeeded,
  createAskUserTool,
  createDefaultTools,
  createDelegateTool,
  createFetchPageTool,
  createListFilesTool,
  createReadTool,
  createSearchTool,
  deleteSkill,
  estimateSessionTokens,
  loadSkills,
  matchSkillInvocation,
  newId,
  openaiCompatibleProvider,
  resolveWithin,
  rollbackToCheckpoint,
  saveSkill,
} from '../index.js';
import type {
  AgentRole,
  AskUserAnswer,
  AskUserResponse,
  Checkpoint,
  ModelProvider,
  RoleToolName,
  SkillMode,
  Tool,
  Usage,
} from '../index.js';
import { buildZip } from './zip.js';

const DEFAULT_BASE_URL = 'https://api.hydraai.ru/v1';
const DEFAULT_SYSTEM_PROMPT = `Ты дружелюбный помощник по программированию. Отвечай по-русски, коротко и понятно.
Рабочая папка — это песочница: меняй файлы только внутри неё.
Перед тем как начать писать или менять код по новой задаче, сначала задай 2–3 коротких уточняющих вопроса через инструмент ask_user с вариантами ответа (если пользователь только что не ответил на твои вопросы и это не совсем маленький информационный вопрос). Это помогает сделать именно то, что нужно, без переделок и лишних трат токенов.
Для просмотра списка файлов и поиска по коду используй list_files и search (не запускай ls/grep через bash).
Для чтения больших файлов используй read с offset и limit. Для небольших правок используй edit вместо полной перезаписи через write — это экономит токены.
Если нужно удалить ненужный файл — используй delete_file (удаление можно будет откатить). Если пользователь дал ссылку на страницу — прочитай её через fetch_page.
Инструмент bash используй только для запуска программ, тестов и сборки. Объясняй, что ты сделал.`;

export interface AppServerOptions {
  workspaceDir?: string;
  sessionDir?: string;
  webDir?: string;
  skillsDir?: string;
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
      const hasAsk = tools.some((tool) => tool.name === 'ask_user');
      const hasDelegate = tools.some((tool) => tool.name === 'delegate');
      const canWrite = tools.some((tool) => tool.name === 'write');
      const systemText = messages.find((message) => message.role === 'system')?.content ?? '';
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const activeSkillMatch = systemText.match(/\[АКТИВНЫЙ НАВЫК: \/([a-z0-9-]+)/i);

      if (activeSkillMatch) {
        const skillName = activeSkillMatch[1]!.toLowerCase();
        const userIdea = (lastUser?.content ?? '').replace(/^\/[a-z0-9-]+\s*/i, '').trim() || 'сделать удобный сайт в песочнице';
        const demoReply =
          skillName === 'reframe'
            ? [
                `Вот разбор твоей идеи («${userIdea}») на языке профи (демо-пример):`,
                '',
                '1. **Ключевые термины (что сильнее всего влияет на результат):**',
                '   - **Недеструктивное редактирование (Non-destructive editing)** — все изменения хранятся как список правок поверх исходника, чтобы можно было откатить любой шаг (так устроено и в FFmpeg/Shotcut).',
                '   - **Идемпотентность (Idempotency)** — повторный запуск кнопки даёт тот же безопасный результат без дублей.',
                '   - **Разделение состояния и отображения (State vs View)** — сначала чёткие данные, потом уже красивая картинка.',
                '2. **Из соседних областей:** в бухгалтерии это называется *журнал транзакций (ledger)* — вместо стирания старой цифры дописывается новая запись.',
                '3. **Что важно не забыть:** заранее продумать пустое состояние, откат ошибок и проверку результата на реальном файле.',
                '',
                '```prompt',
                `Сделай прототип для задачи: ${userIdea}. Используй недеструктивное редактирование (с возможностью отката через чекпоинты), отдели хранение данных от интерфейса и добавь проверку граничных случаев.`,
                '```',
              ].join('\n')
            : skillName === 'sharpen'
              ? [
                  `Углубляем задачу «${userIdea}» (демо-пример):`,
                  '',
                  '1. **Что сделал бы профи, о чём не просили:** добавил бы простую проверку крайних случаев (пустой ввод, ошибка сохранения) и быструю автопроверку.',
                  '2. **Самый сырой исходный материал:** реальные данные/файлы из папки `workspace`, а не выдуманные примеры.',
                  '3. **Методы и инструменты:** минимальный рабочий прототип + быстрая проверка поведения.',
                  '4. **Внешняя проверка результата:** тест или реальный прогон сценария, а не просто «выглядит красиво».',
                  '',
                  '```prompt',
                  `Реализуй задачу «${userIdea}» с опорой на реальные файлы проекта. Для спорных технических решений сначала сделай мини-прототип и порекомендуй лучший вариант по фактам, а вкусовые и продуктовые решения спроси у меня через варианты ответа. В конце проверь результат реальным тестом.`,
                  '```',
                ].join('\n')
              : `Навык /${skillName} выполнен в безопасном режиме анализа (демо-ответ для: «${userIdea}»).`;
        yield { type: 'text_delta', text: demoReply };
        yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 90, outputTokens: 110 } };
        return;
      }

      const wantsQuestion = /вопрос|спроси|вариант/i.test(lastUser?.content ?? '');
      const toolResults = messages.flatMap((message) => message.toolResults ?? []);
      const askResult = toolResults.find((res) => res.name === 'ask_user');
      const otherToolUsed = toolResults.some((res) => res.name !== 'ask_user');

      if (hasAsk && wantsQuestion && !askResult) {
        yield {
          type: 'tool_call',
          index: 0,
          id: 'demo-ask',
          name: 'ask_user',
          argumentsDelta: JSON.stringify({
            questions: [
              {
                id: 'demo_kind',
                question: 'Что создать для проверки в демо-режиме?',
                options: [
                  {
                    id: 'site',
                    label: 'Мини-сайт (index.html)',
                    description: 'Можно сразу открыть кнопкой «🌐 Сайт» в песочнице',
                  },
                  {
                    id: 'note',
                    label: 'Текстовую заметку (demo-note.txt)',
                    description: 'Обычный текстовый файл с возможностью отката',
                  },
                ],
                allowCustomResponse: true,
              },
            ],
          }),
        };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }

      if (askResult && !otherToolUsed && canWrite) {
        const pickedSite = askResult.content.includes('"selectedOptionId":"site"');
        yield {
          type: 'tool_call',
          index: 0,
          id: 'demo-after-ask',
          name: 'write',
          argumentsDelta: JSON.stringify(
            pickedSite
              ? {
                  path: 'index.html',
                  content:
                    '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Демо-сайт</title><body style="font-family:sans-serif;padding:40px"><h1>Привет из песочницы!</h1><p>Этот сайт создан в демо-режиме после твоего выбора.</p></body></html>\n',
                }
              : {
                  path: 'demo-note.txt',
                  content: 'Привет! Это файл из демо-режима после твоего ответа.\n',
                },
          ),
        };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }

      if (hasDelegate && activeRoles.length > 0) {
        const chosen = activeRoles[0]!;
        if (!otherToolUsed) {
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

      if (!otherToolUsed) {
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
        const createdSite = messages.some((m) => m.toolCalls?.some((c) => c.arguments?.path === 'index.html'));
        const reply = !canWrite
          ? formatDemoPlanReply()
          : createdSite
            ? 'Готово! Я создал мини-сайт index.html в папке workspace. Нажми «🌐 Сайт» слева, чтобы открыть его в браузере!'
            : 'Готово! Я создал файл demo-note.txt в папке workspace. Нажми «Откатить», чтобы увидеть, как работает отмена.';
        for (const part of [reply]) {
          yield { type: 'text_delta', text: part };
        }
        yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 45 } };
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

const READ_ONLY_ROLE_TOOLS = new Set<RoleToolName>(['read', 'list_files', 'search', 'fetch_page']);

function getSessionUsage(session: Session): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const raw = session.metadata.usage as { inputTokens?: number; outputTokens?: number } | undefined;
  const inputTokens = Number(raw?.inputTokens ?? 0);
  const outputTokens = Number(raw?.outputTokens ?? 0);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function addSessionUsage(session: Session, delta: Usage | undefined) {
  const prev = getSessionUsage(session);
  const inputTokens = prev.inputTokens + Number(delta?.inputTokens ?? 0);
  const outputTokens = prev.outputTokens + Number(delta?.outputTokens ?? 0);
  session.metadata.usage = { inputTokens, outputTokens };
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function formatDemoPlanReply(): string {
  return [
    'Готово! Вот пошаговый план (режим **«Только план»** — файлы не менялись):',
    '1. Проверить текущие файлы в `workspace`.',
    '2. Создать или обновить нужные файлы.',
    '3. Проверить результат.',
    'Переключи режим на **«⚡ Действие»**, и я сразу выполню этот план!',
  ].join('\n');
}

const VALID_ROLE_TOOLS = new Set<RoleToolName>([
  'read',
  'edit',
  'write',
  'delete_file',
  'list_files',
  'search',
  'fetch_page',
  'bash',
]);

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
      tools: tools && tools.length
        ? tools
        : ['read', 'edit', 'write', 'delete_file', 'list_files', 'search', 'fetch_page', 'bash'],
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
  const skillsDir = options.skillsDir ?? path.resolve(process.cwd(), 'skills');
  const baseURL = (options.baseURL ?? process.env.HYDRA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const store = new FileSessionStore(sessionDir);
  const pendingQuestions = new Map<
    string,
    { resolve: (response: AskUserResponse) => void; reject: (error: Error) => void }
  >();

  const PREVIEW_MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
  };

  async function servePreview(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    if (pathname === '/preview') {
      res.writeHead(302, { location: '/preview/' });
      res.end();
      return;
    }
    const rel = decodeURIComponent(pathname.slice('/preview/'.length)).replace(/^\/+/, '');
    if (!rel) {
      try {
        const indexPath = await resolveWithin(workspaceDir, 'index.html');
        const content = await readFile(indexPath);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      } catch {
        const files = (await listFiles()).filter((f) => /\.html?$/i.test(f.path));
        const items = files.length
          ? files
              .map((f) => {
                const safe = f.path.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
                return `<li><a href="/preview/${encodeURI(f.path)}">${safe}</a></li>`;
              })
              .join('')
          : '<li>Пока нет HTML-страниц в папке <code>workspace</code>.</li>';
        const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Предпросмотр workspace</title><body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 20px"><h2>Сайты из песочницы</h2><ul>${items}</ul></body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      }
    }
    try {
      const absolute = await resolveWithin(workspaceDir, rel);
      const data = await readFile(absolute);
      const ext = path.extname(absolute).toLowerCase();
      res.writeHead(200, { 'content-type': PREVIEW_MIME[ext] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendJson(res, 404, { error: 'Файл предпросмотра не найден' });
    }
  }

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
      mode?: 'plan' | 'act';
      rules?: string;
      skill?: string;
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

    const availableSkills = await loadSkills(skillsDir);
    const skillInvocation = matchSkillInvocation(body.prompt, availableSkills, body.skill);
    const requestedMode: 'plan' | 'act' = body.mode === 'plan' ? 'plan' : 'act';
    const mode: 'plan' | 'act' = skillInvocation?.skill.mode === 'plan' ? 'plan' : requestedMode;
    const projectRules = typeof body.rules === 'string' ? body.rules.trim().slice(0, 2000) : '';
    const leadModel = body.model?.trim() || 'demo-model';
    const allRoles = normalizeRoles(body.roles, leadModel);
    const activeRoles = allRoles
      .filter((role) => role.enabled)
      .map((role) => {
        const instructions = projectRules
          ? `${role.instructions}\n\nПравила проекта от пользователя:\n${projectRules}`
          : role.instructions;
        if (mode !== 'plan') return { ...role, instructions };
        const readTools = (role.tools ?? []).filter((t) => READ_ONLY_ROLE_TOOLS.has(t));
        return {
          ...role,
          instructions: `${instructions}\n\nСейчас режим ТОЛЬКО ПЛАН: ничего не меняй, только анализируй.`,
          tools: readTools.length ? readTools : (['read', 'list_files', 'search'] as RoleToolName[]),
        };
      });

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

    const controller = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) controller.abort();
    });

    const askUserTool = createAskUserTool((questions, signal) => {
      const requestId = newId();
      sendSse(res, { type: 'ask_user', requestId, questions });
      return new Promise<AskUserResponse>((resolve, reject) => {
        const onAbort = () => {
          pendingQuestions.delete(requestId);
          reject(new Error('Run aborted'));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        pendingQuestions.set(requestId, {
          resolve(response) {
            signal?.removeEventListener('abort', onAbort);
            resolve(response);
          },
          reject(error) {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        });
      });
    });

    const baseTools: Tool[] =
      mode === 'plan'
        ? [createReadTool(), createListFilesTool(), createSearchTool(), createFetchPageTool()]
        : createDefaultTools();
    const tools: Tool[] = [...baseTools, askUserTool];
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

    let effectivePrompt = buildLeadSystemPrompt(systemPrompt, activeRoles);
    if (projectRules) {
      effectivePrompt += `\n\nПравила проекта от пользователя (всегда соблюдай):\n${projectRules}`;
    }
    if (skillInvocation) {
      effectivePrompt += `\n\n${buildSkillSystemPrompt(skillInvocation.skill)}`;
    }
    if (mode === 'plan' && !skillInvocation) {
      effectivePrompt +=
        '\n\nРЕЖИМ «ТОЛЬКО ПЛАН»: сейчас запрещено менять или удалять файлы и запускать команды. Изучи проект доступными инструментами чтения, при необходимости уточни детали через ask_user и составь понятный пошаговый план. В конце предложи пользователю переключиться в режим «Действие», чтобы приступить к выполнению.';
    }

    const agent = new Agent({
      model: { provider: 'hydra', model: leadModel, maxTokens: 4096 },
      provider,
      tools,
      session,
      cwd: workspaceDir,
      systemPrompt: effectivePrompt,
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
    if (skillInvocation) {
      sendSse(res, {
        type: 'skill',
        skill: {
          name: skillInvocation.skill.name,
          title: skillInvocation.skill.title,
          icon: skillInvocation.skill.icon,
          mode: skillInvocation.skill.mode,
        },
      });
    }

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
            } else if (event.call.name === 'ask_user') {
              sendSse(res, {
                type: 'activity',
                text: '❓ Задаю уточняющие вопросы…',
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
            const runUsage = {
              inputTokens: event.result.usage.inputTokens ?? 0,
              outputTokens: event.result.usage.outputTokens ?? 0,
              totalTokens: (event.result.usage.inputTokens ?? 0) + (event.result.usage.outputTokens ?? 0),
            };
            const sessionUsage = addSessionUsage(session, event.result.usage);
            await session.save();
            sendSse(res, {
              type: 'done',
              result: {
                sessionId: session.id,
                text: event.result.text,
                stopReason: event.result.stopReason,
                checkpointId: event.result.checkpointId,
                changes: last ? publicCheckpoint(last).changes : [],
                usage: runUsage,
                sessionUsage,
                contextTokens: estimateSessionTokens(session),
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
                  usage: getSessionUsage(session),
                  contextTokens: estimateSessionTokens(session),
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
            case '/api/skills':
              sendJson(res, 200, { skills: await loadSkills(skillsDir) });
              return;
          }
        }
        if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
          await servePreview(req, res, url.pathname);
          return;
        }
        await serveStatic(req, res, url.pathname);
        return;
      }

      if (req.method === 'POST') {
        switch (url.pathname) {
          case '/api/chat':
            await handleChat(req, res);
            return;
          case '/api/answer': {
            const body = JSON.parse(await readBody(req)) as {
              requestId?: string;
              answers?: AskUserAnswer[];
              skipped?: boolean;
            };
            const pending = body.requestId ? pendingQuestions.get(body.requestId) : undefined;
            if (!pending) {
              sendJson(res, 404, { error: 'Вопрос уже закрыт или не найден' });
              return;
            }
            pendingQuestions.delete(body.requestId!);
            pending.resolve({ answers: body.answers ?? [], skipped: Boolean(body.skipped) });
            sendJson(res, 200, { ok: true });
            return;
          }
          case '/api/compact': {
            const body = JSON.parse(await readBody(req)) as {
              sessionId?: string;
              apiKey?: string;
              model?: string;
              demo?: boolean;
            };
            const session = body.sessionId ? await Session.load(body.sessionId, store) : null;
            if (!session) {
              sendJson(res, 404, { error: 'Чат не найден' });
              return;
            }
            const modelName = body.model?.trim() || 'demo-model';
            const compactProvider: ModelProvider = body.demo
              ? {
                  name: 'demo-compact',
                  async *chat() {
                    yield {
                      type: 'text_delta',
                      text: 'Краткая выжимка предыдущей части разговора (демо-сжатие).',
                    };
                    yield { type: 'done', stopReason: 'end_turn' };
                  },
                }
              : options.providerFactory
                ? options.providerFactory({ apiKey: body.apiKey ?? '', baseURL, model: modelName })
                : openaiCompatibleProvider({ apiKey: body.apiKey ?? '', baseURL });
            const result = await compactIfNeeded(
              session,
              compactProvider,
              { provider: 'hydra', model: modelName, maxTokens: 1024 },
              { force: true, keepRecent: 4, enabled: true },
            );
            if (!result) {
              sendJson(res, 200, {
                compacted: false,
                contextTokens: estimateSessionTokens(session),
                message: 'Чат ещё короткий — сжимать пока нечего.',
              });
              return;
            }
            sendJson(res, 200, {
              compacted: true,
              removedMessages: result.removedMessages,
              tokensBefore: result.tokensBefore,
              tokensAfter: result.tokensAfter,
              contextTokens: result.tokensAfter,
            });
            return;
          }
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
              contextTokens: estimateSessionTokens(session),
              files: await listFiles(),
            });
            return;
          }
          case '/api/skills': {
            const body = JSON.parse(await readBody(req)) as {
              name?: string;
              title?: string;
              icon?: string;
              description?: string;
              mode?: SkillMode;
              instructions?: string;
            };
            try {
              const skill = await saveSkill(skillsDir, {
                name: body.name ?? '',
                title: body.title,
                icon: body.icon,
                description: body.description,
                mode: body.mode === 'act' ? 'act' : 'plan',
                instructions: body.instructions ?? '',
              });
              sendJson(res, 200, { skill, skills: await loadSkills(skillsDir) });
            } catch (error) {
              sendJson(res, 400, { error: (error as Error).message });
            }
            return;
          }
        }
      }

      if (req.method === 'DELETE' && url.pathname === '/api/skills') {
        try {
          const name = url.searchParams.get('name') ?? '';
          const deleted = await deleteSkill(skillsDir, name);
          sendJson(res, 200, { deleted, skills: await loadSkills(skillsDir) });
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }

      sendJson(res, 404, { error: 'Неизвестный адрес' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
      else sendSse(res, { type: 'error', message: (error as Error).message });
      if (!res.writableEnded) res.end();
    }
  });
}
