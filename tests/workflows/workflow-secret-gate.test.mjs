import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import {
	auditWorkflowSecretGates,
	findPermissionGates,
	findSecretGateViolations,
} from "../../scripts/workflow-secret-gate-rules.mjs";

const root = new URL("../../", import.meta.url);
const dispatchPath = ".github/workflows/clawsweeper-dispatch.yml";
const repositoryId = 1307843786;
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

const gateJob = `
  gate:
    runs-on: ubuntu-24.04
    outputs:
      allowed: \${{ steps.permission.outputs.allowed }}
    steps:
      - id: permission
        run: gh api "repos/$REPO/collaborators/$ACTOR/permission" --jq .permission
`;

function workflow({ on = "pull_request_target", gate = gateJob, call }) {
	return `
on: ${on}
jobs:${gate}
  review:
${call}
    uses: dinkuskit/clawsweeper/.github/workflows/review.yml@${headSha}
`;
}

const secrets = `    secrets:
      TOKEN: \${{ secrets.TOKEN }}`;
const gated = `    needs: gate
    if: needs.gate.outputs.allowed == 'true'
${secrets}`;

test("accepts secrets passed behind a preceding permission-gate step", () => {
	assert.deepEqual(findSecretGateViolations("gated.yml", workflow({ call: gated })), []);
	assert.deepEqual(
		findSecretGateViolations(
			"gated.yml",
			workflow({
				on: "[issue_comment, workflow_dispatch]",
				call: `    needs: [gate]
    if: \${{ github.event.issue.pull_request && needs.gate.outputs.allowed == 'true' }}
    secrets: inherit`,
			}),
		),
		[],
	);
});

test("leaves trusted triggers and secretless reusable calls alone", () => {
	assert.deepEqual(
		findSecretGateViolations("trusted.yml", workflow({ on: "pull_request", gate: "", call: secrets })),
		[],
	);
	assert.deepEqual(
		findSecretGateViolations("secretless.yml", workflow({ gate: "", call: "    permissions: {}" })),
		[],
	);
});

test("rejects secrets passed from an untrusted trigger without a permission gate", () => {
	const ungated = {
		"no gate job": workflow({ gate: "", call: secrets }),
		"issue_comment trigger": workflow({ on: "issue_comment", gate: "", call: secrets }),
		"inherited secrets": workflow({ gate: "", call: "    secrets: inherit" }),
		"gate not required": workflow({ call: `    needs: gate\n${secrets}` }),
		"gate not awaited": workflow({
			call: `    if: needs.gate.outputs.allowed == 'true'\n${secrets}`,
		}),
		"gate bypassed": workflow({
			call: `    needs: gate
    if: needs.gate.outputs.allowed == 'true' || github.event_name == 'issue_comment'
${secrets}`,
		}),
		"gate negated": workflow({
			call: `    needs: gate
    if: needs.gate.outputs.allowed != 'true'
${secrets}`,
		}),
		"gate without a permission check": workflow({
			gate: gateJob.replace(/run: .*/, 'run: echo "allowed=true" >> "$GITHUB_OUTPUT"'),
			call: gated,
		}),
		"output not bound to a step": workflow({
			gate: gateJob.replace(/allowed: .*/, "allowed: true"),
			call: gated,
		}),
	};
	for (const [name, source] of Object.entries(ungated)) {
		assert.deepEqual(
			findSecretGateViolations("ungated.yml", source),
			[
				`ungated.yml: job review passes secrets to dinkuskit/clawsweeper/.github/workflows/review.yml@${headSha} on ${
					name === "issue_comment trigger" ? "issue_comment" : "pull_request_target"
				} without a preceding permission-gate step`,
			],
			name,
		);
	}
	assert.deepEqual(findSecretGateViolations("broken.yml", "jobs: [unclosed"), [
		"broken.yml: workflow could not be parsed",
	]);
});

test("the committed workflows gate every secret-bearing reusable call", async () => {
	assert.deepEqual(await auditWorkflowSecretGates(root), []);
});

