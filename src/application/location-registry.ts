import {
	ARCHIVE_LOCATION_TYPE,
	CREATE_LOCATION_TYPE,
	LOCATION_LIST_RESULT_SCHEMA,
	RENAME_LOCATION_TYPE,
	RESTORE_LOCATION_TYPE,
	digestLocationCommand,
	normalizeListLocationsInput,
	normalizeLocationCommand,
	normalizeLocationName,
	type ListLocationsInput,
	type LocationCommandResult,
	type LocationCommandV1,
	type LocationListResult,
	type LocationRecord,
} from "../domain/location-registry.ts";
import {
	COMMAND_RESULT_SCHEMA,
	RECEIPT_SCHEMA,
	normalizeCommandPrincipal,
	type CommandPrincipal,
} from "../domain/opening-balance.ts";
import type {
	InventoryStore,
	InventoryTransaction,
} from "../storage/inventory-store.ts";

export type ExecuteLocationCommandExecution = Readonly<{
	principal: CommandPrincipal;
}>;

export type ExecuteLocationCommand = (
	command: LocationCommandV1,
	execution: ExecuteLocationCommandExecution,
) => Promise<LocationCommandResult>;

export type ExecuteLocationCommandDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createLocationId: () => string;
	createReceiptId: () => string;
}>;

export type ListLocations = (
	input: ListLocationsInput,
) => Promise<LocationListResult>;

export type ListLocationsDependencies = Readonly<{
	store: InventoryStore;
}>;

function conflict(commandId: string): LocationCommandResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code: "command_id_conflict",
		message: "The command ID is already bound to different contents.",
	};
}

function rejection(
	commandId: string,
	code:
		| "location_name_conflict"
		| "location_not_found"
		| "location_already_archived"
		| "location_not_archived",
	message: string,
): LocationCommandResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code,
		message,
	};
}

function durableRejection(
	transaction: InventoryTransaction,
	command: LocationCommandV1,
	commandDigest: string,
	result: LocationCommandResult,
): LocationCommandResult {
	transaction.storeRejection({
		commandId: command.commandId,
		commandDigest,
		result,
	});
	return result;
}

function createdAtFrom(now: () => Date): string {
	const current = now();
	if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
		throw new TypeError("now must return a valid Date.");
	}
	return current.toISOString();
}

