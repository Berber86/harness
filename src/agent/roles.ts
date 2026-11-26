import { resolveProvider } from '../providers/registry.js';
import type { ContextOptions } from '../session/context.js';
import { Session } from '../session/session.js';
import {
  createBashTool,
  createEditTool,
  createListFilesTool,
  createReadTool,
  createSearchTool,
  createWriteTool,
} from '../tools/builtin.js';
import type { BashToolOptions } from '../tools/builtin.js';
import type { AgentEvent, ModelConfig, ModelProvider, Tool } from '../types.js';
import { runAgentLoop } from './loop.js';
import type { LoopDetectionOptions } from './loop.js';

export type RoleToolName = 'read' | 'edit' | 'write' | 'list_files' | 'search' | 'bash';

export interface AgentRole {
  /** Unique identifier used by `delegate({ role })`, e.g. 'coder'. */
  id: string;
  /** Human-friendly role title, e.g. 'Программист'. */
  name: string;
  /** Short hint telling the lead model when to call this specialist. */
  description: string;
  /** System instructions given to the specialist. */
  instructions: string;
  /** Model assigned to this role. */
  model: ModelConfig;
  /** Disabled roles are completely hidden from the lead model. */
  enabled: boolean;
  /** Allowed tools for this role. Default: ['read', 'write', 'bash']. */
  tools?: RoleToolName[];
  /** Turn cap per delegated task (keeps cheap models from looping). Default: 8. */
  maxTurns?: number;
  /** Optional explicit provider for this role. */
  provider?: ModelProvider;
}

export interface DefaultRolePreset {
  id: string;
  name: string;
  description: string;
  instructions: string;
  defaultModel: string;
  enabled: boolean;
  tools: RoleToolName[];
}

export const DEFAULT_ROLE_PRESETS: DefaultRolePreset[] = [
  {
    id: 'coder',
    name: 'Программист',
    description: 'Пишет и редактирует код в папке workspace, запускает простые проверки.',
    instructions:
      'Ты — программист. Работай только внутри папки workspace. Для поиска файлов используй list_files и search, для чтения больших файлов — read с offset/limit, для точечных правок — edit вместо полной перезаписи через write. Кратко сообщай, что изменил.',
    defaultModel: 'gidra-code-auto',
    enabled: true,
    tools: ['read', 'edit', 'write', 'list_files', 'search', 'bash'],
  },
  {
    id: 'reviewer',
    name: 'Проверяющий',
    description: 'Проверяет код на ошибки, баги и крайние случаи без изменения файлов.',
    instructions:
      'Ты — внимательный проверяющий (код-ревьюер). Используй list_files, search и read (с offset/limit для больших файлов), при необходимости запусти проверку через bash и коротко перечисли найденные проблемы. Не изменяй файлы.',
    defaultModel: 'hydra-gpt-mini',
    enabled: true,
    tools: ['read', 'list_files', 'search', 'bash'],
  },
  {
    id: 'docs',
    name: 'Писатель документации',
    description: 'Пишет понятные README, инструкции и комментарии к коду на русском языке.',
    instructions:
      'Ты — автор документации. Пиши простые, понятные инструкции и комментарии к коду на русском языке, ориентируясь на новичка. Сначала изучи файлы через list_files/read, затем обнови нужный документ через edit или write.',
    defaultModel: 'hydra-gpt-mini',
    enabled: false,
    tools: ['read', 'edit', 'write', 'list_files', 'search'],
  },
];

export function createToolsForRole(
  allowed: RoleToolName[] = ['read', 'edit', 'write', 'list_files', 'search', 'bash'],
  bashOptions: BashToolOptions = {},
): Tool[] {
  const set = new Set<RoleToolName>(allowed);
  const tools: Tool[] = [];
  if (set.has('read')) tools.push(createReadTool());
  if (set.has('edit')) tools.push(createEditTool());
  if (set.has('write')) tools.push(createWriteTool());
  if (set.has('list_files')) tools.push(createListFilesTool());
  if (set.has('search')) tools.push(createSearchTool());
  if (set.has('bash')) tools.push(createBashTool(bashOptions));
  return tools;
}

