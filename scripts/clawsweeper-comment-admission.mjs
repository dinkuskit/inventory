import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const TARGET_REPOSITORY = "dinkuskit/inventory";
export const TARGET_REPOSITORY_ID = 1307843786;
export const TARGET_DEFAULT_BRANCH = "main";

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REVIEW_COMMAND = /^@clawsweeper\s+(review|re-review|re-run)$/i;
const SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function login(value) {
	const candidate = record(value).login;
	return typeof candidate === "string" && LOGIN.test(candidate) ? candidate : null;
}

export function parseReviewCommand(body) {
	if (typeof body !== "string" || body.length > 65_536) return null;
	const matches = body
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim().match(REVIEW_COMMAND))
		.filter(Boolean);
	if (matches.length !== 1) return null;
	return matches[0][1].toLowerCase();
}

export function commentCandidate(event) {
	const root = record(event);
	const repository = record(root.repository);
	const issue = record(root.issue);
	const comment = record(root.comment);
	const actor = record(comment.user);

	if (root.action !== "created") return null;
	if (repository.full_name !== TARGET_REPOSITORY) return null;
	if (repository.id !== TARGET_REPOSITORY_ID) return null;
	if (repository.default_branch !== TARGET_DEFAULT_BRANCH) return null;
	if (!("pull_request" in issue)) return null;

	const number = positiveInteger(issue.number);
	const actorLogin = login(actor);
	const command = parseReviewCommand(comment.body);
	const association =
		typeof comment.author_association === "string"
			? comment.author_association.toUpperCase()
			: "";

	if (!number || !actorLogin || !command) return null;
	if (actor.type === "Bot" || actorLogin.toLowerCase().endsWith("[bot]")) return null;

	return { number, actorLogin, association, command };
}

export function admitCandidate(candidate, pullRequest) {
	const pull = record(pullRequest);
	const base = record(pull.base);
	const baseRepository = record(base.repo);
	const head = record(pull.head);
	const baseSha = typeof base.sha === "string" ? base.sha : "";
	const headSha = typeof head.sha === "string" ? head.sha : "";
	const pullAuthor = login(pull.user);

	if (positiveInteger(pull.number) !== candidate.number) return null;
	if (pull.state !== "open") return null;
	if (baseRepository.full_name !== TARGET_REPOSITORY) return null;
	if (base.ref !== TARGET_DEFAULT_BRANCH) return null;
	if (!SHA.test(baseSha) || !SHA.test(headSha) || !pullAuthor) return null;

	const maintainer = MAINTAINER_ASSOCIATIONS.has(candidate.association);
	const authorRerun =
		candidate.command !== "review" &&
		candidate.actorLogin.toLowerCase() === pullAuthor.toLowerCase();
	if (!maintainer && !authorRerun) return null;

	return {
		requested: true,
		prNumber: candidate.number,
		baseSha,
		headSha,
	};
}

async function fetchPullRequest(number, token) {
	const response = await fetch(
		`https://api.github.com/repos/${TARGET_REPOSITORY}/pulls/${number}`,
		{
			signal: AbortSignal.timeout(30_000),
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"User-Agent": "dinkuskit-clawsweeper-comment-admission",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
	if (!response.ok) {
		throw new Error(`GitHub pull request lookup returned status ${response.status}`);
	}
	return response.json();
}

async function appendOutputs(path, admission) {
	const lines = admission
		? [
				"requested=true",
				`pr_number=${admission.prNumber}`,
				`base_sha=${admission.baseSha}`,
				`head_sha=${admission.headSha}`,
			]
		: ["requested=false"];
	await appendFile(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

async function main() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	const outputPath = process.env.GITHUB_OUTPUT;
	const token = process.env.GH_TOKEN;
	if (!eventPath || !outputPath || !token) {
		throw new Error("required GitHub Actions environment is unavailable");
	}

	let event;
	try {
		event = JSON.parse(await readFile(eventPath, "utf8"));
	} catch {
		throw new Error("GitHub event payload could not be parsed");
	}

	const candidate = commentCandidate(event);
	if (!candidate) {
		await appendOutputs(outputPath, null);
		return;
	}

	const pullRequest = await fetchPullRequest(candidate.number, token);
	await appendOutputs(outputPath, admitCandidate(candidate, pullRequest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(
			`ClawSweeper comment admission failed: ${
				error instanceof Error ? error.message : "unknown error"
			}`,
		);
		process.exitCode = 1;
	});
}
