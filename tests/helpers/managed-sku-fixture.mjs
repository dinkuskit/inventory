import { createRegisterManagedSku } from "../../src/application/register-managed-sku.ts";

const fixturePrincipal = Object.freeze({
	kind: "system",
	id: "principal_managed_sku_fixture",
	surface: "test-fixture",
});

export async function createFixtureManagedSku(
	store,
	{
		poolId = "pool_test",
		skuId = "sku_keychain",
		sku = `VISIBLE-${skuId}`,
		displayName = `Inventory item ${skuId}`,
	} = {},
) {
	const execute = createRegisterManagedSku({
		store,
		now: () => new Date("2026-08-28T09:00:00.000Z"),
		createInventorySkuId: () => skuId,
	});
	const result = await execute(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: `cmd_fixture_register_${poolId}_${skuId}`,
			type: "sku.register",
			context: { siteId: "site_test", poolId },
			payload: { sku, displayNameIfNew: displayName, unit: "each" },
			references: [],
		},
		{ principal: fixturePrincipal },
	);
	if (result.outcome !== "registered") {
		throw new Error("Managed SKU fixture failed to register a new identity.");
	}
	return result;
}