function idFrom(factory: () => string, field: string): string {
	const value = factory();
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${field} must return a non-empty string.`);
	}
	return value.trim();
}

function nextVersion(record: LocationRecord): string {
	try {
		return (BigInt(record.version) + 1n).toString();
	} catch {
		throw new Error("Stored location version is invalid.");
	}
}

function targetLocation(
	transaction: InventoryTransaction,
	command: Exclude<LocationCommandV1, { type: typeof CREATE_LOCATION_TYPE }>,
	commandDigest: string,
): LocationRecord | LocationCommandResult {
	const found = transaction.getLocation(command.context.locationId);
	if (found !== null) {
		return found;
	}
	return durableRejection(
		transaction,
		command,
		commandDigest,
		rejection(
			command.commandId,
			"location_not_found",
			"The location does not exist in this inventory pool.",
		),
	);
}

export function executeLocationCommandInTransaction(
	transaction: InventoryTransaction,
	command: LocationCommandV1,
	principal: CommandPrincipal,
	commandDigest: string,
	dependencies: Pick<
		ExecuteLocationCommandDependencies,
		"now" | "createLocationId" | "createReceiptId"
	>,
): LocationCommandResult {
	const existing = transaction.getCommand<LocationCommandResult>(
		command.commandId,
	);
	if (existing !== null) {
		return existing.commandDigest === commandDigest
			? existing.result
			: conflict(command.commandId);
	}

	const committedAt = createdAtFrom(dependencies.now);
	let before: LocationRecord | null = null;
	let after: LocationRecord;

	if (command.type === CREATE_LOCATION_TYPE) {
		const { name, nameKey } = normalizeLocationName(command.payload.name);
		if (transaction.getLocationByNameKey(nameKey) !== null) {
			return durableRejection(
				transaction,
				command,
				commandDigest,
				rejection(
					command.commandId,
					"location_name_conflict",
					"Another location already uses this name.",
				),
			);
		}
		const locationId = idFrom(
			dependencies.createLocationId,
			"createLocationId",
		);
		if (transaction.getLocation(locationId) !== null) {
			throw new Error("createLocationId returned an existing location ID.");
		}
		after = {
			poolId: command.context.poolId,
			locationId,
			name,
			nameKey,
			status: "active",
			version: "1",
			createdAt: committedAt,
			updatedAt: committedAt,
			archivedAt: null,
		};
	} else {
		const found = targetLocation(
			transaction,
			command,
			commandDigest,
		);
		if (!("locationId" in found)) {
			return found;
		}
		before = found;
		if (command.type === RENAME_LOCATION_TYPE) {
			const { name, nameKey } = normalizeLocationName(command.payload.name);
			const named = transaction.getLocationByNameKey(nameKey);
			if (named !== null && named.locationId !== found.locationId) {
				return durableRejection(
					transaction,
					command,
					commandDigest,
					rejection(
						command.commandId,
						"location_name_conflict",
						"Another location already uses this name.",
					),
				);
			}
			after = {
				...found,
				name,
				nameKey,
				version: nextVersion(found),
				updatedAt: committedAt,
			};
		} else if (command.type === ARCHIVE_LOCATION_TYPE) {
			if (found.status === "archived") {
				return durableRejection(
					transaction,
					command,
					commandDigest,
					rejection(
						command.commandId,
						"location_already_archived",
						"The location is already archived.",
					),
				);
			}
			const blockers = transaction.listLocationBalanceBlockers(
				found.locationId,
			);
			if (blockers.length > 0) {
				return durableRejection(transaction, command, commandDigest, {
					schema: COMMAND_RESULT_SCHEMA,
					outcome: "rejected",
					commandId: command.commandId,
					code: "location_not_empty",
					message:
						"The location must have zero on-hand and zero reserved stock before archiving.",
					blockers,
				});
			}
			after = {
				...found,
				status: "archived",
				version: nextVersion(found),
				updatedAt: committedAt,
				archivedAt: committedAt,
			};
		} else {
			if (found.status !== "archived") {
				return durableRejection(
					transaction,
					command,
					commandDigest,
					rejection(
						command.commandId,
						"location_not_archived",
						"The location is not archived.",
					),
				);
			}
			after = {
				...found,
				status: "active",
				version: nextVersion(found),
				updatedAt: committedAt,
				archivedAt: null,
			};
		}
	}

	const receipt = {
		schema: RECEIPT_SCHEMA,
		receiptId: idFrom(dependencies.createReceiptId, "createReceiptId"),
		commandId: command.commandId,
		commandDigest,
		status: "committed",
		type: command.type,
		committedAt,
		principal,
		context: {
			siteId: command.context.siteId,
			poolId: command.context.poolId,
		},
		effect: { before, after },
		references: command.references,
	} as const;
	const result: LocationCommandResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "committed",
		commandId: command.commandId,
		receipt,
	};
	transaction.commitLocation({
		commandId: command.commandId,
		commandDigest,
		previous: before,
		location: after,
		receipt,
		result,
	});
	return result;
}

export function createExecuteLocationCommand(
	dependencies: ExecuteLocationCommandDependencies,
): ExecuteLocationCommand {
	if (dependencies?.store === undefined) {
		throw new TypeError("store is required.");
	}
	if (typeof dependencies.now !== "function") {
		throw new TypeError("now is required.");
	}
	if (typeof dependencies.createLocationId !== "function") {
		throw new TypeError("createLocationId is required.");
	}
	if (typeof dependencies.createReceiptId !== "function") {
		throw new TypeError("createReceiptId is required.");
	}

	return async function executeLocationCommand(
		commandInput: LocationCommandV1,
		executionInput: ExecuteLocationCommandExecution,
	): Promise<LocationCommandResult> {
		const command = normalizeLocationCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestLocationCommand(command);
		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) =>
				executeLocationCommandInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				),
		);
	};
}

export function createListLocations(
	dependencies: ListLocationsDependencies,
): ListLocations {
	if (dependencies?.store === undefined) {
		throw new TypeError("store is required.");
	}
	return async function listLocations(
		input: ListLocationsInput,
	): Promise<LocationListResult> {
		const query = normalizeListLocationsInput(input);
		return {
			schema: LOCATION_LIST_RESULT_SCHEMA,
			poolId: query.poolId,
			status: query.status,
			locations: await dependencies.store.listLocations(query),
		};
	};
}
