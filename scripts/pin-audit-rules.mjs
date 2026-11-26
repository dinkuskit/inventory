import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH = ".github/reviewed-pins.json";

// Trees whose files run in CI, agent sessions or proof and may pin external
// source by commit. Docs, proof records and tests only cite revisions.
const PIN_ROOTS = [".claude/hooks", ".github", "bin", "scripts", "tools"];
const KINDS = new Set(["workflow", "skill", "runtime"]);
const SHA = /\b[0-9a-f]{40}\b/gu;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const SOURCE = /^[\w.-]+\/[\w.-]+$/u;
const USES = /^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/u;
const PINNED_USES = /^([\w.-]+\/[\w.-]+)(?:\/[^@]*)?@([0-9a-f]{40})$/u;

function isWorkflowFile(path) {
	return path.startsWith(".github/") && /\.ya?ml$/u.test(path);
}

export function findPins(path, text) {
	const pins = [];
	const findings = [];
	for (const [index, line] of text.split("\n").entries()) {
		const at = `${path}:${index + 1}`;
		const target = isWorkflowFile(path) ? line.match(USES)?.[1] : undefined;
		if (target !== undefined) {
			if (target.startsWith("./")) continue;
			const pinned = target.match(PINNED_USES);
			if (pinned) {
				pins.push({ at, source: pinned[1], sha: pinned[2] });
			} else {
				findings.push(`${at} uses ${target} without a full commit SHA`);
			}
			continue;
		}
		for (const [sha] of line.matchAll(SHA)) pins.push({ at, sha });
	}
	return { pins, findings };
}

function manifestEntries(manifest) {
	return Array.isArray(manifest?.pins) ? manifest.pins : [];
}

export function auditPins(pins, manifest) {
	const findings = [];
	if (!Array.isArray(manifest?.pins)) {
		findings.push(`${MANIFEST_PATH} must contain a pins array`);
	}
	const reviewed = new Map();
	for (const entry of manifestEntries(manifest)) {
		const label = `${MANIFEST_PATH} entry ${entry?.source}@${entry?.sha}`;
		if (
			!KINDS.has(entry?.kind) ||
			!SOURCE.test(entry?.source ?? "") ||
			!FULL_SHA.test(entry?.sha ?? "") ||
			typeof entry?.reviewed !== "string" ||
			entry.reviewed.trim() === ""
		) {
			findings.push(
				`${label} needs kind (${[...KINDS].join("|")}), source (owner/repo), a full commit sha and its review record`,
			);
			continue;
		}
		if (reviewed.has(entry.sha)) {
			findings.push(`${label} is listed more than once`);
			continue;
		}
		reviewed.set(entry.sha, entry);
	}
	const pinned = new Set();
	for (const pin of pins) {
		pinned.add(pin.sha);
		const entry = reviewed.get(pin.sha);
		if (!entry) {
			findings.push(
				`${pin.at} pins ${pin.source ?? "external source"}@${pin.sha}, which is not listed in ${MANIFEST_PATH}`,
			);
		} else if (pin.source && pin.source.toLowerCase() !== entry.source.toLowerCase()) {
			findings.push(
				`${pin.at} pins ${pin.source}@${pin.sha}, but ${MANIFEST_PATH} reviewed that commit for ${entry.source}`,
			);
		}
	}
	for (const [sha, entry] of reviewed) {
		if (!pinned.has(sha)) {
			findings.push(`${MANIFEST_PATH} lists ${entry.source}@${sha}, which nothing pins`);
		}
	}
	return findings;
}

