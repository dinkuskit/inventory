import assert from "node:assert/strict";
import test from "node:test";

import {
	InvalidStockTransferCommandError,
	normalizeStockTransferCommand,
	normalizeStockTransferReference,
} from "../../src/features/stock-transfer/index.ts";

function createCommand(overrides = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: " cmd_transfer_create ",
		type: "transfer.create",
		context: { siteId: " site_test ", poolId: " pool_test " },
		payload: {
			reference: " Weekend   ST-147 ",
			originLocationId: " location_origin ",
			destinationLocationId: " location_destination ",
			lines: [
				{ skuId: " sku_hat ", quantity: { value: "05.000", unit: "each" } },
			],
			note: " Restock front store ",
			expectedDispatchDate: "2026-09-01",
			expectedArrivalDate: "2026-09-03",
		},
		references: [{ kind: " plan ", id: " weekend " }],
		expectedVersions: [],
		...overrides,
	};
}

test("normalizes a Created transfer with an editable reference and exact lines", () => {
	assert.deepEqual(normalizeStockTransferCommand(createCommand()), {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_transfer_create",
		type: "transfer.create",
		context: { siteId: "site_test", poolId: "pool_test" },
		payload: {
			reference: "Weekend ST-147",
			originLocationId: "location_origin",
			destinationLocationId: "location_destination",
			lines: [
				{ skuId: "sku_hat", quantity: { value: "5", unit: "each" } },
			],
			note: "Restock front store",
			expectedDispatchDate: "2026-09-01",
			expectedArrivalDate: "2026-09-03",
		},
		references: [{ kind: "plan", id: "weekend" }],
		expectedVersions: [],
	});
	assert.deepEqual(normalizeStockTransferReference("  ST-147  "), {
		reference: "ST-147",
		referenceKey: "st-147",
	});
	assert.equal(
		normalizeStockTransferCommand(
			createCommand({
				payload: { ...createCommand().payload, reference: null, note: "   " },
			}),
		).payload.note,
		null,
	);
});

test("normalizes full Created updates and version-bound cancellation", () => {
	const update = normalizeStockTransferCommand({
		...createCommand(),
		commandId: "cmd_transfer_update",
		type: "transfer.update",
		payload: { ...createCommand().payload, transferId: " transfer_opaque " },
		expectedVersions: [{ transferId: " transfer_opaque ", version: "01" }],
	});
	assert.equal(update.payload.transferId, "transfer_opaque");
	assert.deepEqual(update.expectedVersions, [
		{ transferId: "transfer_opaque", version: "1" },
	]);

	assert.deepEqual(
		normalizeStockTransferCommand({
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_transfer_cancel",
			type: "transfer.cancel",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { transferId: "transfer_opaque" },
			references: [],
			expectedVersions: [{ transferId: "transfer_opaque", version: "2" }],
		}),
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_transfer_cancel",
			type: "transfer.cancel",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { transferId: "transfer_opaque" },
			references: [],
			expectedVersions: [{ transferId: "transfer_opaque", version: "2" }],
		},
	);
});

test("normalizes version-bound dispatch and optional-reason reopen commands", () => {
	for (const [type, reason] of [
		["transfer.dispatch", undefined],
		["transfer.reopen", "  Carrier loaded the wrong pallet  "],
		["transfer.reopen", "   "],
	]) {
		const command = normalizeStockTransferCommand({
			schema: "dinkuskit.inventory.command/v1",
			commandId: `cmd_${type}_${reason ?? "none"}`,
			type,
			context: { siteId: " site_test ", poolId: " pool_test " },
			payload: type === "transfer.dispatch"
				? { transferId: " transfer_opaque " }
				: { transferId: " transfer_opaque ", reason },
			references: [],
			expectedVersions: [{ transferId: " transfer_opaque ", version: "03" }],
		});
		assert.equal(command.payload.transferId, "transfer_opaque");
		assert.deepEqual(command.expectedVersions, [
			{ transferId: "transfer_opaque", version: "3" },
		]);
		if (type === "transfer.reopen") {
			assert.equal(command.payload.reason, reason?.trim() || null);
		}
	}
	assert.throws(
		() => normalizeStockTransferCommand({
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_dispatch_with_date",
			type: "transfer.dispatch",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: {
				transferId: "transfer_opaque",
				dispatchedDate: "2026-08-30",
			},
			references: [],
			expectedVersions: [{ transferId: "transfer_opaque", version: "3" }],
		}),
		InvalidStockTransferCommandError,
	);
});

test("rejects ambiguous, duplicate, negative, and invalid-date transfer contents", () => {
	const invalidPayloads = [
		{ ...createCommand().payload, originLocationId: "location_destination" },
		{
			...createCommand().payload,
			lines: [
				createCommand().payload.lines[0],
				createCommand().payload.lines[0],
			],
		},
		{
			...createCommand().payload,
			lines: [{ skuId: "sku_hat", quantity: { value: "-1", unit: "each" } }],
		},
		{ ...createCommand().payload, expectedDispatchDate: "09/01/2026" },
		{
			...createCommand().payload,
			expectedDispatchDate: "2026-09-04",
			expectedArrivalDate: "2026-09-03",
		},
	];
	for (const payload of invalidPayloads) {
		assert.throws(
			() => normalizeStockTransferCommand(createCommand({ payload })),
			InvalidStockTransferCommandError,
		);
	}
});
