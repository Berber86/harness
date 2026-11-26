export { Agent, createAgent } from './agent.js';
export type { AgentOptions, RunOptions } from './agent.js';
export { runAgentLoop } from './loop.js';
export type { AgentLoopOptions, AuthorizeHandler, LoopDetectionOptions } from './loop.js';
export {
  DEFAULT_ROLE_PRESETS,
  buildLeadSystemPrompt,
  createDelegateTool,
  createToolsForRole,
} from './roles.js';
export type { AgentRole, DefaultRolePreset, DelegateToolOptions, RoleToolName } from './roles.js';
