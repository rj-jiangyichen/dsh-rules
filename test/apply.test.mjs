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