function git(root, arguments_) {
	return spawnSync("git", arguments_, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
}

function parseManifest(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// Reads the pin-bearing tracked files from the working tree, or from a
// committed revision when one is given.
async function readPinState(root, revision) {
	const listed = revision
		? git(root, ["ls-tree", "-r", "-z", "--name-only", revision, "--", ...PIN_ROOTS])
		: git(root, ["ls-files", "-z", "--", ...PIN_ROOTS]);
	if (listed.status !== 0) throw new Error(`Cannot list pin sources: ${listed.stderr}`);
	const read = async (path) => {
		if (revision) {
			const shown = git(root, ["show", `${revision}:${path}`]);
			return shown.status === 0 ? shown.stdout : null;
		}
		return readFile(join(root, path), "utf8").catch(() => null);
	};
	const pins = [];
	const findings = [];
	for (const path of listed.stdout.split("\0").filter(Boolean)) {
		if (path === MANIFEST_PATH) continue;
		const text = await read(path);
		if (text === null) continue;
		const found = findPins(path, text);
		pins.push(...found.pins);
		findings.push(...found.findings);
	}
	return { pins, findings, manifest: parseManifest((await read(MANIFEST_PATH)) ?? "") };
}

export async function auditRepositoryPins(rootUrl) {
	const root = typeof rootUrl === "string" ? rootUrl : fileURLToPath(rootUrl);
	const { pins, findings, manifest } = await readPinState(root);
	return [...findings, ...auditPins(pins, manifest)];
}

function withSources(state) {
	const sources = new Map(
		manifestEntries(state.manifest).map((entry) => [entry?.sha, entry?.source]),
	);
	return state.pins.map((pin) => ({ ...pin, source: pin.source ?? sources.get(pin.sha) }));
}

// Pins present now but not at the base revision, each with the pin it
// replaced when exactly one pin of the same source was dropped.
export function changedPins(base, head) {
	const basePins = withSources(base);
	const headPins = withSources(head);
	const before = new Set(basePins.map((pin) => pin.sha));
	const after = new Set(headPins.map((pin) => pin.sha));
	const changes = new Map();
	for (const pin of headPins) {
		if (before.has(pin.sha) || changes.has(pin.sha)) continue;
		const dropped = new Set(
			basePins
				.filter((old) => pin.source && old.source === pin.source && !after.has(old.sha))
				.map((old) => old.sha),
		);
		changes.set(pin.sha, {
			at: pin.at,
			source: pin.source,
			sha: pin.sha,
			previous: dropped.size === 1 ? [...dropped][0] : undefined,
		});
	}
	return [...changes.values()];
}

// Fetches every pin changed since the base revision and writes its source
// diff plus report.md into the evidence directory for reviewers.
export async function writePinEvidence({
	root,
	base,
	directory,
	sourceUrl = (source) => `https://github.com/${source}.git`,
}) {
	const evidence = resolve(directory);
	const scratch = join(evidence, ".fetch");
	await rm(evidence, { recursive: true, force: true });
	await mkdir(evidence, { recursive: true });
	const report = ["## Pin audit", ""];
	const baseKnown =
		Boolean(base) && git(root, ["cat-file", "-e", `${base}^{commit}`]).status === 0;
	const head = await readPinState(root);
	const changes = baseKnown
		? changedPins(await readPinState(root, base), head)
		: changedPins({ pins: [], manifest: null }, head);
	report.push(
		baseKnown
			? `Pins changed since \`${base}\`: ${changes.length}`
			: `No base revision; all ${changes.length} current pins are treated as new.`,
		"",
	);
	if (changes.length > 0) git(root, ["init", "--quiet", "--bare", scratch]);
	for (const change of changes) {
		const name = `${change.source ?? "unknown"}@${change.sha}`;
		if (!change.source || !SOURCE.test(change.source)) {
			report.push(`- ${name} (${change.at}): no source is recorded, so nothing was fetched`);
			continue;
		}
		const wanted = change.previous ? [change.previous, change.sha] : [change.sha];
		const fetched = git(scratch, [
			"fetch",
			"--quiet",
			"--depth",
			"1",
			sourceUrl(change.source),
			...wanted,
		]);
		if (fetched.status !== 0) {
			report.push(`- ${name} (${change.at}): fetch failed, so there is no source diff`);
			continue;
		}
		const file = `${change.source.replace("/", "__")}-${change.sha.slice(0, 12)}.diff`;
		const output = `--output=${join(evidence, file)}`;
		const diffed = change.previous
			? git(scratch, ["diff", output, change.previous, change.sha])
			: git(scratch, ["show", "--stat", "--format=commit %H%n%an %aI%n%s%n", output, change.sha]);
		report.push(
			diffed.status !== 0
				? `- ${name} (${change.at}): diff failed`
				: change.previous
					? `- ${name} (${change.at}): diff from ${change.previous} in \`${file}\``
					: `- ${name} (${change.at}): new pin, file summary in \`${file}\``,
		);
	}
	await rm(scratch, { recursive: true, force: true });
	await writeFile(join(evidence, "report.md"), `${report.join("\n")}\n`);
	return report;
}
