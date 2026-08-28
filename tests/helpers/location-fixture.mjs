import { createExecuteLocationCommand } from "../../src/application/location-registry.ts";

const fixturePrincipal = Object.freeze({
	kind: "system",
	id: "principal_location_fixture",
	surface: "test-fixture",
});

function fixtureCommand(type, { poolId, locationId, name }) {
	const suffix = type.replace("location.", "");
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: `cmd_fixture_${suffix}_${poolId}_${locationId}`,
		type,
		context:
			type === "location.create"
				? { siteId: "site_test", poolId }
				: { siteId: "site_test", poolId, locationId },
		payload:
			type === "location.create" || type === "location.rename"
				? { name }
				: {},
		references: [],
	};
}

async function executeFixtureLocation(
	store,
	type,
	{
		poolId = "pool_test",
		locationId = "location_north",
		name = `Fixture ${locationId}`,
	} = {},
) {
	const suffix = type.replace("location.", "");
	const execute = createExecuteLocationCommand({
		store,
		now: () => new Date("2026-08-28T10:00:00.000Z"),
		createLocationId: () => locationId,
		createReceiptId: () => `rcpt_fixture_${suffix}_${poolId}_${locationId}`,
	});
	const result = await execute(
		fixtureCommand(type, { poolId, locationId, name }),
		{ principal: fixturePrincipal },
	);
	if (result.outcome !== "committed") {
		throw new Error(`Location fixture ${type} failed: ${result.code}`);
	}
	return result;
}

export async function createFixtureLocation(store, options = {}) {
	return executeFixtureLocation(store, "location.create", options);
}

export async function archiveFixtureLocation(store, options = {}) {
	return executeFixtureLocation(store, "location.archive", options);
}

export async function restoreFixtureLocation(store, options = {}) {
	return executeFixtureLocation(store, "location.restore", options);
}