async function committedGate() {
	const gates = findPermissionGates(dispatchPath, await readFile(new URL(dispatchPath, root), "utf8"));
	assert.equal(gates.length, 1);
	return gates[0];
}

// Runs the committed gate step as Actions would, against a stub `gh` that
// answers from fixtures, and returns the outputs the reusable call waits on.
async function runGate(gate, eventName, event, responses = {}) {
	const directory = await mkdtemp(join(tmpdir(), "inventory-secret-gate-"));
	try {
		const eventPath = join(directory, "event.json");
		const outputPath = join(directory, "output");
		await writeFile(eventPath, JSON.stringify(event));
		await writeFile(outputPath, "");
		await writeFile(
			join(directory, "gh"),
			`#!/usr/bin/env node
const responses = JSON.parse(process.env.GH_STUB_RESPONSES);
const [command, path] = process.argv.slice(2);
if (command !== "api" || !(path in responses)) {
	console.error("gh: Not Found (HTTP 404)");
	process.exit(1);
}
process.stdout.write(JSON.stringify(responses[path]));
`,
			{ mode: 0o755 },
		);
		const literals = Object.entries(gate.step.env).filter(
			([, value]) => typeof value === "string" && !value.includes("${{"),
		);
		const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", gate.step.run], {
			encoding: "utf8",
			env: {
				...Object.fromEntries(literals),
				PATH: [directory, dirname(process.execPath), process.env.PATH].join(delimiter),
				GH_TOKEN: "fixture",
				GH_STUB_RESPONSES: JSON.stringify({
					"repos/dinkuskit/inventory": { id: repositoryId, default_branch: "main" },
					"repos/dinkuskit/inventory/pulls/22": {
						state: "open",
						draft: false,
						user: { login: "contributor", id: 1001, type: "User" },
						base: { ref: "main", sha: baseSha, repo: { id: repositoryId } },
						head: { sha: headSha },
					},
					...responses,
				}),
				GITHUB_EVENT_NAME: eventName,
				GITHUB_EVENT_PATH: eventPath,
				GITHUB_OUTPUT: outputPath,
				PR_NUMBER: "22",
				MANUAL_PUBLISH: "",
			},
		});
		assert.equal(result.status, 0, result.stderr);
		return Object.fromEntries(
			(await readFile(outputPath, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split("=")),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function comment(association, login) {
	return {
		action: "created",
		issue: {
			number: 22,
			pull_request: { url: "https://api.github.com/repos/dinkuskit/inventory/pulls/22" },
		},
		comment: {
			body: "@clawsweeper review",
			author_association: association,
			user: { login, type: "User" },
		},
	};
}

test("the ClawSweeper reusable call waits on the bind permission gate", async () => {
	const { step, ...gate } = await committedGate();
	assert.deepEqual(gate, {
		job: "review",
		gateJob: "bind",
		gateStep: "live",
		output: "requested",
		stepOutput: "requested",
	});
});

test("the committed gate rejects a non-author before the reusable workflow is reached", async () => {
	const gate = await committedGate();

	const maintainer = await runGate(gate, "issue_comment", comment("OWNER", "dinkuskit"));
	assert.equal(maintainer[gate.stepOutput], "true");
	assert.equal(maintainer.head_sha, headSha);

	for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"]) {
		assert.deepEqual(
			await runGate(gate, "issue_comment", comment(association, "drive-by")),
			{ [gate.stepOutput]: "false" },
			association,
		);
	}

	const label = (permission) =>
		runGate(
			gate,
			"pull_request_target",
			{
				action: "labeled",
				label: { name: "clawsweeper:review" },
				sender: { login: "drive-by", type: "User" },
			},
			{ "repos/dinkuskit/inventory/collaborators/drive-by/permission": { permission } },
		);
	assert.equal((await label("write"))[gate.stepOutput], "true");
	assert.deepEqual(await label("read"), { [gate.stepOutput]: "false" });
});
