import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	auditPins,
	auditRepositoryPins,
	changedPins,
	findPins,
	writePinEvidence,
} from "../../scripts/pin-audit-rules.mjs";

const root = new URL("../../", import.meta.url);
const oldSha = "a".repeat(40);
const newSha = "b".repeat(40);

function entry(overrides = {}) {
	return {
		kind: "workflow",
		source: "dinkuskit/clawsweeper",
		sha: oldSha,
		reviewed: "reviewed in dinkuskit/inventory#1",
		...overrides,
	};
}

test("collects workflow, skill and runtime commit pins", () => {
	assert.deepEqual(
		findPins(
			".github/workflows/review.yml",
			[
				"jobs:",
				"  local:",
				"    uses: ./.github/workflows/local.yml",
				"  review:",
				`    uses: dinkuskit/clawsweeper/.github/workflows/canary.yml@${oldSha}`,
				"    steps:",
				`      - uses: "actions/checkout@${newSha}" # v7.0.0`,
			].join("\n"),
		),
		{
			pins: [
				{ at: ".github/workflows/review.yml:5", source: "dinkuskit/clawsweeper", sha: oldSha },
				{ at: ".github/workflows/review.yml:7", source: "actions/checkout", sha: newSha },
			],
			findings: [],
		},
	);
	assert.deepEqual(findPins("scripts/agent-skills", `SAARIUS_SHA="${oldSha}"\n`).pins, [
		{ at: "scripts/agent-skills:1", sha: oldSha },
	]);
	assert.deepEqual(findPins("tools/proof.mjs", `const digest = "${"c".repeat(64)}";`).pins, []);
});

test("rejects workflow references that are not pinned to a full commit", () => {
	for (const target of [
		"actions/checkout@v7",
		"dinkuskit/clawsweeper/.github/workflows/canary.yml@main",
		`actions/checkout@${oldSha.slice(0, 12)}`,
		"docker://alpine:3",
	]) {
		const { pins, findings } = findPins(".github/workflows/ci.yml", `      - uses: ${target}\n`);
		assert.deepEqual(pins, []);
		assert.equal(findings.length, 1, target);
	}
});

test("fails pins that the reviewed-pins manifest does not list", () => {
	const pin = { at: "scripts/agent-skills:4", sha: oldSha };
	assert.deepEqual(auditPins([pin], { pins: [entry({ kind: "skill" })] }), []);
	assert.equal(auditPins([pin], { pins: [] }).length, 1);
	assert.equal(auditPins([pin], null).length, 2);
	assert.equal(auditPins([{ ...pin, sha: newSha }], { pins: [entry()] }).length, 2);
});

test("fails a reviewed commit that is pinned from a different source", () => {
	const findings = auditPins(
		[{ at: ".github/workflows/ci.yml:9", source: "attacker/clawsweeper", sha: oldSha }],
		{ pins: [entry()] },
	);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /reviewed that commit for dinkuskit\/clawsweeper/u);
});

test("fails malformed, duplicate and stale manifest entries", () => {
	const pin = { at: "scripts/agent-skills:4", sha: oldSha };
	for (const broken of [
		entry({ reviewed: " " }),
		entry({ kind: "action" }),
		entry({ source: "clawsweeper" }),
		entry({ sha: oldSha.slice(0, 12) }),
	]) {
		assert.ok(auditPins([pin], { pins: [broken] }).length >= 1, JSON.stringify(broken));
	}
	assert.equal(auditPins([pin], { pins: [entry(), entry()] }).length, 1);
	assert.deepEqual(auditPins([], { pins: [entry()] }), [
		`.github/reviewed-pins.json lists dinkuskit/clawsweeper@${oldSha}, which nothing pins`,
	]);
});

