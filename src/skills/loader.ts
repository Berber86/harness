import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type SkillMode = 'plan' | 'act';

export interface SkillDefinition {
  /** Slash command identifier, e.g. "reframe" for /reframe */
  name: string;
  /** Short Russian display label for UI chips */
  title: string;
  /** Single emoji or icon label */
  icon: string;
  /** One-line description shown on hover / modal */
  description: string;
  /** Whether the skill enforces read-only plan mode or allows edits */
  mode: SkillMode;
  /** When true (default for /reframe, /sharpen), runs only when explicitly invoked */
  disableModelInvocation: boolean;
  /** Full prompt instructions inside SKILL.md */
  instructions: string;
  /** Relative path to the source markdown file */
  filePath: string;
}

export interface SaveSkillInput {
  name: string;
  title?: string;
  icon?: string;
  description?: string;
  mode?: SkillMode;
  disableModelInvocation?: boolean;
  instructions: string;
}

const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidSkillName(name: string): boolean {
  return VALID_SKILL_NAME.test(name);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' ').trim());
}

export function parseSkillMarkdown(raw: string, fallbackName: string, filePath: string): SkillDefinition {
  const normalized = raw.replace(/\r\n/g, '\n');
  const meta: Record<string, string> = {};
  let body = normalized.trim();

  if (normalized.startsWith('---\n')) {
    const endIdx = normalized.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const header = normalized.slice(4, endIdx);
      body = normalized.slice(endIdx + 5).trim();
      for (const line of header.split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const val = unquote(line.slice(colon + 1));
        if (key) meta[key] = val;
      }
    }
  }

  const rawName = (meta.name || fallbackName).toLowerCase().trim();
  const name = isValidSkillName(rawName) ? rawName : fallbackName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const mode: SkillMode = meta.mode === 'act' ? 'act' : 'plan';
  const disableModelInvocation = meta['disable-model-invocation'] !== 'false';

  return {
    name,
    title: meta.title || `/${name}`,
    icon: meta.icon || '🪄',
    description: meta.description || '',
    mode,
    disableModelInvocation,
    instructions: body,
    filePath,
  };
}

export function serializeSkillMarkdown(input: SaveSkillInput): string {
  const name = input.name.trim().toLowerCase();
  const title = (input.title || `/${name}`).trim();
  const icon = (input.icon || '🪄').trim();
  const description = (input.description || '').trim();
  const mode: SkillMode = input.mode === 'act' ? 'act' : 'plan';
  const disable = input.disableModelInvocation !== false;
  const lines = [
    '---',
    `name: ${name}`,
    `title: ${quoteYaml(title)}`,
    `icon: ${quoteYaml(icon)}`,
    `description: ${quoteYaml(description)}`,
    `mode: ${mode}`,
    `disable-model-invocation: ${disable ? 'true' : 'false'}`,
    '---',
    '',
    input.instructions.trim(),
    '',
  ];
  return lines.join('\n');
}

const DEFAULT_ORDER = ['reframe', 'sharpen', 'in-your-own-words', 'blast-radius'];

export async function loadSkills(skillsDir: string): Promise<SkillDefinition[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const skills: SkillDefinition[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      try {
        const raw = await readFile(skillFile, 'utf8');
        const skill = parseSkillMarkdown(raw, entry.name, path.join(entry.name, 'SKILL.md'));
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          skills.push(skill);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const fallback = entry.name.slice(0, -3);
      const skillFile = path.join(skillsDir, entry.name);
      const raw = await readFile(skillFile, 'utf8');
      const skill = parseSkillMarkdown(raw, fallback, entry.name);
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push(skill);
      }
    }
  }

  skills.sort((a, b) => {
    const ai = DEFAULT_ORDER.indexOf(a.name);
    const bi = DEFAULT_ORDER.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  return skills;
}

export async function saveSkill(skillsDir: string, input: SaveSkillInput): Promise<SkillDefinition> {
  const name = input.name.trim().toLowerCase();
  if (!isValidSkillName(name)) {
    throw new Error('Имя навыка может содержать только латинские буквы, цифры и дефис (до 40 символов)');
  }
  const instructions = input.instructions?.trim();
  if (!instructions) {
    throw new Error('Напиши текст инструкции для навыка');
  }

  const dir = path.join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  const content = serializeSkillMarkdown({ ...input, name, instructions });
  await writeFile(filePath, content, 'utf8');
  return parseSkillMarkdown(content, name, path.join(name, 'SKILL.md'));
}

export async function deleteSkill(skillsDir: string, name: string): Promise<boolean> {
  const clean = name.trim().toLowerCase();
  if (!isValidSkillName(clean)) {
    throw new Error('Некорректное имя навыка');
  }

  let deleted = false;
  const dir = path.join(skillsDir, clean);
  try {
    await rm(dir, { recursive: true, force: false });
    deleted = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const flat = path.join(skillsDir, `${clean}.md`);
  try {
    await rm(flat, { force: false });
    deleted = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return deleted;
}

export interface SlashInvocation {
  skill: SkillDefinition;
  remainder: string;
}

export function matchSkillInvocation(
  prompt: string,
  skills: SkillDefinition[],
  explicitSkillName?: string,
): SlashInvocation | null {
  const cleanExplicit = explicitSkillName?.trim().toLowerCase();
  if (cleanExplicit) {
    const found = skills.find((s) => s.name === cleanExplicit);
    if (found) {
      const stripped = prompt.trim().replace(new RegExp(`^/${cleanExplicit}(?:\\s+|$)`, 'i'), '').trim();
      return { skill: found, remainder: stripped || prompt.trim() };
    }
  }

  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const cmd = match[1]!.toLowerCase();
  const found = skills.find((s) => s.name === cmd);
  if (!found) return null;

  return {
    skill: found,
    remainder: (match[2] ?? '').trim(),
  };
}

export function buildSkillSystemPrompt(skill: SkillDefinition): string {
  const header = [
    `[АКТИВНЫЙ НАВЫК: /${skill.name} — ${skill.title}]`,
    skill.mode === 'plan'
      ? 'ЭТОТ НАВЫК РАБОТАЕТ ТОЛЬКО В РЕЖИМЕ АНАЛИЗА: не меняй и не создавай файлы, не пиши код за пределами ответа.'
      : 'Навык разрешает работу с файлами проекта в пределах песочницы.',
    'Выполни инструкцию навыка ниже максимально точно, понятно для нетехнического пользователя и без воды:',
    '',
    skill.instructions,
  ];
  return header.join('\n');
}
