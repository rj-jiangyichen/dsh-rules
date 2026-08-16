/**
 * Pure rule-model logic for the dsh-rules plugin.
 *
 * This module owns everything that can be tested without a harness runtime:
 * frontmatter parsing, `# Path:` section parsing, glob compilation and
 * matching, precedence merging, and budget-bounded deterministic rendering.
 *
 * @module dsh-rules/rules
 */
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";

/** Frame that marks the model-facing rules snapshot. */
const RULES_OPEN = "<rules>";
const RULES_CLOSE = "</rules>";
/** Intro asserting that one rules snapshot supersedes earlier ones. */
const RULES_INTRO =
	"Active rules for files read or edited in this session";
/** Text used to clear a previously injected rules snapshot. */
export const EMPTY_RULES_TEXT = [
	RULES_OPEN,
	"This rules snapshot supersedes earlier rules snapshots. No rules are currently active.",
	RULES_CLOSE
].join("\n");

/** Headings that open a Claude-Code-style scoped rule section. */
const PATH_HEADING = /^#+\s*path:\s*(.+)$/i;

/**
 * Return whether a candidate rule name is acceptable: non-empty and free of
 * path separators, so it can never be confused with a file path.
 * @param name - candidate rule name.
 * @returns whether the name may be used to identify a rule.
 */
export function isValidRuleName(name) {
	return typeof name === "string" && name.length > 0 && !/[\\/]/.test(name);
}

/**
 * Parse one flat rule file (frontmatter + markdown body).
 *
 * Frontmatter fields:
 * - `path`: string or list of glob strings, relative to the project root,
 *   using `/` separators. A `!` prefix marks an exclusion pattern. Absent or
 *   empty means the rule is always active for the workspace.
 * - `name`: optional display/identity override; defaults to the file's
 *   basename without the `.md` suffix (supplied by the caller).
 *
 * @param raw - exact UTF-8 file text.
 * @param fallbackName - name used when frontmatter omits `name`.
 * @returns the parsed rule, or `undefined` when the file is not a valid rule.
 */
export function parseRuleFile(raw, fallbackName) {
	const parsed = parseFrontmatter(raw);
	if (parsed === void 0) return void 0;
	const { data, body } = parsed;
	const name = optionalString(data, "name") ?? fallbackName;
	if (!isValidRuleName(name)) return void 0;
	const globs = normalizeGlobField(data.path);
	if (globs === void 0) return void 0;
	return {
		name,
		globs,
		content: body.trim()
	};
}

/**
 * Parse Claude-Code-style `# Path: <glob…>` scoped sections out of a markdown
 * instruction file (CLAUDE.md / AGENTS.md). Content before the first heading
 * is the file's preamble and is intentionally ignored: the baseline
 * instructions pipeline owns it, and this plugin only handles scoped rules.
 * @param raw - exact UTF-8 file text.
 * @returns parsed sections, each with normalized globs and trimmed body.
 */
export function parseClaudePathSections(raw) {
	const sections = [];
	let current = void 0;
	for (const line of raw.split(/\r?\n/)) {
		const match = PATH_HEADING.exec(line);
		if (match !== null) {
			if (current !== void 0) sections.push(current);
			const globs = splitGlobList(match[1]);
			if (globs.length === 0) {
				current = void 0;
				continue;
			}
			current = { globs, lines: [] };
			continue;
		}
		if (current !== void 0) current.lines.push(line);
	}
	if (current !== void 0) sections.push(current);
	return sections.map((section) => ({
		globs: section.globs,
		content: section.lines.join("\n").trim()
	}));
}

/**
 * Compile a rule's glob patterns into a matcher. Patterns are matched against
 * project-root-relative POSIX paths. `!`-prefixed patterns exclude; an
 * inclusion list of only negations matches everything except the exclusions.
 * @param patterns - raw glob patterns.
 * @returns a compiled matcher, or an invalid result when a pattern is malformed.
 */
export function compileMatcher(patterns) {
	const normalized = patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
	const include = normalized.filter((pattern) => !pattern.startsWith("!"));
	const exclude = normalized.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	let includeMatcher = null;
	let excludeMatcher = null;
	try {
		if (include.length > 0) includeMatcher = picomatch(include, { dot: true });
		if (exclude.length > 0) excludeMatcher = picomatch(exclude, { dot: true });
	} catch (error) {
		return { valid: false, error };
	}
	return {
		valid: true,
		/**
		 * Test one project-root-relative POSIX path against the rule.
		 * @param path - relative path with `/` separators.
		 * @returns whether the rule applies to the path.
		 */
		match(path) {
			if (excludeMatcher !== null && excludeMatcher(path)) return false;
			if (includeMatcher === null) return true;
			return includeMatcher(path);
		}
	};
}

/**
 * Merge rules from ordered source groups into one deterministic catalog.
 * Groups carry a `rank` (lower wins) and a sorted-by-name `rules` list.
 * Duplicate names keep the lowest-rank entry; ties keep the first in group
 * order. The result is sorted by (rank, name).
 * @param groups - source groups, each `{ rank, rules }`.
 * @returns the merged catalog plus the dropped duplicates.
 */
export function mergeRuleSources(groups) {
	const byName = /* @__PURE__ */ new Map();
	const dropped = [];
	for (const group of groups) {
		for (const rule of [...group.rules].sort(compareByName)) {
			const previous = byName.get(rule.name);
			if (previous === void 0) {
				byName.set(rule.name, rule);
				continue;
			}
			if (rule.rank < previous.rank) {
				byName.set(rule.name, rule);
				dropped.push(previous);
			} else dropped.push(rule);
		}
	}
	return {
		rules: [...byName.values()].sort(compareByRankThenName),
		dropped
	};
}

