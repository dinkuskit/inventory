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
assert.deepEqual(commit.upgrade.after, [4, 5, 6]);
assert.equal(commit.upgrade.currentVersion, 6);
assert.equal(commit.reserve.outcome, "reserved");
assert.equal(commit.reserve.reservation.reservationId, "rsv_proof_hat");
assert.equal(commit.conflict.outcome, "rejected");
assert.equal(commit.conflict.code, "order_line_conflict");
assert.equal(commit.release.outcome, "released");
assert.equal(commit.release.reservation.status, "canceled");
assert.equal(commit.durable.balance.reserved.value, "0");
assert.equal(commit.durable.balance.available.value, "10");
assert.deepEqual(replay.result, commit.reserve);
assert.equal(replay.durable.balance.reserved.value, "0");

console.log(
	JSON.stringify(
		{
			proof: "real-local-wrangler-durable-object",
			remote: false,
			runtime: "wrangler dev --local",
			stoppedAndReopened: true,
			persistedStateFiles,
			schemaUpgrade: commit.upgrade,
			reserveOutcome: commit.reserve.outcome,
			conflictCode: commit.conflict.code,
			releaseOutcome: commit.release.outcome,
			replayReturnedOriginalReserve: true,
			durableAfterRelease: commit.durable.balance,
		},
		null,
		2,
	),
);
