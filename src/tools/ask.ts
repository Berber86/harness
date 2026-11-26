import type { Tool } from '../types.js';

export interface AskQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  options: AskQuestionOption[];
  allowCustomResponse?: boolean;
}

export interface AskUserAnswer {
  questionId: string;
  selectedOptionId?: string | null;
  customResponse?: string | null;
}

export interface AskUserResponse {
  answers: AskUserAnswer[];
  skipped?: boolean;
}

export type AskUserHandler = (
  questions: AskQuestion[],
  signal?: AbortSignal,
) => Promise<AskUserResponse>;

export function createAskUserTool(handler: AskUserHandler): Tool<{ questions: AskQuestion[] }> {
  return {
    name: 'ask_user',
    description:
      'Ask the user 1-4 clarifying questions with clickable options (plus optional free text). Use before starting non-trivial tasks so you build exactly what they want without wasting tokens.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'List of 1 to 4 questions with 2 to 4 options each',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique question id' },
              question: { type: 'string', description: 'Question text shown to the user' },
              allowCustomResponse: { type: 'boolean', description: 'Allow typing a custom answer' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['id', 'label'],
                },
              },
            },
            required: ['id', 'question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    async execute(args, context) {
      if (!Array.isArray(args.questions) || !args.questions.length) {
        return { content: 'questions must be a non-empty array', isError: true };
      }
      const normalized: AskQuestion[] = args.questions.slice(0, 4).map((q, qi) => ({
        id: String(q.id || `q${qi + 1}`),
        question: String(q.question || '').trim(),
        allowCustomResponse: q.allowCustomResponse !== false,
        options: Array.isArray(q.options)
          ? q.options.slice(0, 4).map((opt, oi) => ({
              id: String(opt.id || `opt${oi + 1}`),
              label: String(opt.label || '').trim(),
              ...(opt.description ? { description: String(opt.description).trim() } : {}),
            }))
          : [],
      }));

      for (const q of normalized) {
        if (!q.question || q.options.length < 2) {
          return {
            content: `Question "${q.id}" must have text and at least 2 options`,
            isError: true,
          };
        }
      }

      const response = await handler(normalized, context.signal);
      if (response.skipped) {
        return JSON.stringify({ skipped: true, answers: [] });
      }
      const readable = response.answers.map((ans) => {
        const q = normalized.find((item) => item.id === ans.questionId);
        const opt = q?.options.find((item) => item.id === ans.selectedOptionId);
        return {
          questionId: ans.questionId,
          question: q?.question,
          selectedOptionId: ans.selectedOptionId ?? null,
          selectedLabel: opt?.label ?? null,
          customResponse: ans.customResponse ?? null,
        };
      });
      return JSON.stringify({ skipped: false, answers: readable });
    },
  };
}
