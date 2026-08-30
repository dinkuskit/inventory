import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [commitPath, replayPath, persistedStateFilesInput] = process.argv.slice(2);
if (!commitPath || !replayPath || !persistedStateFilesInput) {
	throw new TypeError("Pass commit JSON, replay JSON, and persisted state-file count.");
}

const persistedStateFiles = Number.parseInt(persistedStateFilesInput, 10);
assert.ok(Number.isSafeInteger(persistedStateFiles) && persistedStateFiles > 0);

const [commit, replay] = await Promise.all([
	readFile(commitPath, "utf8").then(JSON.parse),
	readFile(replayPath, "utf8").then(JSON.parse),
]);

assert.equal(commit.phase, "commit");
assert.equal(replay.phase, "replay_after_restart");
assert.equal(commit.preview.confirmation, "<redacted>");
assert.equal(replay.confirmation, "<redacted>");
assert.equal(commit.result.outcome, "committed");
assert.deepEqual(replay.result, commit.result);
assert.deepEqual(commit.durable.balance, replay.durable.balance);
assert.equal(replay.durable.balance.onHand.value, "7");
assert.equal(replay.durable.balance.version, "2");
assert.equal(commit.durable.adjustmentReceiptCount, 1);
assert.equal(replay.durable.adjustmentReceiptCount, 1);

console.log(
	JSON.stringify(
		{
			proof: "real-local-wrangler-durable-object",
			remote: false,
			runtime: "wrangler dev --local",
			stoppedAndReopened: true,
			persistedStateFiles,
			confirmation: "<redacted>",
			preview: commit.preview,
			committedResult: commit.result,
			replayReturnedOriginalTerminalResult: true,
			durableAfterReplay: replay.durable,
		},
		null,
		2,
	),
);