/**
 * Render the active rule set into one deterministic, budget-bounded snapshot.
 * Rules are ordered by (rank, name); when the framed text exceeds `maxBytes`,
 * lowest-priority rules are omitted first, then the last remaining rule's
 * content is truncated. Rule bodies are escaped so they cannot close the
 * framing tags.
 * @param active - active rules, each `{ name, source, content, rank }`.
 * @param options - render budget and the matched-file list for the intro.
 * @returns the rendered snapshot text and budget diagnostics.
 */
export function renderRules(active, options) {
	const maxBytes = options.maxBytes;
	const sorted = [...active].sort(compareByRankThenName);
	const full = buildFrame(sorted, options.matchedFiles ?? []);
	if (byteLength(full) <= maxBytes) return { text: full, omitted: [], truncated: [] };
	for (let keep = sorted.length - 1; keep >= 1; keep -= 1) {
		const kept = sorted.slice(0, keep);
		const omitted = sorted.slice(keep).map(ruleIdentity);
		const candidate = buildFrame(kept, options.matchedFiles ?? []);
		if (byteLength(candidate) <= maxBytes) return { text: candidate, omitted, truncated: [] };
	}
	const [first] = sorted;
	if (first === void 0) return { text: truncateUtf8(full, maxBytes), omitted: [], truncated: [] };
	const truncatedRule = truncateRuleToFit(first, maxBytes);
	const framed = buildFrame([truncatedRule.rule], options.matchedFiles ?? []);
	return {
		text: byteLength(framed) <= maxBytes ? framed : truncateUtf8(framed, maxBytes),
		omitted: sorted.slice(1).map(ruleIdentity),
		truncated: [truncatedRule.report]
	};
}

/** Split a `# Path:` heading value into normalized glob patterns. */
function splitGlobList(value) {
	return value.split(/[\s,]+/).map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Normalize a frontmatter `path` field.
 * @param value - raw field value.
 * @returns normalized glob list, or `undefined` when the field is malformed.
 */
export function normalizeGlobField(value) {
	if (value === void 0) return [];
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length === 0 ? [] : [trimmed];
	}
	if (!Array.isArray(value)) return void 0;
	const globs = [];
	for (const item of value) {
		if (typeof item !== "string") return void 0;
		const trimmed = item.trim();
		if (trimmed.length > 0) globs.push(trimmed);
	}
	return globs;
}

/** Parse a `---`-delimited YAML frontmatter block. */
function parseFrontmatter(raw) {
	const firstLineEnd = raw.indexOf("\n");
	if (firstLineEnd < 0) return void 0;
	if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return void 0;
	const start = firstLineEnd + 1;
	const closing = findClosingFrontmatter(raw, start);
	if (closing === void 0) return void 0;
	let data;
	try {
		data = parseYaml(raw.slice(start, closing.start)) ?? {};
	} catch {
		return void 0;
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return void 0;
	return { data, body: raw.slice(closing.bodyStart) };
}

function findClosingFrontmatter(raw, start) {
	let lineStart = start;
	while (lineStart <= raw.length) {
		const nextNewline = raw.indexOf("\n", lineStart);
		const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
		if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
			return {
				start: lineStart,
				bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1
			};
		}
		if (nextNewline < 0) return void 0;
		lineStart = nextNewline + 1;
	}
}

function optionalString(data, key) {
	const value = data[key];
	return typeof value === "string" && value.length > 0 ? value : void 0;
}

function buildFrame(rules, matchedFiles) {
	const parts = [
		RULES_OPEN,
		matchedFiles.length > 0
			? `${RULES_INTRO} (matched files: ${matchedFiles.map(escapeAttr).join(", ")})`
			: `${RULES_INTRO} (scoped rules activate as you read or edit matching files)`,
		""
	];
	for (const rule of rules) {
		parts.push(
			`<rule name="${escapeAttr(rule.name)}" source="${escapeAttr(rule.source)}">`,
			escapeRuleText(rule.content),
			"</rule>"
		);
	}
	parts.push(RULES_CLOSE);
	return parts.join("\n");
}

/** Escape rule body text so it cannot close the framing tags. */
export function escapeRuleText(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/** Escape an attribute value embedded in framing markup. */
export function escapeAttr(value) {
	return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function ruleIdentity(rule) {
	return { name: rule.name, source: rule.source };
}

function compareByName(left, right) {
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function compareByRankThenName(left, right) {
	return left.rank - right.rank || compareByName(left, right);
}

function byteLength(value) {
	return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value, maxBytes) {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD/g, "");
}

/** Binary-search the largest content prefix whose framed rendering fits. */
function truncateRuleToFit(rule, maxBytes) {
	const originalBytes = byteLength(rule.content);
	let low = 0;
	let high = originalBytes;
	let best = { ...rule, content: "" };
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = { ...rule, content: truncateUtf8(rule.content, mid) };
		const framed = buildFrame([candidate], []);
		if (byteLength(framed) <= maxBytes) {
			best = candidate;
			low = mid + 1;
		} else high = mid - 1;
	}
	return {
		rule: best,
		report: {
			name: rule.name,
			source: rule.source,
			originalBytes,
			includedBytes: byteLength(best.content)
		}
	};
}
