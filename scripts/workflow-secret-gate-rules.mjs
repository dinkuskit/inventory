import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { load } from "js-yaml";

const WORKFLOW_DIRECTORY = ".github/workflows";
// Events an actor without write access can raise while the workflow still
// runs with the base repository's secrets.
const UNTRUSTED_TRIGGERS = ["pull_request_target", "issue_comment"];
const GATE_CONDITION = /^needs\.([\w-]+)\.outputs\.([\w-]+)\s*==\s*'true'$/;
const STEP_OUTPUT = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/;
const PERMISSION_CHECKS = [
	/\bauthor_association\b/,
	/\bcollaborators\/[^\s'"]+\/permission\b/,
	/\bgetCollaboratorPermissionLevel\b/,
];

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function untrustedTriggers(workflow) {
	const on = workflow.on;
	const events =
		typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(record(on));
	return UNTRUSTED_TRIGGERS.filter((trigger) => events.includes(trigger));
}

function passesSecrets(job) {
	return job.secrets === "inherit" || Object.keys(record(job.secrets)).length > 0;
}

// Top-level `&&` operands of a job condition. A top-level `||` means no operand
// is required on its own, so such a condition yields nothing.
function requiredConditions(expression) {
	if (typeof expression !== "string") return [];
	const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
	const conditions = [];
	let depth = 0;
	let quoted = false;
	let start = 0;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "'") quoted = !quoted;
		if (quoted) continue;
		if (character === "(") depth += 1;
		if (character === ")") depth -= 1;
		if (depth !== 0) continue;
		if (source.startsWith("||", index)) return [];
		if (source.startsWith("&&", index)) {
			conditions.push(source.slice(start, index).trim());
			start = index + 2;
			index += 1;
		}
	}
	conditions.push(source.slice(start).trim());
	return conditions;
}

function checksPermission(step) {
	const script = [step.run, record(step.with).script]
		.filter((value) => typeof value === "string")
		.join("\n");
	return PERMISSION_CHECKS.some((pattern) => pattern.test(script));
}

function permissionGate(jobs, job) {
	const needed = new Set([job.needs].flat().filter((name) => typeof name === "string"));
	for (const condition of requiredConditions(job.if)) {
		const required = condition.match(GATE_CONDITION);
		if (!required || !needed.has(required[1])) continue;
		const gateJob = record(jobs[required[1]]);
		const output = record(gateJob.outputs)[required[2]];
		const bound = typeof output === "string" ? output.trim().match(STEP_OUTPUT) : null;
		if (!bound || !Array.isArray(gateJob.steps)) continue;
		const step = gateJob.steps.map(record).find((candidate) => candidate.id === bound[1]);
		if (!step || !checksPermission(step)) continue;
		return {
			gateJob: required[1],
			gateStep: bound[1],
			output: required[2],
			stepOutput: bound[2],
			step,
		};
	}
	return null;
}

function inspect(path, source) {
	let workflow;
	try {
		workflow = record(load(source));
	} catch {
		return { gates: [], violations: [`${path}: workflow could not be parsed`] };
	}
	const triggers = untrustedTriggers(workflow);
	const jobs = record(workflow.jobs);
	const gates = [];
	const violations = [];
	if (triggers.length === 0) return { gates, violations };
	for (const [name, value] of Object.entries(jobs)) {
		const job = record(value);
		if (typeof job.uses !== "string" || !passesSecrets(job)) continue;
		const gate = permissionGate(jobs, job);
		if (gate) gates.push({ job: name, ...gate });
		else {
			violations.push(
				`${path}: job ${name} passes secrets to ${job.uses} on ${triggers.join(", ")} without a preceding permission-gate step`,
			);
		}
	}
	return { gates, violations };
}

export function findSecretGateViolations(path, source) {
	return inspect(path, source).violations;
}

export function findPermissionGates(path, source) {
	return inspect(path, source).gates;
}

export async function auditWorkflowSecretGates(rootInput) {
	const root = rootInput instanceof URL ? fileURLToPath(rootInput) : rootInput;
	const directory = join(root, WORKFLOW_DIRECTORY);
	const findings = [];
	for (const name of (await readdir(directory)).sort()) {
		if (!/\.ya?ml$/.test(name)) continue;
		const path = `${WORKFLOW_DIRECTORY}/${name}`;
		findings.push(
			...findSecretGateViolations(path, await readFile(join(directory, name), "utf8")),
		);
	}
	return findings;
}
