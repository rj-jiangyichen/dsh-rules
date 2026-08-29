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

function fakeAgent(cwd, sessionId) {
	return { session: { id: sessionId, header: { cwd }, events: [] } };
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