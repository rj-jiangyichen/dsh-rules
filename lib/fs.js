/**
 * Filesystem helpers for the dsh-rules plugin.
 *
 * Reads prefer the harness `fs` service (which respects containment and
 * produces stable `version` identities) and fall back to Node's own
 * filesystem when no `fs` service is mounted. All discovery is
 * cancellation-aware through `signal`.
 *
 * @module dsh-rules/fs
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Normalize a path to POSIX separators for glob matching. */
function toPosix(path) {
	return path.split(sep).join("/");
}

/**
 * Walk up from `cwd` to the first directory containing any project-root
 * marker (e.g. `.git`); fall back to `cwd` itself.
 * @param cwd - absolute session working directory.
 * @param markers - marker file/directory names that identify a project root.
 * @param fileSystem - optional harness `fs` service.
 * @param signal - cancellation for provider probes.
 * @returns the absolute project root.
 */
export async function findProjectRoot(cwd, markers, fileSystem, signal) {
	let current = resolve(cwd);
	while (true) {
		for (const marker of markers) {
			if (await pathExists(join(current, marker), fileSystem, signal)) return current;
		}
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

/**
 * Return the project-root-relative POSIX path of `path`, or `undefined` when
 * the path lies outside the project root (such files never activate rules).
 * @param projectRoot - absolute project root.
 * @param path - absolute path to relativize.
 * @returns relative POSIX path, or `undefined` when outside the root.
 */
export function posixRelative(projectRoot, path) {
	const relativePath = relative(resolve(projectRoot), resolve(path));
	if (relativePath.length === 0) return ".";
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return void 0;
	return toPosix(relativePath);
}

/**
 * Probe one rule-source path (a file) for current metadata.
 * @param path - absolute path to probe.
 * @param fileSystem - optional harness `fs` service.
 * @param signal - cancellation for provider probes.
 * @returns present metadata (version identity plus optional size), confirmed
 *   absence, or temporary unavailability.
 */
export async function statRuleFile(path, fileSystem, signal) {
	signal?.throwIfAborted();
	if (fileSystem !== void 0) {
		try {
			const target = await fileSystem.resolve(path, signalOptions(signal));
			signal?.throwIfAborted();
			const info = await fileSystem.stat(target, signal);
			signal?.throwIfAborted();
			if (info === void 0 || info.type !== "file") return { kind: "absent" };
			return {
				kind: "present",
				version: info.version,
				...info.size === void 0 ? {} : { size: info.size }
			};
		} catch (error) {
			signal?.throwIfAborted();
			return isAbsentError(error) ? { kind: "absent" } : { kind: "unavailable" };
		}
	}
	try {
		const info = await stat(path, { signal });
		signal?.throwIfAborted();
		if (!info.isFile()) return { kind: "absent" };
		return {
			kind: "present",
			version: nodeVersionSignature(info),
			size: info.size
		};
	} catch (error) {
		signal?.throwIfAborted();
		return isAbsentError(error) ? { kind: "absent" } : { kind: "unavailable" };
	}
}

/**
 * Read one rule-source file's full text under a source byte cap.
 * @param path - absolute path to read.
 * @param fileSystem - optional harness `fs` service.
 * @param signal - cancellation for provider reads.
 * @param maxSourceBytes - maximum accepted UTF-8 bytes; larger files are skipped.
 * @returns the file text, or `undefined` when absent, unreadable, or oversized.
 */
export async function readRuleText(path, fileSystem, signal, maxSourceBytes) {
	signal?.throwIfAborted();
	if (fileSystem !== void 0) {
		try {
			const target = await fileSystem.resolve(path, signalOptions(signal));
			signal?.throwIfAborted();
			return await fileSystem.readText(target, signal);
		} catch (error) {
			signal?.throwIfAborted();
			return void 0;
		}
	}
	try {
		const info = await stat(path, { signal });
		signal?.throwIfAborted();
		if (!info.isFile()) return void 0;
		if (info.size > maxSourceBytes) return void 0;
		return await readFile(path, { encoding: "utf8", signal });
	} catch (error) {
		signal?.throwIfAborted();
		return void 0;
	}
}

/**
 * List one rule-source directory's entries.
 * @param dir - absolute directory path.
 * @param fileSystem - optional harness `fs` service.
 * @param signal - cancellation for provider probes.
 * @returns entry descriptors, or `undefined` when the directory is absent.
 */
export async function listRuleDirEntries(dir, fileSystem, signal) {
	signal?.throwIfAborted();
	if (fileSystem !== void 0) {
		try {
			const target = await fileSystem.resolve(dir, signalOptions(signal));
			signal?.throwIfAborted();
			return (await fileSystem.listDir(target, signal)).map((entry) => ({
				name: entry.name,
				type: entry.type
			}));
		} catch (error) {
			signal?.throwIfAborted();
			return isAbsentError(error) ? void 0 : null;
		}
	}
	try {
		const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
		return entries.map((entry) => ({
			name: entry.name,
			type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
		}));
	} catch (error) {
		signal?.throwIfAborted();
		return isAbsentError(error) ? void 0 : null;
	}
}

function signalOptions(signal) {
	return signal === void 0 ? void 0 : { signal };
}

/** Test one path for existence through the provider or the host filesystem. */
async function pathExists(path, fileSystem, signal) {
	if (fileSystem !== void 0) {
		try {
			const target = await fileSystem.resolve(path, signalOptions(signal));
			signal?.throwIfAborted();
			const info = await fileSystem.stat(target, signal);
			signal?.throwIfAborted();
			return info !== void 0;
		} catch (error) {
			signal?.throwIfAborted();
			return false;
		}
	}
	try {
		await stat(path, signalOptions(signal));
		return true;
	} catch (error) {
		signal?.throwIfAborted();
		return false;
	}
}

function nodeVersionSignature(info) {
	return `${info.mtimeMs}:${info.size}`;
}

function isAbsentError(error) {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "FS_NOT_FOUND" || error.code === "FS_NOT_DIRECTORY");
}
