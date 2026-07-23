import assert from "node:assert/strict";
import test from "node:test";

import {
	admitCandidate,
	commentCandidate,
	parseReviewCommand,
} from "../../scripts/clawsweeper-comment-admission.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function event(overrides = {}) {
	return {
		action: "created",
		repository: {
			full_name: "dinkuskit/inventory",
			id: 1307843786,
			default_branch: "main",
		},
		issue: { number: 22, pull_request: {} },
		comment: {
			body: "Context for the reviewer.\n\n@clawsweeper review",
			author_association: "OWNER",
			user: { login: "dinkuskit", type: "User" },
		},
		...overrides,
	};
}

function pull(overrides = {}) {
	return {
		number: 22,
		state: "open",
		user: { login: "contributor" },
		base: {
			ref: "main",
			sha: baseSha,
			repo: { full_name: "dinkuskit/inventory" },
		},
		head: { sha: headSha },
		...overrides,
	};
}

test("recognizes one exact command line inside a longer comment", () => {
	assert.equal(parseReviewCommand("proof\r\n  @clawsweeper re-review  \r\n"), "re-review");
	assert.equal(parseReviewCommand("please use @clawsweeper review now"), null);
	assert.equal(
		parseReviewCommand("@clawsweeper review\n@clawsweeper re-run"),
		null,
	);
});

test("accepts a maintainer review request and binds the live PR tuple", () => {
	const candidate = commentCandidate(event());
	assert.ok(candidate);
	assert.deepEqual(admitCandidate(candidate, pull()), {
		requested: true,
		prNumber: 22,
		baseSha,
		headSha,
	});
});

test("lets the exact PR author request a fresh read-only re-review", () => {
	const candidate = commentCandidate(
		event({
			comment: {
				body: "@clawsweeper re-run",
				author_association: "CONTRIBUTOR",
				user: { login: "contributor", type: "User" },
			},
		}),
	);
	assert.ok(candidate);
	assert.ok(admitCandidate(candidate, pull()));
});

test("does not let an untrusted contributor start review or rerun another PR", () => {
	const review = commentCandidate(
		event({
			comment: {
				body: "@clawsweeper review",
				author_association: "CONTRIBUTOR",
				user: { login: "contributor", type: "User" },
			},
		}),
	);
	const rerun = commentCandidate(
		event({
			comment: {
				body: "@clawsweeper re-review",
				author_association: "NONE",
				user: { login: "someone-else", type: "User" },
			},
		}),
	);
	assert.ok(review);
	assert.ok(rerun);
	assert.equal(admitCandidate(review, pull()), null);
	assert.equal(admitCandidate(rerun, pull()), null);
});

test("ignores bots, non-PR comments, wrong repositories, and edited comments", () => {
	assert.equal(
		commentCandidate(
			event({
				comment: {
					body: "@clawsweeper review",
					author_association: "OWNER",
					user: { login: "automation-bot", type: "Bot" },
				},
			}),
		),
		null,
	);
	assert.equal(commentCandidate(event({ issue: { number: 22 } })), null);
	assert.equal(
		commentCandidate(
			event({
				repository: {
					full_name: "attacker/inventory",
					id: 1307843786,
					default_branch: "main",
				},
			}),
		),
		null,
	);
	assert.equal(commentCandidate(event({ action: "edited" })), null);
});

test("fails closed when the live PR is closed, moved, or malformed", () => {
	const candidate = commentCandidate(event());
	assert.ok(candidate);
	assert.equal(admitCandidate(candidate, pull({ state: "closed" })), null);
	assert.equal(
		admitCandidate(
			candidate,
			pull({
				base: {
					ref: "release",
					sha: baseSha,
					repo: { full_name: "dinkuskit/inventory" },
				},
			}),
		),
		null,
	);
	assert.equal(admitCandidate(candidate, pull({ head: { sha: "not-a-sha" } })), null);
});
