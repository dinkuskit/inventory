import assert from "node:assert/strict";
import test from "node:test";
import { createAccountConnections } from "../../src/features/hosted-onboarding/index.ts";

function fixture(provision = async op => ({ outcome: "committed", locationId: `loc_${op.operationId}` })) {
	const operations = new Map(), sites = new Map(), requests = new Map();
	let ids = 0;
	const store = { transaction: fn => fn({ getOperation: id => operations.get(id) ?? null, putOperation: op => operations.set(op.operationId, op), listOperations: () => [...operations.values()], getSite: id => sites.get(id) ?? null, putSite: (id, value) => sites.set(id, value), getRequest: id => requests.get(id) ?? null, putRequest: (id, value) => requests.set(id, value) }) };
	return { api: createAccountConnections({ store, newId: () => `op_${++ids}`, provision }), operations, sites };
}
const principal = { accountId: "fixture-account", siteId: "fixture-site" };
const input = { type: "create", requestId: "request-1", locationName: "First stock location" };

test("first connect, concurrent duplicates and new retry IDs retain one operation", async () => {
	const { api, operations } = fixture();
	assert.deepEqual(api.status(principal.siteId), { status: "unconnected" });
	const results = await Promise.all(Array.from({ length: 20 }, (_, i) => api.connect(principal, { ...input, requestId: `request-${i}` })));
	assert.equal(operations.size, 1);
	assert.ok(results.every(result => result.status === "ready" && result.operation.operationId === "op_1"));
	await assert.rejects(api.connect(principal, { ...input, locationName: "Different" }), /request_id_conflict/);
	await assert.rejects(api.connect(principal, { ...input, requestId: "new", locationName: "Different" }), /site_already_connected/);
});
test("explicit reconnect attaches owned operation and never mints another pool", async () => {
	const { api, operations } = fixture();
	const original = await api.connect(principal, input);
	const reconnect = { type: "reconnect", requestId: "reconnect", operationId: original.operation.operationId };
	const restored = await api.connect({ ...principal, siteId: "reinstalled-site" }, reconnect);
	assert.deepEqual(restored.operation, original.operation);
	assert.equal(operations.size, 1);
	await assert.rejects(fixture().api.connect({ accountId: "other", siteId: "other" }, reconnect), /operation_not_found/);
});
test("unknown provisioning keeps frozen operation/command and succeeds on retry", async () => {
	const seen = []; let fail = true;
	const { api, operations } = fixture(async op => { seen.push(op); if (fail) throw new Error("transport lost after commit"); return { outcome: "committed", locationId: "committed-location" }; });
	const pending = await api.connect(principal, input);
	assert.equal(pending.status, "pending");
	fail = false;
	const ready = await api.connect({ ...principal, siteId: "second-site" }, { type: "reconnect", requestId: "reconnect", operationId: pending.operation.operationId });
	assert.equal(ready.status, "ready");
	assert.equal(ready.operation.originSiteId, principal.siteId);
	assert.deepEqual(seen[0], seen[1]);
	assert.equal(operations.size, 1);
});
test("terminal rejection is explicit and cannot create replacement inventory", async () => {
	let calls = 0;
	const { api } = fixture(async () => { calls++; return { outcome: "rejected", code: "location_name_conflict" }; });
	const failed = await api.connect(principal, input);
	assert.equal(failed.status, "failed");
	assert.equal(failed.operation.failureCode, "location_name_conflict");
	assert.deepEqual(await api.connect(principal, input), failed);
	assert.equal(calls, 1);
});
test("delayed unknown response cannot regress a ready concurrent result", async () => {
	let release; let calls = 0;
	const { api } = fixture(async () => { if (++calls === 1) await new Promise(resolve => { release = resolve; }); return { outcome: "committed", locationId: "one-location" }; });
	const first = api.connect(principal, input);
	assert.equal((await api.connect(principal, input)).status, "ready");
	release();
	assert.equal((await first).status, "ready");
});
test("ownership, pool, site and account fields are rejected from browser input", async () => {
	for (const field of ["accountId", "siteId", "poolId", "principal"]) await assert.rejects(fixture().api.connect(principal, { ...input, [field]: "untrusted" }));
});
