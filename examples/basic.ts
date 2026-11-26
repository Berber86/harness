/**
 * Real-provider example:
 *   ANTHROPIC_API_KEY=... npm run basic -- "Исправь баг в src/..."
 *   OPENAI_API_KEY=... PROVIDER=openai MODEL=gpt-4.1-mini npm run basic -- "..."
 */
import { Agent, Session } from '../src/index.js';
import type { ModelConfig } from '../src/index.js';

const providerName = process.env.PROVIDER ?? 'anthropic';
const model: ModelConfig =
  providerName === 'anthropic'
    ? { provider: 'anthropic', model: process.env.MODEL ?? 'claude-sonnet-4-5' }
    : { provider: providerName, model: process.env.MODEL ?? 'gpt-4.1-mini' };

const sessionId = process.env.SESSION_ID;
const session = sessionId ? await Session.load(sessionId) : undefined;
const agent = new Agent({
  model,
  session: session ?? undefined,
  cwd: process.cwd(),
  systemPrompt:
    'You are a careful coding agent. Read files before editing, make minimal changes, and explain what you did.',
});

const prompt = process.argv.slice(2).join(' ') || 'Что изменилось в этом проекте?';
for await (const event of agent.stream(prompt)) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.text);
      break;
    case 'tool_start':
      console.log(`\n→ ${event.call.name} ${JSON.stringify(event.call.arguments)}`);
      break;
    case 'tool_end':
      console.log(`← ${event.result.content.slice(0, 300)}`);
      break;
    case 'compacted':
      console.log(`\n[context compacted: ${event.removedMessages} messages]`);
      break;
    case 'error':
      console.error(`\n[error] ${event.error.message}`);
      break;
    case 'done':
      console.log(
        `\n[${event.result.stopReason} · ${event.result.turns} turns · ${(await agent.getSession()).id}]`,
      );
      break;
  }
}