test("pairs a changed pin with the pin it replaced", () => {
	const base = {
		pins: [{ at: "scripts/agent-skills:4", sha: oldSha }],
		manifest: { pins: [entry({ kind: "skill", source: "saariuslystoned/SaariusSkills" })] },
	};
	const head = {
		pins: [{ at: "scripts/agent-skills:4", sha: newSha }],
		manifest: {
			pins: [entry({ kind: "skill", source: "saariuslystoned/SaariusSkills", sha: newSha })],
		},
	};
	assert.deepEqual(changedPins(base, head), [
		{
			at: "scripts/agent-skills:4",
			source: "saariuslystoned/SaariusSkills",
			sha: newSha,
			previous: oldSha,
		},
	]);
	assert.deepEqual(changedPins(head, head), []);
	assert.equal(changedPins(base, { ...head, manifest: null })[0].source, undefined);
});

test("writes the fetched source diff for a changed pin", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "inventory-pin-audit-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const run = (cwd, ...arguments_) =>
		execFileSync(
			"git",
			["-c", "user.name=pin-audit", "-c", "user.email=pin-audit@example.invalid", ...arguments_],
			{ cwd, encoding: "utf8" },
		).trim();
	const commit = async (cwd, path, text, message) => {
		await writeFile(join(cwd, path), text);
		run(cwd, "add", "--all");
		run(cwd, "commit", "--quiet", "--message", message);
		return run(cwd, "rev-parse", "HEAD");
	};

	// The pinned source keeps both commits on branch tips, as a hosted remote
	// serves them, so they can be fetched by commit.
	const upstream = join(directory, "upstream");
	run(directory, "init", "--quiet", "--initial-branch=old", upstream);
	const reviewed = await commit(upstream, "SKILL.md", "ask before sending\n", "reviewed");
	run(upstream, "checkout", "--quiet", "-b", "new");
	const bumped = await commit(upstream, "SKILL.md", "send without asking\n", "bumped");

	const consumer = join(directory, "consumer");
	run(directory, "init", "--quiet", "--initial-branch=main", consumer);
	const manifest = (sha) =>
		JSON.stringify({ pins: [entry({ kind: "skill", source: "example/skills", sha })] });
	const pinFiles = async (sha) => {
		for (const name of ["scripts", ".github"]) await mkdir(join(consumer, name), { recursive: true });
		await writeFile(join(consumer, "scripts/agent-skills"), `SKILLS_SHA="${sha}"\n`);
		return commit(consumer, ".github/reviewed-pins.json", manifest(sha), `pin ${sha}`);
	};
	const base = await pinFiles(reviewed);
	await pinFiles(bumped);

	const evidence = join(directory, "evidence");
	const report = await writePinEvidence({
		root: consumer,
		base,
		directory: evidence,
		sourceUrl: (source) => {
			assert.equal(source, "example/skills");
			return upstream;
		},
	});
	const file = `example__skills-${bumped.slice(0, 12)}.diff`;
	assert.deepEqual((await readdir(evidence)).sort(), [file, "report.md"]);
	const diff = await readFile(join(evidence, file), "utf8");
	assert.match(diff, /^-ask before sending$/mu);
	assert.match(diff, /^\+send without asking$/mu);
	assert.match(report.join("\n"), new RegExp(`diff from ${reviewed} in \`${file}\``, "u"));
	assert.deepEqual(await auditRepositoryPins(consumer), []);

	const fresh = await writePinEvidence({ root: consumer, directory: evidence, sourceUrl: () => upstream });
	assert.match(fresh.join("\n"), new RegExp(`new pin, file summary in \`${file}\``, "u"));
	assert.match(await readFile(join(evidence, file), "utf8"), /SKILL\.md \| 1 \+/u);

	const unreachable = await writePinEvidence({
		root: consumer,
		base,
		directory: evidence,
		sourceUrl: () => join(directory, "missing"),
	});
	assert.match(unreachable.join("\n"), /fetch failed, so there is no source diff/u);
	assert.deepEqual(await readdir(evidence), ["report.md"]);
});

test("every committed pin is listed in the reviewed-pins manifest", async () => {
	assert.deepEqual(await auditRepositoryPins(root), []);
});
