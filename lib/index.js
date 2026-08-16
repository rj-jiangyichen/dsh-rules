/**
 * dsh-rules: glob-activated rule prompts for DeepSeek Harness.
 *
 * A host-plane Cordis plugin that discovers rule files (project
 * `<root>/.dsh/rules/*.md`, user `<dshHome>/rules/*.md`, and optionally
 * `# Path:` sections of CLAUDE.md / AGENTS.md), tracks the files each agent
 * reads or edits through `fs/observed`, and injects the currently active rule
 * set as a superseding user message at every `agent/pre-step`, Claude Code
 * rules.md style.
 *
 * @module dsh-rules
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { dshHomeDisplay, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { dirname, join, resolve } from "node:path";
import {
	EMPTY_RULES_TEXT,
	compileMatcher,
	mergeRuleSources,
	parseClaudePathSections,
	parseRuleFile,
	renderRules
} from "./rules.js";
import {
	findProjectRoot,
	listRuleDirEntries,
	posixRelative,
	readRuleText,
	statRuleFile
} from "./fs.js";

/** Stable Cordis provider name. */
const name = "dsh-rules";
/** Precedence ranks: lower wins. */
const PROJECT_RANK = 100;
const USER_RANK = 200;
const CLAUDE_SECTION_RANK = 300;

const DEFAULT_PROJECT_ROOT_MARKERS = [".git"];
const DEFAULT_RULE_DIR_NAMES = [".dsh/rules"];
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.local.md", "CLAUDE.local.md"];
const DEFAULT_MAX_BYTES = 32768;
const DEFAULT_MAX_SOURCE_BYTES = 1048576;
const DEFAULT_MAX_TOUCHED_PATHS = 512;
const RESERVED_PATH_SEGMENTS = new Set(["", ".", ".."]);
const USER_GLOBAL_INSTRUCTION_FILE = "AGENTS.md";

const Config = z.object({
	dshHome: z.string(),
	projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
	ruleDirNames: z.array(z.string()).default([...DEFAULT_RULE_DIR_NAMES]),
	includeUserRules: z.boolean().default(true),
	includeClaudeSections: z.boolean().default(false),
	instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
	localInstructionFileCandidates: z.array(z.string()).default([...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES]),
	maxBytes: z.number().default(DEFAULT_MAX_BYTES),
	maxSourceBytes: z.number().default(DEFAULT_MAX_SOURCE_BYTES),
	maxTouchedPaths: z.number().default(DEFAULT_MAX_TOUCHED_PATHS)
});

/**
 * Register the rules pipeline: touch tracking, per-session state, and
 * pre-step injection.
 * @param ctx - Cordis context (host plane).
 * @param config - plugin configuration.
 */
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	const state = new RulesState(ctx, resolved);
	ctx.on("fs/observed", (target, observation, actor) => {
		if (observation === void 0 || observation.kind === "absent") return;
		const agent = actor?.agent;
		if (agent === void 0) return;
		const displayPath = target?.displayPath;
		if (typeof displayPath !== "string" || displayPath.length === 0) return;
		state.touch(agent, displayPath).catch((error) => {
			ctx.logger.warn(`dsh-rules: failed to record touched path: ${errorMessage(error)}`);
		});
	});
	ctx.on("agent/disposed", ({ agent }) => {
		state.disposeSession(agent);
	});
	ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
		const decision = await next();
		if (decision.kind !== "enter" || agent === void 0) return decision;
		try {
			const desired = await state.compose(agent, signal);
			if (desired === void 0 || decision.messages.some((message) => sameRulesMessage(message, desired))) return decision;
			const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
			return {
				kind: "enter",
				messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
			};
		} catch (error) {
			if (signal?.aborted === true) throw error;
			ctx.logger.warn(`dsh-rules: rule injection failed: ${errorMessage(error)}`);
			return decision;
		}
	});
}

/** Normalize plugin configuration and harness home. */
function resolveConfig(config) {
	return {
		dshHome: resolveDshHome(config.dshHome),
		projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
		ruleDirNames: cleanPathSegments(config.ruleDirNames, DEFAULT_RULE_DIR_NAMES),
		includeUserRules: config.includeUserRules ?? true,
		includeClaudeSections: config.includeClaudeSections ?? false,
		instructionFileCandidates: cleanPathSegments(config.instructionFileCandidates, DEFAULT_INSTRUCTION_FILE_CANDIDATES),
		localInstructionFileCandidates: cleanPathSegments(config.localInstructionFileCandidates, DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES),
		maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
		maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
		maxTouchedPaths: config.maxTouchedPaths ?? DEFAULT_MAX_TOUCHED_PATHS
	};
}

