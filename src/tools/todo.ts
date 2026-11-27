import type { Tool } from '../types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const VALID_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);

/**
 * Whole-list task checklist tool inspired by DeepSeek Harness (dsh-tool-todo)
 * and Claude Code's TodoWrite. Keeps multi-step tasks visible to both the model
 * and the user UI without inflating conversation history.
 */
export function createTodoWriteTool(
  onUpdate?: (todos: TodoItem[]) => Promise<void> | void,
): Tool<{ todos: TodoItem[] }> {
  return {
    name: 'todo_write',
    description:
      'Update the task checklist for this session. Pass the complete ordered list of steps with status: pending, in_progress, or completed.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Complete current list of task steps',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Short clear step description' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Step state',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    async execute(args) {
      if (!Array.isArray(args.todos)) {
        return { content: 'todos must be an array', isError: true };
      }
      if (args.todos.length > 30) {
        return { content: 'Keep todo list focused (at most 30 items)', isError: true };
      }

      const normalized: TodoItem[] = [];
      for (let i = 0; i < args.todos.length; i++) {
        const item = args.todos[i];
        if (!item) continue;
        const content = typeof item.content === 'string' ? item.content.trim() : '';
        if (!content) {
          return { content: `todos[${i}].content must be a non-empty string`, isError: true };
        }
        if (!VALID_STATUSES.has(item.status)) {
          return {
            content: `todos[${i}].status must be pending, in_progress, or completed`,
            isError: true,
          };
        }
        normalized.push({ content: content.slice(0, 200), status: item.status });
      }

      await onUpdate?.(normalized);
      const done = normalized.filter((t) => t.status === 'completed').length;
      const active = normalized.find((t) => t.status === 'in_progress')?.content;
      const summary = `Чек-лист обновлён: готово ${done} из ${normalized.length}.`;
      return active ? `${summary} Сейчас в работе: «${active}».` : summary;
    },
  };
}
