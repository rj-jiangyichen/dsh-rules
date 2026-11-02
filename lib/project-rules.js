import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm';
import { dirname, join, resolve, relative } from './paths.js';
import { findProjectRoot, posixRelative, listRuleDirEntries, readRuleText, statRuleFile } from './fs.js';
import { EMPTY_RULES_TEXT, compileMatcher, mergeRuleSources, parseRuleFile, parseClaudePathSections, renderRules, snapshotKey } from './rules.js';

export function isRulesMessage(message) {
  const source = message?.source;
  return source?.kind === 'plugin:dsh-rules'
    || source?.kind === 'plugin' && source.plugin === 'dsh-rules'
    || source?.kind === 'plugin:dsh-claude-compat' && source.form === 'rules';
}

const messageText = message => message?.content?.length === 1 && message.content[0].type === 'text' ? message.content[0].text : undefined;
const samePath = (left, right) => relative(left, right) === '';

/** Configuration is project-owned. Only observed paths and published snapshots are session state. */
export class ProjectRulesState {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.observed = new Map();
    this.pending = new Map();
    this.closed = new Set();
    this.cache = new WeakMap();
    this.localCache = new Map();
    this.snapshots = new Map();
    this.warnings = new Set();
  }

  async context(agent, signal) {
    const provider = this.ctx.get('platformProjectConfig');
    if (provider) return provider.resolve(agent, signal);
    if (this.ctx.get('platformExecution')?.bindingFor(agent.id)) throw new Error('Project rules require the bound configuration service');
    const service = key => this.ctx.get('agentPresets')?.serviceFor(agent, key) ?? this.ctx.get(key);
    const fs = service('fs');
    const workingDirectory = service('workingDirectory');
    const cwd = workingDirectory?.ensure ? await workingDirectory.ensure(agent, signal)
      : workingDirectory?.get(agent.session) ?? agent.session.header.cwd;
    if (!cwd) throw new Error('Rules require an explicit working directory');
    return { fs, cwd, checkoutRoot: await findProjectRoot(cwd, this.config.projectRootMarkers, fs, signal) };
  }

  observe(agent, path) {
    if (this.closed.has(agent.session.id)) return Promise.resolve();
    let operations = this.pending.get(agent.session.id);
    if (!operations) this.pending.set(agent.session.id, operations = new Set());
    const pending = this.touch(agent, path);
    operations.add(pending);
    pending.catch(error => this.warn(`Cannot observe ${path}: ${String(error)}`)).finally(() => operations.delete(pending));
    return pending;
  }

  async touch(agent, target) {
    const context = await this.context(agent);
    const path = typeof target === 'string' ? target : context.fs?.processPath(target) ?? target.displayPath;
    if (this.closed.has(agent.session.id)) return;
    if (posixRelative(context.checkoutRoot, path) === undefined) return;
    this.seed(agent, context.checkoutRoot);
    let paths = this.observed.get(agent.session.id);
    if (!paths) this.observed.set(agent.session.id, paths = new Map());
    paths.delete(path);
    paths.set(path, true);
    while (paths.size > this.config.maxTouchedPaths) paths.delete(paths.keys().next().value);
  }

  disposeSession(agent) {
    this.closed.add(agent.session.id);
    this.pending.delete(agent.session.id);
    this.observed.delete(agent.session.id);
    this.snapshots.delete(agent.session.id);
  }

  seed(agent, root) {
    if (this.observed.has(agent.session.id)) return;
    const paths = new Map();
    for (const event of [...agent.session.snapshotEvents()].reverse()) {
      if (event.type !== 'user/message' || !isRulesMessage(event.data)) continue;
      const text = messageText(event.data);
      if (text) this.snapshots.set(agent.session.id, event.data);
      const match = text?.match(/\(matched files: ([^)]*)\)/);
      if (match) for (const item of match[1].split(', ')) {
        const path = resolve(root, item.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
        if (posixRelative(root, path) !== undefined) paths.set(path, true);
      }
      break;
    }
    this.observed.set(agent.session.id, paths);
  }

  async compose(agent, signal) {
    if (!(this.config.maxBytes > 0) || !Number.isFinite(this.config.maxBytes)) return undefined;
    await Promise.all([...(this.pending.get(agent.session.id) ?? [])]);
    const context = await this.context(agent, signal);
    this.seed(agent, context.checkoutRoot);
    const touched = this.observed.get(agent.session.id);
    const owners = new Set([context.checkoutRoot]);
    const addAncestors = directory => {
      let current = directory;
      while (posixRelative(context.checkoutRoot, current) !== undefined) {
        owners.add(current);
        if (samePath(current, context.checkoutRoot)) break;
        current = dirname(current);
      }
    };
    addAncestors(context.cwd);
    for (const path of touched.keys()) addAncestors(dirname(path));
    const groups = [];
    for (const owner of [...owners].sort()) {
      const scope = posixRelative(context.checkoutRoot, owner);
      groups.push(...await this.catalog(context, owner, scope === '.' ? '' : scope, 100, signal));
      if (this.config.includeClaudeSections) {
        const rules = [];
        for (const candidate of [...this.config.instructionFileCandidates, ...this.config.localInstructionFileCandidates]) {
          const path = join(owner, candidate);
          const info = await statRuleFile(path, context.fs, signal);
          if (info.kind === 'absent') continue;
          const raw = await this.text(path, context.fs, signal);
          for (const [index, section] of parseClaudePathSections(raw).entries()) {
            const compiled = compileMatcher(section.globs);
            if (compiled.valid) rules.push({ ...section, name: `${candidate}:${index}`, identity: `${scope}:${candidate}:${index}`,
              owner, rank: 300, source: path, matcher: compiled.match });
          }
        }
        groups.push({ rank: 300, rules });
      }
    }
    if (this.config.includeUserRules) {
      const local = !context.executorId;
      const userRoot = context.userConfigRoot ?? (local ? dirname(this.config.dshHome) : undefined);
      if (userRoot) {
        const dshHome = local ? this.config.dshHome : join(userRoot, '.dsh');
        const directories = this.config.ruleDirNames.map(name => name === '.dsh/rules' ? join(dshHome, 'rules') : join(userRoot, name));
        groups.push(...await this.catalog(context, context.checkoutRoot, '', 200, signal, directories));
      }
    }
    const { rules } = mergeRuleSources(groups);
    const active = [], matchedFiles = new Set();
    for (const rule of rules) {
      if (!rule.matcher) { active.push(rule); continue; }
      let applies = false;
      for (const path of touched.keys()) {
        const scoped = posixRelative(rule.owner, path);
        if (scoped !== undefined && rule.matcher(scoped)) {
          applies = true;
          matchedFiles.add(posixRelative(context.checkoutRoot, path));
        }
      }
      if (applies) active.push(rule);
    }
    const rendered = active.length ? renderRules(active, { maxBytes: this.config.maxBytes, matchedFiles: [...matchedFiles].sort() }) : undefined;
    if (rendered?.omitted.length || rendered?.truncated.length) this.warn(`Rules budget reached for ${context.checkoutRoot}: omitted ${rendered.omitted.length}, truncated ${rendered.truncated.length}`);
    const text = rendered?.text ?? EMPTY_RULES_TEXT;
    const previous = this.snapshots.get(agent.session.id);
    if (!active.length && !previous) return undefined;
    if (previous && previous.source?.kind === 'plugin:dsh-rules' && snapshotKey(messageText(previous)) === snapshotKey(text)) return previous;
    const snapshot = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-rules', form: 'notice', summary: boundContextSummary(active.length ? `Active rules: ${active.map(rule => rule.name).join(', ')}` : 'No active rules') },
    });
    this.snapshots.set(agent.session.id, snapshot);
    return snapshot;
  }

  async catalog(context, owner, scope, baseRank, signal, directories) {
    const groups = [];
    const roots = directories ?? this.config.ruleDirNames.map(name => join(owner, name));
    for (let index = 0; index < roots.length; index++) {
      const rules = [];
      for (const file of await this.walk(roots[index], context.fs, signal)) {
        const raw = await this.text(file.path, context.fs, signal);
        if (raw === undefined) continue;
        const name = file.relative.split('/').at(-1).replace(/\.md$/, '');
        const rule = parseRuleFile(raw, name);
        if (!rule) { this.warn(`Invalid rule frontmatter: ${file.path}`); continue; }
        const compiled = rule.globs.length ? compileMatcher(rule.globs) : undefined;
        if (compiled && !compiled.valid) { this.warn(`Invalid rule glob: ${file.path}`); continue; }
        rules.push({ ...rule, identity: `${scope}:${file.relative}`, owner,
          rank: baseRank + index, source: file.path, matcher: compiled?.match });
      }
      groups.push({ rank: baseRank + index, rules });
    }
    return groups;
  }

  async walk(root, fs, signal, prefix = '') {
    const entries = await listRuleDirEntries(join(root, prefix), fs, signal);
    if (entries === null) throw new Error(`Rule directory unavailable: ${join(root, prefix)}`);
    const result = [];
    for (const entry of (entries ?? []).sort((left, right) => left.name.localeCompare(right.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'directory') result.push(...await this.walk(root, fs, signal, name));
      else if (entry.type === 'file' && entry.name.endsWith('.md')) result.push({ path: join(root, name), relative: name });
    }
    return result;
  }

  async text(path, fs, signal) {
    let cache = this.localCache;
    if (fs) {
      cache = this.cache.get(fs);
      if (!cache) this.cache.set(fs, cache = new Map());
    }
    const info = await statRuleFile(path, fs, signal);
    if (info.kind === 'absent') { cache.delete(path); return undefined; }
    if (info.kind === 'unavailable') throw new Error(`Rule source unavailable: ${path}`);
    if (info.size > this.config.maxSourceBytes) throw new Error(`Rule source exceeds maxSourceBytes: ${path}`);
    const cached = cache.get(path);
    if (cached?.version === info.version) return cached.text;
    const text = await readRuleText(path, fs, signal, this.config.maxSourceBytes);
    if (text === undefined) throw new Error(`Cannot read rule source: ${path}`);
    cache.set(path, { version: info.version, text });
    return text;
  }

  warn(text) {
    if (this.warnings.has(text)) return;
    this.warnings.add(text);
    this.ctx.logger.warn(`dsh-rules: ${text}`);
  }
}

/** Replace only producer-owned snapshots; human messages and durable history remain intact. */
export function replaceRuleMessages(messages, desired) {
  if (!desired) return messages.filter(message => !isRulesMessage(message));
  const existing = messages.findLast(message => isRulesMessage(message)
    && message.source?.kind === 'plugin:dsh-rules' && messageText(message) === messageText(desired));
  const kept = messages.filter(message => !isRulesMessage(message));
  return [...kept, existing ?? desired];
}