function cleanPathSegments(candidates, fallback) {
	return (candidates ?? [...fallback]).filter((candidate) => !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate));
}

/** Per-process rules state: versioned rule caches and per-session touch sets. */
var RulesState = class {
	ctx;
	resolved;
	fileSystem;
	/** sessionId -> insertion-ordered relative path map (FIFO eviction). */
	touched = /* @__PURE__ */ new Map();
	/** sessionId -> last injected snapshot text (`null` = none yet injected). */
	lastInjected = /* @__PURE__ */ new Map();
	/** sessionId -> cached project root promise. */
	projectRoots = /* @__PURE__ */ new Map();
	/** absolute rule-source path -> version-cached raw text. */
	fileCache = /* @__PURE__ */ new Map();
	/** absolute paths already warned about this process. */
	warned = /* @__PURE__ */ new Set();
	constructor(ctx, resolved) {
		this.ctx = ctx;
		this.resolved = resolved;
		this.fileSystem = ctx.get("fs");
	}
	/**
	* Record one observed file for an agent's session, relative to its project
	* root. Files outside the project root never activate rules.
	* @param agent - the agent whose session observed the file.
	* @param displayPath - host display path of the observed target.
	*/
	async touch(agent, displayPath) {
		const sessionId = agent.session.id;
		const projectRoot = await this.projectRootFor(agent);
		const relativePath = posixRelative(projectRoot, displayPath);
		if (relativePath === void 0) return;
		let set = this.touched.get(sessionId);
		if (set === void 0) {
			set = /* @__PURE__ */ new Map();
			this.touched.set(sessionId, set);
		}
		set.delete(relativePath);
		set.set(relativePath, true);
		while (set.size > this.resolved.maxTouchedPaths) {
			const oldest = set.keys().next().value;
			set.delete(oldest);
		}
	}
	/**
	* Resolve and cache the project root for an agent's session cwd.
	* @param agent - the agent owning the session.
	* @returns the absolute project root.
	*/
	projectRootFor(agent) {
		const sessionId = agent.session.id;
		let cached = this.projectRoots.get(sessionId);
		if (cached === void 0) {
			const cwd = agent.session.header.cwd ?? process.cwd();
			cached = findProjectRoot(cwd, this.resolved.projectRootMarkers, this.fileSystem, void 0).catch((error) => {
				this.projectRoots.delete(sessionId);
				throw error;
			});
			this.projectRoots.set(sessionId, cached);
		}
		return cached;
	}
	/** Drop every per-session state entry owned by a disposed agent. */
	disposeSession(agent) {
		const sessionId = agent.session.id;
		this.touched.delete(sessionId);
		this.lastInjected.delete(sessionId);
		this.projectRoots.delete(sessionId);
	}
	/**
	* Compute the desired rules snapshot message for one agent's next step.
	* Returns `undefined` when nothing should be injected (rules unchanged or
	* nothing active and nothing previously injected).
	* @param agent - the agent about to step.
	* @param signal - turn cancellation.
	* @returns the message to inject, or `undefined`.
	*/
	async compose(agent, signal) {
		const { maxBytes } = this.resolved;
		if (!(maxBytes > 0) || !Number.isFinite(maxBytes)) return void 0;
		const session = agent.session;
		const sessionId = session.id;
		if (!this.lastInjected.has(sessionId)) this.seedFromSession(session);
		signal?.throwIfAborted();
		const cwd = session.header.cwd ?? process.cwd();
		const projectRoot = await this.projectRootFor(agent);
		signal?.throwIfAborted();
		const rules = await this.loadRules(projectRoot, cwd, signal);
		signal?.throwIfAborted();
		const touched = this.touched.get(sessionId);
		const active = [];
		const matchedFiles = /* @__PURE__ */ new Set();
		for (const rule of rules) {
			if (rule.globs.length === 0) {
				active.push(rule);
				continue;
			}
			let matched = false;
			if (touched !== void 0) for (const relativePath of touched.keys()) {
				if (rule.matcher(relativePath)) {
					matched = true;
					matchedFiles.add(relativePath);
				}
			}
			if (matched) active.push(rule);
		}
		const desiredText = active.length === 0
			? null
			: renderRules(active, {
					maxBytes,
					matchedFiles: [...matchedFiles].sort()
				}).text;
		const previous = this.lastInjected.get(sessionId);
		if (desiredText === null) {
			if (previous === void 0 || previous === null || previous === EMPTY_RULES_TEXT) return void 0;
			this.lastInjected.set(sessionId, EMPTY_RULES_TEXT);
			return rulesMessage(EMPTY_RULES_TEXT);
		}
		if (previous === desiredText) return void 0;
		this.lastInjected.set(sessionId, desiredText);
		return rulesMessage(desiredText);
	}
	/** Restore the last injected snapshot (and matched files) from a resumed session log. */
	seedFromSession(session) {
		const events = session.events;
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== "user/message") continue;
			const source = event.data?.source;
			if (source?.kind !== "plugin" || source.plugin !== name || source.form !== "rules") continue;
			const [block] = event.data.content;
			const text = event.data.content.length === 1 && block?.type === "text" ? block.text : void 0;
			if (text === void 0) break;
			this.lastInjected.set(session.id, text);
			this.seedTouchedFromText(session.id, text);
			return;
		}
		this.lastInjected.set(session.id, null);
	}
	/** Recover previously matched relative paths from a rendered snapshot intro. */
	seedTouchedFromText(sessionId, text) {
		const match = /\(matched files: ([^)]*)\)/.exec(text);
		if (match === null) return;
		const paths = match[1].split(", ").map((item) => unescapeAttr(item.trim())).filter((item) => item.length > 0);
		if (paths.length === 0) return;
		let set = this.touched.get(sessionId);
		if (set === void 0) {
			set = /* @__PURE__ */ new Map();
			this.touched.set(sessionId, set);
		}
		for (const path of paths) set.set(path, true);
	}
	/**
	* Discover and parse every rule source for one workspace, version-cached.
	* @param projectRoot - absolute project root.
	* @param cwd - absolute session working directory.
	* @param signal - cancellation for filesystem work.
	* @returns the merged, precedence-ordered rule catalog.
	*/
	async loadRules(projectRoot, cwd, signal) {
		const groups = [];
		const projectRules = [];
		for (const dirName of this.resolved.ruleDirNames) {
			const entries = await listRuleDirEntries(join(projectRoot, dirName), this.fileSystem, signal);
			if (entries === void 0 || entries === null) continue;
			for (const entry of entries) {
				if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
				const rule = await this.loadFlatRule(join(projectRoot, dirName, entry.name), `${dirName}/${entry.name}`, entry.name.slice(0, -3), PROJECT_RANK, signal);
				if (rule !== void 0) projectRules.push(rule);
			}
		}
		groups.push({ rank: PROJECT_RANK, rules: projectRules });
		const userRules = [];
		if (this.resolved.includeUserRules) {
			const userDir = join(this.resolved.dshHome, "rules");
			const entries = await listRuleDirEntries(userDir, this.fileSystem, signal);
			if (entries !== void 0 && entries !== null) {
				const displayRoot = `${dshHomeDisplay(this.resolved.dshHome)}/rules`;
				for (const entry of entries) {
					if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
					const rule = await this.loadFlatRule(join(userDir, entry.name), `${displayRoot}/${entry.name}`, entry.name.slice(0, -3), USER_RANK, signal);
					if (rule !== void 0) userRules.push(rule);
				}
			}
		}
		groups.push({ rank: USER_RANK, rules: userRules });
		const claudeRules = [];
		if (this.resolved.includeClaudeSections) {
			const candidates = [
				join(this.resolved.dshHome, USER_GLOBAL_INSTRUCTION_FILE),
				...ancestorChain(projectRoot, cwd).flatMap((dir) => [
					...this.resolved.instructionFileCandidates,
					...this.resolved.localInstructionFileCandidates
				].map((candidate) => join(dir, candidate)))
			];
			for (const filePath of candidates) {
				const sections = await this.loadClaudeSections(filePath, projectRoot, signal);
				if (sections !== void 0) claudeRules.push(...sections);
			}
		}
		groups.push({ rank: CLAUDE_SECTION_RANK, rules: claudeRules });
		const merged = mergeRuleSources(groups);
		for (const dropped of merged.dropped) this.warnOnce(`rule "${dropped.name}" (${dropped.source}) ignored: a higher-priority rule with the same name exists`);
		return merged.rules;
	}
	/** Load and parse one flat rule file through the version cache. */
	async loadFlatRule(filePath, source, fallbackName, rank, signal) {
		const raw = await this.loadCachedText(filePath, signal);
		if (raw === void 0) return void 0;
		const rule = parseRuleFile(raw, fallbackName);
		if (rule === void 0) {
			this.warnOnce(`rule file ${filePath} ignored: missing or invalid frontmatter (requires a markdown body and, when present, a valid \`path\` field)`);
			return void 0;
		}
		let matcher = null;
		if (rule.globs.length > 0) {
			const compiled = compileMatcher(rule.globs);
			if (!compiled.valid) {
				this.warnOnce(`rule file ${filePath} ignored: invalid glob pattern: ${errorMessage(compiled.error)}`);
				return void 0;
			}
			matcher = compiled.match;
		}
		return {
			name: rule.name,
			rank,
			source,
			globs: rule.globs,
			matcher,
			content: rule.content
		};
	}
	/** Load and parse `# Path:` sections from one instruction file. */
	async loadClaudeSections(filePath, projectRoot, signal) {
		const raw = await this.loadCachedText(filePath, signal);
		if (raw === void 0) return void 0;
		const display = posixRelative(projectRoot, filePath) ?? filePath;
		return parseClaudePathSections(raw).flatMap((section, index) => {
			const compiled = compileMatcher(section.globs);
			if (!compiled.valid) {
				this.warnOnce(`rule section ${display}#${index} ignored: invalid glob pattern: ${errorMessage(compiled.error)}`);
				return [];
			}
			return [{
				name: `${display}:${index}`,
				rank: CLAUDE_SECTION_RANK,
				source: display,
				globs: section.globs,
				matcher: compiled.match,
				content: section.content
			}];
		});
	}
	/** Read a rule source through the version cache, re-parsing only on change. */
	async loadCachedText(filePath, signal) {
		const probe = await statRuleFile(filePath, this.fileSystem, signal);
		if (probe.kind === "absent") {
			this.fileCache.delete(filePath);
			return void 0;
		}
		const cached = this.fileCache.get(filePath);
		if (probe.kind === "unavailable") return cached?.raw;
		if (cached !== void 0 && cached.version === probe.version) return cached.raw;
		if (probe.size !== void 0 && probe.size > this.resolved.maxSourceBytes) {
			this.warnOnce(`rule source ${filePath} ignored: exceeds maxSourceBytes (${probe.size} > ${this.resolved.maxSourceBytes})`);
			return void 0;
		}
		const raw = await readRuleText(filePath, this.fileSystem, signal, this.resolved.maxSourceBytes);
		if (raw === void 0) return void 0;
		this.fileCache.set(filePath, { version: probe.version, raw });
		return raw;
	}
	warnOnce(message) {
		if (this.warned.has(message)) return;
		this.warned.add(message);
		this.ctx.logger.warn(`dsh-rules: ${message}`);
	}
};

/** Build the user-role message carrying one rules snapshot. */
function rulesMessage(text) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: "plugin", plugin: name, form: "rules" }
	});
}

/** Whether one message is our rules snapshot with the same text as another. */
function sameRulesMessage(message, desired) {
	if (message.source?.kind !== "plugin" || message.source?.plugin !== name) return false;
	const [block] = message.content;
	const text = message.content.length === 1 && block?.type === "text" ? block.text : void 0;
	const [desiredBlock] = desired.content;
	const desiredText = desired.content.length === 1 && desiredBlock?.type === "text" ? desiredBlock.text : void 0;
	return text !== void 0 && text === desiredText;
}

/** Directories from the project root down to (and including) cwd. */
function ancestorChain(projectRoot, cwd) {
	const dirs = [];
	let current = resolve(cwd);
	const root = resolve(projectRoot);
	while (true) {
		dirs.push(current);
		if (current === root) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

/** Reverse of escapeAttr for recovered snapshot text. */
function unescapeAttr(value) {
	return value.replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function errorMessage(error) {
	try {
		return String(error);
	} catch {
		return "[unrenderable thrown value]";
	}
}

export { Config, apply, name };
