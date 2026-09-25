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
assert.equal(commit.remote, false);
assert.deepEqual(commit.upgrade.after, [5, 6]);
assert.equal(commit.upgrade.currentVersion, 6);
assert.equal(commit.upgrade.upgradedHold.packedAt, null);
assert.equal(commit.upgrade.upgradedHold.packedBy, null);
assert.equal(commit.upgrade.upgradedHold.status, "active");
assert.equal(commit.pack.outcome, "packed");
assert.equal(commit.pack.reservation.reservationId, "rsv_proof_hat");
assert.equal(commit.pack.reservation.status, "packed");
assert.equal(commit.durable.balance.onHand.value, "7");
assert.equal(commit.durable.balance.reserved.value, "0");
assert.equal(commit.durable.balance.available.value, "7");
assert.deepEqual(replay.result, commit.pack);
assert.equal(replay.durable.balance.onHand.value, "7");

console.log(
	JSON.stringify(
		{
			proof: "real-local-wrangler-durable-object",
			remote: false,
			runtime: "wrangler dev --local",
			stoppedAndReopened: true,
			persistedStateFiles,
			schemaUpgrade: commit.upgrade,
			packOutcome: commit.pack.outcome,
			replayReturnedOriginalPack: true,
			durableAfterPack: commit.durable.balance,
		},
		null,
		2,
	),
);
