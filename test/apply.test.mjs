import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

// ── apply(): configuration and project rule discovery ───────────────────────

/** Minimal Cordis-like context: records handlers and warnings; `get("fs")`
 *  stays undefined so lib/fs.js falls back to the node filesystem. */
function fakeContext() {
	const context = {
		handlers: /* @__PURE__ */ new Map(),
		warnings: [],
		get() {
			return void 0;
		},
		on(event, handler) {
			context.handlers.set(event, handler);
		},
		logger: {
			warn(message) {
				context.warnings.push(message);
			},
			info() {},
			error() {}
		}
	};
	return context;
}

/** Minimal session surface the plugin consumes: `id`, `header.cwd`, and the
 *  event log through `snapshotEvents()` — the accessor the current
 *  @deepseek-ai/dsh-session exposes. The older `session.events` array is gone,
 *  so reading it here would throw instead of injecting. */
function fakeAgent(cwd, sessionId, events = []) {
	return { session: { id: sessionId, header: { cwd }, snapshotEvents: () => events } };
}

/** Run one agent/pre-step through the registered handler. */
async function runPreStep(context, agent) {
	const handler = context.handlers.get("agent/pre-step");
	assert.equal(typeof handler, "function");
	return handler({ agent, messages: [], signal: void 0 }, async () => ({ kind: "enter", messages: [] }));
}

/** Record one observed file the way the harness reports it (see apply()'s
 *  `fs/observed` listener). Touch tracking is fire-and-forget: wait for the
 *  effect through {@link pump} (uncached project root) or {@link settle}. */
function observe(context, agent, displayPath) {
	const handler = context.handlers.get("fs/observed");
	assert.equal(typeof handler, "function");
	handler({ displayPath }, { kind: "read" }, { agent });
}

/** Drive pre-steps, appending every injected snapshot text to `injected`, until
 *  `predicate` is satisfied. Use while a session's project root is still being
 *  resolved (the first touch does real filesystem work). */
async function pump(context, agent, injected, predicate) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const decision = await runPreStep(context, agent);
		injected.push(...decision.messages.map((message) => message.content[0].text));
		if (predicate(injected)) return injected;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`condition not met after 200 steps; injected ${injected.length} snapshot(s)`);
}

/** Let a touch whose project root is already cached land: `touch()` then only
 *  awaits a settled promise, so its bookkeeping runs in the microtask queue
 *  ahead of this macrotask. */
function settle() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Temp workspace with a `<workspace>/project` root marked by `.git`. */
async function makeProject() {
	const workspace = await mkdtemp(join(tmpdir(), "dsh-rules-"));
	const projectRoot = join(workspace, "project");
	await mkdir(join(projectRoot, ".git"), { recursive: true });
	return { workspace, projectRoot };
}

/** Isolated plugin config: temp dsh home, user rules off — only project rule
 *  discovery is under test. */
function projectOnlyConfig(projectRoot) {
	return { dshHome: join(projectRoot, "dsh-home"), includeUserRules: false };
}

function injectedText(decision) {
	return decision.messages.map((message) => message.content[0].text).join("\n\n");
}

