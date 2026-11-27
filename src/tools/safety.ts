export interface CommandSafetyResult {
  safe: boolean;
  reason?: string;
}

const DANGEROUS_RULES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\/(?:\s|$|\*)|~|\/home\b|\/Users\b|[A-Za-z]:\\)/i,
    reason: 'запрещено массовое удаление за пределами рабочей папки workspace',
  },
  {
    pattern: /\b(?:rmdir|rd)\s+\/s\b|\bdel\s+\/[a-zA-Z]*[sq]/i,
    reason: 'запрещено массовое удаление папок/файлов (rmdir /s, del /s)',
  },
  {
    pattern: /\b(?:format\s+[A-Za-z]:|mkfs(?:\.[a-z0-9]+)?|diskpart|bcdedit|cipher\s+\/w)\b/i,
    reason: 'запрещены команды форматирования или изменения разметки диска',
  },
  {
    pattern: /\bdd\s+if=/i,
    reason: 'запрещена низкоуровневая запись dd',
  },
  {
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i,
    reason: 'запрещено выключение или перезагрузка компьютера',
  },
  {
    pattern: /\breg\s+(?:delete|add)\b/i,
    reason: 'запрещено изменение реестра Windows',
  },
  {
    pattern: /(?:^|[;&|\s])cd\s+\.\.(?:[\\/\s;&|]|$)/i,
    reason: 'нельзя выходить командой cd за пределы песочницы workspace',
  },
  {
    pattern: /(?:^|[\s"'=])(?:\.\.[\\/])+/,
    reason: 'нельзя обращаться к родительским папкам (../ или ..\\) за пределами workspace',
  },
  {
    pattern: /(?:\/etc\/(?:passwd|shadow|sudoers)|~\/\.ssh|\.ssh[\\/]id_|%USERPROFILE%|C:\\Windows\b)/i,
    reason: 'запрещён доступ к системным файлам и ключам пользователя',
  },
  {
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+(?:--force|-f)\b)/i,
    reason: 'запрещены деструктивные команды git (reset --hard, clean -f, push --force)',
  },
];

/** Pre-execution safety guard inspired by cc-safety-net / DeepSeek Harness. */
export function checkBashCommandSafety(command: string): CommandSafetyResult {
  const text = String(command ?? '').trim();
  if (!text) return { safe: false, reason: 'пустая команда' };
  for (const rule of DANGEROUS_RULES) {
    if (rule.pattern.test(text)) {
      return { safe: false, reason: rule.reason };
    }
  }
  return { safe: true };
}
