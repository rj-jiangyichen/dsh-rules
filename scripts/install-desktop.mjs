#!/usr/bin/env node
/**
 * Install / uninstall the dsh-rules plugin into the DSH Desktop profile.
 *
 * dsh-rules is a standard DSH plugin bundle: its package.json declares
 * `dsh.bundle.patch`, so `dsh plugin --profile <name> add <spec>` installs
 * the dependency AND activates it as a profile layer in one step — the
 * reconcile pass appends the package to the profile's `dsh.profile.bundles`
 * list. No manual cordis.patch.yml edits are needed.
 *
 * Install does two things:
 *   1. Ensures a no-space junction to this repository. pnpm splits `add`
 *      arguments on spaces, so a repository path containing spaces must be
 *      installed through the junction path (e.g. `C:\code_repos\dsh-rules`
 *      → `C:\code_repos\dsh rules plugin`).
 *   2. Runs `dsh plugin --profile <name> add <junction>` exactly like the
 *      desktop app's own plugin command; the installed dependency is a live
 *      link into the repo.
 *
 * Uninstall runs `dsh plugin --profile <name> remove dsh-rules`, which also
 * removes the package from `dsh.profile.bundles`.
 *
 * Usage:
 *   node scripts/install-desktop.mjs [--uninstall]
 *     [--profile desktop] [--app "C:\Program Files\DSH Desktop\DSH Desktop.exe"]
 *
 * The plugin takes effect after the DSH Desktop app is restarted.
 */
import { spawn, execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "dsh-rules";
const DEFAULT_PROFILE = "desktop";
const DEFAULT_APP = "C:\\Program Files\\DSH Desktop\\DSH Desktop.exe";
const here = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(here, "..");
const ELECTRON_HEADERS_URL = "https://electronjs.org/headers";

/** A no-space directory junction beside the repo for pnpm `add` specs. */
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

/** Create the no-space junction to this repo when it does not exist yet. */
async function ensureJunction() {
	const link = junctionPath();
	if (await exists(link)) return;
	execFileSync("cmd.exe", ["/c", "mklink", "/J", link, REPO_DIR], { stdio: "inherit" });
	if (!(await exists(link))) fail(`failed to create junction ${link}`);
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
	const ok = await runDshPlugin(args, ["remove", PLUGIN_ID]);
	if (!ok) process.exit(1);
	console.log(`\nUninstalled. Restart DSH Desktop to complete.`);
} else {
	await ensureJunction();
	const ok = await runDshPlugin(args, ["add", junctionPath()]);
	if (!ok) process.exit(1);
	console.log(`\nInstalled (bundle auto-activated via dsh.profile.bundles). Restart DSH Desktop, then create a session in a project with .dsh/rules/*.md to see rules activate.`);
}