test("apply: default config discovers project rules in .dsh/rules", async () => {
	const { workspace, projectRoot } = await makeProject();
	try {
		await mkdir(join(projectRoot, ".dsh", "rules"), { recursive: true });
		await writeFile(join(projectRoot, ".dsh", "rules", "style.md"), "---\n---\nDefault project rule.\n");
		const context = fakeContext();
		apply(context, projectOnlyConfig(projectRoot));
		const decision = await runPreStep(context, fakeAgent(projectRoot, "default-config"));
		assert.match(injectedText(decision), /Default project rule\./);
		assert.deepEqual(context.warnings, []);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("apply: configured multi-segment ruleDirNames load", async () => {
	const { workspace, projectRoot } = await makeProject();
	try {
		await mkdir(join(projectRoot, ".dsh", "rules"), { recursive: true });
		await mkdir(join(projectRoot, "custom", "rules-dir"), { recursive: true });
		await writeFile(join(projectRoot, ".dsh", "rules", "dot.md"), "---\n---\nDot directory rule.\n");
		await writeFile(join(projectRoot, "custom", "rules-dir", "custom.md"), "---\n---\nCustom directory rule.\n");
		const context = fakeContext();
		apply(context, { ...projectOnlyConfig(projectRoot), ruleDirNames: [".dsh/rules", "custom/rules-dir"] });
		const decision = await runPreStep(context, fakeAgent(projectRoot, "explicit-config"));
		const text = injectedText(decision);
		assert.match(text, /Dot directory rule\./);
		assert.match(text, /Custom directory rule\./);
		assert.deepEqual(context.warnings, []);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("apply: ruleDirNames entries cannot escape the project root", async () => {
	const { workspace, projectRoot } = await makeProject();
	try {
		await mkdir(join(workspace, "outside", "rules"), { recursive: true });
		await writeFile(join(workspace, "outside", "rules", "escape.md"), "---\n---\nEscaped project rule.\n");
		const context = fakeContext();
		apply(context, { ...projectOnlyConfig(projectRoot), ruleDirNames: ["../outside/rules"] });
		const decision = await runPreStep(context, fakeAgent(projectRoot, "escape-attempt"));
		assert.equal(decision.messages.length, 0);
		assert.match(context.warnings.join("\n"), /config\.ruleDirNames/);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("apply: explicitly empty ruleDirNames disables project rule discovery", async () => {
	const { workspace, projectRoot } = await makeProject();
	try {
		await mkdir(join(projectRoot, ".dsh", "rules"), { recursive: true });
		await writeFile(join(projectRoot, ".dsh", "rules", "style.md"), "---\n---\nIgnored project rule.\n");
		const context = fakeContext();
		apply(context, { ...projectOnlyConfig(projectRoot), ruleDirNames: [] });
		const decision = await runPreStep(context, fakeAgent(projectRoot, "empty-config"));
		assert.equal(decision.messages.length, 0);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

// ── apply(): UI-visible rule activation notice ───────────────────────────────

test("apply: injected rules message carries a one-line notice for the UI row", async () => {
	const { workspace, projectRoot } = await makeProject();
	try {
		await mkdir(join(projectRoot, ".dsh", "rules"), { recursive: true });
		await writeFile(join(projectRoot, ".dsh", "rules", "style.md"), "---\n---\nAlways-on rule.\n");
		await writeFile(join(projectRoot, ".dsh", "rules", "typescript.md"), "---\npath: \"**/*.ts\"\n---\nTS rule.\n");
		const context = fakeContext();
		apply(context, projectOnlyConfig(projectRoot));
		const decision = await runPreStep(context, fakeAgent(projectRoot, "notice-summary"));
		assert.equal(decision.messages.length, 1);
		const message = decision.messages[0];
		assert.equal(message.role, "user");
		assert.equal(message.source.kind, "plugin");
		assert.equal(message.source.plugin, "dsh-rules");
		assert.equal(message.source.form, "notice");
		assert.match(message.source.summary, /^Active rules: style$/);
		assert.match(message.content[0].text, /Always-on rule\./);
		assert.deepEqual(context.warnings, []);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("apply: clearing an active snapshot injects a No active rules notice", async () => {
	const { workspace, projectRoot } = await makeProject();
	try {
		await mkdir(join(projectRoot, ".dsh", "rules"), { recursive: true });
		const ruleFile = join(projectRoot, ".dsh", "rules", "style.md");
		await writeFile(ruleFile, "---\n---\nAlways-on rule.\n");
		const context = fakeContext();
		apply(context, projectOnlyConfig(projectRoot));
		const sessionId = "clear-notice";
		const first = await runPreStep(context, fakeAgent(projectRoot, sessionId));
		assert.equal(first.messages.length, 1);
		assert.match(first.messages[0].source.summary, /^Active rules: style$/);
		await rm(ruleFile);
		const second = await runPreStep(context, fakeAgent(projectRoot, sessionId));
		assert.equal(second.messages.length, 1);
		assert.equal(second.messages[0].source.form, "notice");
		assert.match(second.messages[0].source.summary, /^No active rules$/);
		assert.match(second.messages[0].content[0].text, /No rules are currently active/);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

// ── apply(): re-injection is keyed on the rule set, not on matched files ─────

test("apply: a new matching file does not re-inject an unchanged snapshot", async () => {
	const { workspace, projectRoot } = await makeProject();
	try {
		await mkdir(join(projectRoot, ".dsh", "rules"), { recursive: true });
		await writeFile(join(projectRoot, ".dsh", "rules", "typescript.md"), "---\npath: \"src/**/*.ts\"\n---\nTS rule.\n");
		await writeFile(join(projectRoot, ".dsh", "rules", "docs.md"), "---\npath: \"docs/**/*.md\"\n---\nDocs rule.\n");
		const context = fakeContext();
		apply(context, projectOnlyConfig(projectRoot));
		const agent = fakeAgent(projectRoot, "matched-file-churn");
		const injected = [];
		observe(context, agent, join(projectRoot, "src", "a.ts"));
		await pump(context, agent, injected, (texts) => texts.length >= 1);
		assert.match(injected[0], /matched files: src\/a\.ts\)/);
		assert.doesNotMatch(injected[0], /Docs rule\./);
		// A second TypeScript file changes only the snapshot's matched-file list,
		// and those rules are already in context — so nothing may be injected.
		observe(context, agent, join(projectRoot, "src", "b.ts"));
		await settle();
		const afterSecondFile = await runPreStep(context, agent);
		assert.deepEqual(afterSecondFile.messages, [], "matched-file growth alone must not inject a snapshot");
		// A file matching the second rule does change the active set: exactly one
		// more snapshot, and it must carry the file list as it stands now.
		observe(context, agent, join(projectRoot, "docs", "guide.md"));
		await settle();
		const afterSecondRule = await runPreStep(context, agent);
		assert.equal(afterSecondRule.messages.length, 1);
		const text = afterSecondRule.messages[0].content[0].text;
		assert.match(text, /matched files: docs\/guide\.md, src\/a\.ts, src\/b\.ts\)/);
		assert.match(text, /TS rule\./);
		assert.match(text, /Docs rule\./);
		assert.deepEqual(context.warnings, []);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

// ── apply(): resumed sessions ────────────────────────────────────────────────

test("apply: a resumed session reads its log through the current session API", async () => {
	const { workspace, projectRoot } = await makeProject();
	try {
		await mkdir(join(projectRoot, ".dsh", "rules"), { recursive: true });
		await writeFile(join(projectRoot, ".dsh", "rules", "style.md"), "---\n---\nResumed project rule.\n");
		const context = fakeContext();
		apply(context, projectOnlyConfig(projectRoot));
		// The resumed log carries an older snapshot: re-seeding from it must
		// succeed (no `session.events` member exists anymore) and, seeing the
		// catalog changed, inject the current one.
		const agent = fakeAgent(projectRoot, "resumed", [{
			type: "user/message",
			data: {
				source: { kind: "plugin", plugin: "dsh-rules", form: "notice", summary: "Active rules: style" },
				content: [{ type: "text", text: "<rules>\nstale snapshot\n</rules>" }]
			}
		}]);
		const decision = await runPreStep(context, agent);
		assert.match(injectedText(decision), /Resumed project rule\./);
		assert.deepEqual(context.warnings, []);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});