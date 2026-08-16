#!/usr/bin/env node
/**
 * Install / uninstall the dsh-rules plugin into the DSH Desktop profile.
 *
 * Install does two things:
 *   1. `dsh plugin --profile <name> add <this repo>` — the same packaged
 *      `dsh plugin` command the desktop app itself runs, adding `dsh-rules`
 *      to the profile's package.json and node_modules.
 *   2. Appends an `insert` row to the profile's `cordis.patch.yml` so the
 *      plugin is composed into the host plane on the next app start.
 *
 * Usage:
 *   node scripts/install-desktop.mjs [--uninstall]
 *     [--profile desktop] [--app "C:\Program Files\DSH Desktop\DSH Desktop.exe"]
 *
 * The plugin takes effect after the DSH Desktop app is restarted.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const PLUGIN_ID = "dsh-rules";
const DEFAULT_PROFILE = "desktop";
const DEFAULT_APP = "C:\\Program Files\\DSH Desktop\\DSH Desktop.exe";
const here = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(here, "..");
const ELECTRON_HEADERS_URL = "https://electronjs.org/headers";

/**
 * pnpm splits `add` specs on spaces, so a repo path containing spaces cannot
 * be passed directly. A no-space directory junction beside the repo (e.g.
 * `C:\code_repos\dsh-rules` → `C:\code_repos\dsh rules plugin`) is used
 * instead; the installed dependency is a live link into the repo.
 */
function junctionPath() {
	return join(dirname(REPO_DIR), PLUGIN_ID);
}

function fail(message) {
	console.error(`install-desktop: ${message}`);
	process.exitCode = 1;
}

function parseArgs(argv) {
	const args = { profile: DEFAULT_PROFILE, app: DEFAULT_APP, uninstall: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--uninstall") args.uninstall = true;
		else if (argument === "--profile") args.profile = argv[++index];
		else if (argument === "--app") args.app = argv[++index];
		else fail(`unknown argument "${argument}"`);
	}
	return args;
}

/** Run the packaged `dsh plugin` command exactly like the desktop app does. */
async function runDshPlugin(args, spec) {
	const unpacked = join(dirname(args.app), "resources", "app.asar.unpacked");
	const dshBootstrapPath = join(unpacked, "lib", "desktop-cli.js");
	const appPackage = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8"));
	const electronVersion = appPackage.peerDependencies?.electron ?? "43.4.0";
	const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
	const profileDir = join(dshHome, "profiles", args.profile);
	if (!(await exists(profileDir))) fail(`profile directory not found: ${profileDir}`);
	const child = spawn(args.app, [
		"--expose-internals",
		dshBootstrapPath,
		"plugin",
		"--profile",
		args.profile,
		...spec
	], {
		cwd: REPO_DIR,
		stdio: "inherit",
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			DSH_HOME: dshHome,
			CI: "true",
			npm_config_runtime: "electron",
			npm_config_target: electronVersion,
			npm_config_disturl: ELECTRON_HEADERS_URL
		}
	});
	const outcome = await new Promise((resolveDone) => {
		child.on("exit", (code, signal) => resolveDone({ code, signal }));
	});
	if (outcome.code !== 0) fail(`dsh plugin exited with code ${outcome.code}${outcome.signal ? ` (${outcome.signal})` : ""}`);
	return outcome.code === 0;
}

/** Append the plugin row to the profile patch layer, preserving comments. */
async function patchProfile(args) {
	const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
	const patchPath = join(dshHome, "profiles", args.profile, "cordis.patch.yml");
	let raw;
	try {
		raw = await readFile(patchPath, "utf8");
	} catch {
		raw = "";
	}
	if (raw.includes(`id: ${PLUGIN_ID}`)) {
		console.log(`cordis.patch.yml already contains ${PLUGIN_ID}; nothing to add.`);
		return;
	}
	const insertBlock = [
		`- insert:`,
		`    - id: ${PLUGIN_ID}`,
		`      name: ${PLUGIN_ID}`,
		`      config:`,
		`        includeClaudeSections: true`
	].join("\n");
	const trimmed = raw.trim();
	let next;
	if (trimmed === "[]" || trimmed.length === 0) {
		// Keep the existing header comments; replace the empty array body.
		const marker = trimmed.length === 0 ? "" : raw.lastIndexOf("[]");
		const head = trimmed.length === 0 ? "" : raw.slice(0, marker);
		next = `${head}${insertBlock}\n`;
	} else {
		let entries = parse(raw);
		if (!Array.isArray(entries)) entries = [];
		entries.push({ insert: [{ id: PLUGIN_ID, name: PLUGIN_ID, config: { includeClaudeSections: true } }] });
		next = stringify(entries);
	}
	await writeFile(patchPath, next, "utf8");
	console.log(`patched ${patchPath}`);
}

/** Remove the plugin row from the profile patch layer. */
async function unstripProfile(args) {
	const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
	const patchPath = join(dshHome, "profiles", args.profile, "cordis.patch.yml");
	let raw;
	try {
		raw = await readFile(patchPath, "utf8");
	} catch {
		console.log("no patch file to clean.");
		return;
	}
	if (!raw.includes(`id: ${PLUGIN_ID}`)) {
		console.log(`cordis.patch.yml has no ${PLUGIN_ID} row; nothing to remove.`);
		return;
	}
	const entries = parse(raw);
	if (Array.isArray(entries)) {
		const kept = entries.filter((entry) => {
			if (!Array.isArray(entry?.insert)) return true;
			return !entry.insert.some((row) => row?.id === PLUGIN_ID);
		});
		if (kept.length !== entries.length) {
			await writeFile(patchPath, kept.length > 0 ? stringify(kept) : "[]\n", "utf8");
			console.log(`removed ${PLUGIN_ID} from ${patchPath}`);
			return;
		}
	}
	console.log(`could not parse ${patchPath}; remove the ${PLUGIN_ID} row manually.`);
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

const args = parseArgs(process.argv.slice(2));
if (process.exitCode === 1) process.exit(1);
if (args.uninstall) {
	await unstripProfile(args);
	const ok = await runDshPlugin(args, ["remove", PLUGIN_ID]);
	if (!ok) process.exit(1);
	console.log(`\nUninstalled. The dsh-rules plugin row is removed; restart DSH Desktop to complete.`);
} else {
	await ensureJunction();
	const ok = await runDshPlugin(args, ["add", junctionPath()]);
	if (!ok) process.exit(1);
	await patchProfile(args);
	console.log(`\nInstalled. Restart DSH Desktop, then create a session in a project with .dsh/rules/*.md to see rules activate.`);
}

/** Create the no-space junction to this repo when it does not exist yet. */
async function ensureJunction() {
	const link = junctionPath();
	if (await exists(link)) return;
	const { execFileSync } = await import("node:child_process");
	execFileSync("cmd.exe", ["/c", "mklink", "/J", link, REPO_DIR], { stdio: "inherit" });
	if (!(await exists(link))) fail(`failed to create junction ${link}`);
}
