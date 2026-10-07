import assert from "node:assert/strict";
import test from "node:test";
import { createAccountConnections, projectAccountOverview } from "../../src/features/hosted-onboarding/index.ts";

function fixture(provision = async op => ({ outcome: "committed", locationId: `loc_${op.operationId}` })) {
	const operations = new Map(), sites = new Map(), requests = new Map();
	let ids = 0;
	const store = { transaction: fn => fn({ getOperation: id => operations.get(id) ?? null, putOperation: op => operations.set(op.operationId, op), listOperations: () => [...operations.values()], listSites: () => [...sites.entries()].map(([siteId, connection]) => ({ siteId, connection })), getSite: id => sites.get(id) ?? null, putSite: (id, value) => sites.set(id, value), getRequest: id => requests.get(id) ?? null, putRequest: (id, value) => requests.set(id, value) }) };
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

test("projects shared and separate pools deterministically without stock semantics", () => {
	const operation = (operationId, poolId, originSiteId, status = "ready") => ({ operationId, poolId, locationName: "private", locationId: "private", commandId: `command-${operationId}`, originSiteId, status, failureCode: null });
	const overview = projectAccountOverview({
		operations: [
			operation("op-b", "pool-b", "site-b"),
			operation("op-a", "pool-a", "site-a"),
		],
		sites: [
			{ siteId: "site-z", connection: { operationId: "op-b", intent: "private" } },
			{ siteId: "site-a", connection: { operationId: "op-a", intent: "private" } },
			{ siteId: "site-b", connection: { operationId: "op-b", intent: "private" } },
		],
	}, () => "2026-10-07T02:30:00.000Z");
	assert.equal(overview.metadata.availability, "available");
	assert.deepEqual(overview.counts, { pools: 2, sites: 3 });
	assert.deepEqual(overview.pools, [
		{ poolId: "pool-a", siteCount: 1, provisioning: "ready" },
		{ poolId: "pool-b", siteCount: 2, provisioning: "ready" },
	]);
	assert.deepEqual(overview.sites.map(site => site.siteId), ["site-a", "site-b", "site-z"]);
});

test("invalid metadata is typed unavailable with null rows and counts", () => {
	const overview = projectAccountOverview({
		operations: [{
			operationId: "op-a", poolId: "pool-a", locationName: "private", locationId: null,
			commandId: "command-a", originSiteId: "site-a", status: "pending", failureCode: null,
		}],
		sites: [{ siteId: "site-a", connection: { operationId: "missing", intent: "private" } }],
	}, () => "2026-10-07T02:30:00.000Z");
	assert.deepEqual(overview.metadata, { availability: "unavailable", reason: "invalid_metadata" });
	assert.equal(overview.counts, null);
	assert.equal(overview.pools, null);
	assert.equal(overview.sites, null);
});

test("unknown statuses and duplicate metadata IDs are unavailable", () => {
	const operation = {
		operationId: "op-a", poolId: "pool-a", locationName: "private", locationId: null,
		commandId: "command-a", originSiteId: "site-a", status: "unknown", failureCode: null,
	};
	for (const metadata of [
		{ operations: [operation], sites: [{ siteId: "site-a", connection: { operationId: "op-a", intent: "private" } }] },
		{ operations: [{ ...operation, status: "ready" }, { ...operation, operationId: "op-b", commandId: "command-b", status: "ready" }], sites: [{ siteId: "site-a", connection: { operationId: "op-a", intent: "private" } }] },
	]) {
		const overview = projectAccountOverview(metadata, () => "2026-10-07T02:30:00.000Z");
		assert.deepEqual(overview.metadata, { availability: "unavailable", reason: "invalid_metadata" });
		assert.equal(overview.counts, null);
		assert.equal(overview.pools, null);
		assert.equal(overview.sites, null);
	}
});
