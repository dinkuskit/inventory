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
assert.equal(commit.reserve.hat, "reserved");
assert.equal(commit.reserve.shirt, "reserved");
assert.equal(commit.packAll.outcome, "packed_all");
assert.equal(commit.packAll.reservations.length, 2);
assert.equal(commit.packAll.reservations[0].reservationId, "rsv_proof_hat");
assert.equal(commit.packAll.reservations[1].reservationId, "rsv_proof_shirt");
assert.equal(commit.durable.balances.hat.onHand.value, "7");
assert.equal(commit.durable.balances.hat.reserved.value, "0");
assert.equal(commit.durable.balances.shirt.onHand.value, "4");
assert.equal(commit.durable.balances.shirt.reserved.value, "0");
assert.deepEqual(replay.result, commit.packAll);
assert.equal(replay.durable.balances.hat.onHand.value, "7");
assert.equal(replay.durable.balances.shirt.onHand.value, "4");

console.log(
	JSON.stringify(
		{
			proof: "real-local-wrangler-durable-object",
			remote: false,
			runtime: "wrangler dev --local",
			stoppedAndReopened: true,
			persistedStateFiles,
			packAllOutcome: commit.packAll.outcome,
			packedTickets: commit.packAll.reservations.map(
				(hold) => hold.reservationId,
			),
			replayReturnedOriginalPackAll: true,
			durableAfterPackAll: commit.durable.balances,
		},
		null,
		2,
	),
);
