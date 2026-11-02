/** File-activated rules, with one project-owned catalog and executor-scoped reads. */
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { ProjectRulesState, replaceRuleMessages } from './project-rules.js';

export const name = 'dsh-rules';
const DEFAULT_RULE_DIRECTORIES = ['.dsh/rules'];
const safeRelative = value => typeof value === 'string' && !/^[A-Za-z]:|^[\\/]/.test(value)
  && value.split(/[\\/]/).every(part => part && part !== '.' && part !== '..');

export const Config = z.object({
  dshHome: z.string(),
  projectRootMarkers: z.array(z.string()).default(['.git']),
  ruleDirNames: z.array(z.string()).default(DEFAULT_RULE_DIRECTORIES),
  includeUserRules: z.boolean().default(true),
  includeClaudeSections: z.boolean().default(false),
  instructionFileCandidates: z.array(z.string()).default(['AGENTS.md', 'CLAUDE.md']),
  localInstructionFileCandidates: z.array(z.string()).default(['AGENTS.local.md', 'CLAUDE.local.md']),
  maxBytes: z.number().default(32768),
  maxSourceBytes: z.number().default(1048576),
  maxTouchedPaths: z.number().default(512),
});

export function apply(ctx, config = {}) {
  const list = (field, fallback) => {
    const configured = config[field] ?? fallback;
    const valid = configured.filter(safeRelative);
    if (valid.length !== configured.length) ctx.logger.warn(`dsh-rules: ignored unsafe config.${field} entries`);
    return valid;
  };
  const state = new ProjectRulesState(ctx, {
    ...config,
    dshHome: resolveDshHome(config.dshHome),
    projectRootMarkers: config.projectRootMarkers ?? ['.git'],
    ruleDirNames: list('ruleDirNames', DEFAULT_RULE_DIRECTORIES),
    instructionFileCandidates: list('instructionFileCandidates', ['AGENTS.md', 'CLAUDE.md']),
    localInstructionFileCandidates: list('localInstructionFileCandidates', ['AGENTS.local.md', 'CLAUDE.local.md']),
    includeUserRules: config.includeUserRules ?? true,
    includeClaudeSections: config.includeClaudeSections ?? false,
    maxBytes: config.maxBytes ?? 32768,
    maxSourceBytes: config.maxSourceBytes ?? 1048576,
    maxTouchedPaths: config.maxTouchedPaths ?? 512,
  });
  ctx.on('fs/observed', (target, observation, actor) => {
    if (observation?.kind === 'absent' || !observation || !actor?.agent || !target?.displayPath) return;
    return state.observe(actor.agent, target);
  });
  ctx.on('agent/disposed', ({ agent }) => state.disposeSession(agent));
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || !agent) return decision;
    const desired = await state.compose(agent, signal);
    const messages = replaceRuleMessages(decision.messages, desired);
    if (messages.length === decision.messages.length && messages.every((message, index) => message === decision.messages[index])) return decision;
    return { ...decision, messages };
  });
}
