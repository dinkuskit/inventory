import assert from "node:assert/strict";
import test from "node:test";
import { hostObservation } from "../../tools/emdash-host-observer.mjs";

test("host observer emits finite categories without retaining private error data", () => {
	const error = Object.assign(new Error("Could not resolve hostname: private-token@example.invalid"), {
		name: "SsrfError", code: "SSRF_BLOCKED", headers: { Authorization: "secret" }, cause: new Error("private")
	});
	assert.deepEqual(hostObservation("target_validation", error), {
		stage: "target_validation", outcome: "rejected", errorClass: "SsrfError", category: "dns_resolution_failed"
	});
	assert.equal(JSON.stringify(hostObservation("target_validation", error)).includes("private"), false);
	assert.equal(hostObservation("transport", { name: "private-token", message: "secret" }).errorClass, "Other");
	assert.throws(() => hostObservation("private-stage"), /Unknown observer stage/);
});