export function buildLeadSystemPrompt(basePrompt: string, activeRoles: AgentRole[]): string {
  if (!activeRoles.length) return basePrompt;
  const roster = activeRoles
    .map((role) => `- ${role.id} («${role.name}»): ${role.description}`)
    .join('\n');
  return `${basePrompt}

У тебя есть команда специалистов, которым можно передавать подзадачи инструментом delegate:
${roster}
Правила работы с командой:
- Для простых вопросов отвечай сам, не вызывай специалистов впустую, чтобы экономить токены.
- Если задача соответствует включённой роли (например, написание кода, проверка кода или документация), передай её через delegate и укажи конкретные пути файлов и чёткое задание.
- После получения отчёта специалиста проверь результат и кратко объясни пользователю итог простыми словами.`;
}

export interface DelegateToolOptions {
  roles: AgentRole[];
  providers?: Record<string, ModelProvider>;
  resolveRoleProvider?: (role: AgentRole) => ModelProvider;
  bashOptions?: BashToolOptions;
  context?: ContextOptions;
  loopDetection?: LoopDetectionOptions;
  onSubagentEvent?: (role: AgentRole, event: AgentEvent) => void;
}

export function createDelegateTool(options: DelegateToolOptions): Tool<{ role: string; task: string }> {
  const activeRoles = options.roles.filter((role) => role.enabled);
  const byId = new Map(activeRoles.map((role) => [role.id, role]));

  return {
    name: 'delegate',
    description:
      'Delegate a focused sub-task to an enabled specialist role with its own LLM model. Available roles: ' +
      activeRoles.map((role) => `${role.id} (${role.name})`).join(', '),
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: activeRoles.map((role) => role.id),
          description: 'Specialist role id to assign the task to',
        },
        task: {
          type: 'string',
          description: 'Clear, self-contained instruction with exact file paths if known',
        },
      },
      required: ['role', 'task'],
    },
    async execute(args, context) {
      const role = byId.get(args.role);
      if (!role) {
        return {
          content: `Роль «${args.role}» не найдена или отключена. Доступные роли: ${activeRoles.map((r) => r.id).join(', ') || 'нет'}.`,
          isError: true,
        };
      }

      const provider =
        role.provider ??
        options.resolveRoleProvider?.(role) ??
        resolveProvider(role.model, options.providers);
      const subSession = await Session.create();
      const tools = createToolsForRole(role.tools, options.bashOptions);

      let resultText = '';
      let turns = 0;
      let stopReason = 'end_turn';
      let errorMessage: string | undefined;

      for await (const event of runAgentLoop({
        session: subSession,
        prompt: args.task,
        provider,
        model: role.model,
        tools,
        cwd: context.cwd,
        systemPrompt: role.instructions,
        maxTurns: role.maxTurns ?? 8,
        context: options.context,
        loopDetection: options.loopDetection,
        signal: context.signal,
        trackFile: context.trackFile,
        checkpoint: false,
      })) {
        options.onSubagentEvent?.(role, event);
        if (event.type === 'error') {
          errorMessage = event.error.message;
        } else if (event.type === 'done') {
          resultText = event.result.text;
          turns = event.result.turns;
          stopReason = event.result.stopReason;
        }
      }

      const header = `[Роль: ${role.name} | модель: ${role.model.model} | шагов: ${turns} | статус: ${stopReason}]`;
      if (stopReason === 'error') {
        return {
          content: `${header}\nОшибка: ${errorMessage ?? (resultText || 'не удалось выполнить задачу')}`,
          isError: true,
        };
      }
      return `${header}\n${resultText || 'Задача выполнена.'}`;
    },
  };
}
