import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createExecuteLocationCommand, createListLocations } from "../application/location-registry.ts";
import type { AccountPrincipal, Operation, ProvisionResult } from "../features/hosted-onboarding/index.ts";

import {
	createReadReceiptHistory,
	createReadOpeningBalanceEligibility,
	createReadSkuLocationBalance,
	createReadSkuStock,
} from "../application/read-inventory.ts";
import {
	normalizeReadSkuLocationBalanceInput,
	normalizeReadSkuStockInput,
	type ReadSkuLocationBalanceInput,
	type ReadSkuStockInput,
	type SkuStockReadResult,
	type SkuLocationBalanceReadResult,
} from "../domain/inventory-read.ts";
import {
	InvalidStockAdjustmentCommandError,
	StockAdjustmentConfirmationError,
	StockAdjustmentPreviewError,
	createConfirmStockAdjustment,
	createPreviewStockAdjustment,
	type AdjustStockCommandV1,
	type ConfirmStockAdjustmentExecution,
	type PreviewStockAdjustmentExecution,
	type PreviewStockAdjustmentInputV1,
	type StockAdjustmentPreviewV1,
	type StockAdjustmentResult,
} from "../features/stock-adjustment/index.ts";
import {
	OpeningBalanceConfirmationError,
	OpeningBalancePreviewError,
	createConfirmOpeningBalance,
	createPreviewOpeningBalance,
	type ConfirmOpeningBalanceExecution,
	type PreviewOpeningBalanceExecution,
} from "../application/preview-confirm-opening-balance.ts";
import type {
	OpeningBalancePreviewV1,
	OpeningBalanceResult,
	PreviewOpeningBalanceInputV1,
	SetOpeningBalanceCommandV1,
} from "../domain/opening-balance.ts";
import { createCloudflareSqliteInventoryStore } from "../storage/cloudflare-sqlite-inventory-store.ts";
import {
	initializeCloudflareInventorySchema,
	readCloudflareInventoryRecordCounts,
	readCloudflareInventorySchemaStatus,
	type CloudflareInventoryRecordCounts,
	type CloudflareInventorySchemaStatus,
} from "./schema.ts";

export interface InventoryWorkerEnv {
	INVENTORY_POOLS: DurableObjectNamespace<InventoryPool>;
}

export type InventoryInspection = Readonly<{
	schema: CloudflareInventorySchemaStatus;
	balance: SkuLocationBalanceReadResult;
	recordCounts: CloudflareInventoryRecordCounts;
}>;

export class InventoryPool extends DurableObject<InventoryWorkerEnv> {
	constructor(ctx: DurableObjectState, env: InventoryWorkerEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			initializeCloudflareInventorySchema(ctx.storage);
		});
	}

	async schemaStatus(): Promise<CloudflareInventorySchemaStatus> {
		return readCloudflareInventorySchemaStatus(this.ctx.storage);
	}

	/** Internal service RPC; public callers must pass the hosted authorization boundary. */
	async provisionFirstLocation(operation: Operation, principal: AccountPrincipal): Promise<ProvisionResult> {
		const store = createCloudflareSqliteInventoryStore({ storage: this.ctx.storage, poolId: operation.poolId });
		const execute = createExecuteLocationCommand({ store, now: () => new Date(), createLocationId: () => `location_${operation.operationId}`, createReceiptId: () => crypto.randomUUID() });
		const result = await execute({ schema: "dinkuskit.inventory.command/v1", type: "location.create", commandId: operation.commandId, context: { poolId: operation.poolId, siteId: operation.originSiteId }, payload: { name: operation.locationName }, references: [] }, { principal: { kind: "human", id: principal.accountId, displayName: "DinkusKit account administrator", surface: "emdash" } });
		return result.outcome === "committed" ? { outcome: "committed", locationId: result.receipt.effect.after.locationId } : { outcome: "rejected", code: result.code };
	}

	async listLocations(poolId: string) {
		const store = createCloudflareSqliteInventoryStore({ storage: this.ctx.storage, poolId });
		return createListLocations({ store })({ poolId, status: "active" });
	}

	async readSkuLocationBalance(
		input: ReadSkuLocationBalanceInput,
	): Promise<SkuLocationBalanceReadResult> {
		const key = normalizeReadSkuLocationBalanceInput(input);
		const store = createCloudflareSqliteInventoryStore({
			storage: this.ctx.storage,
			poolId: key.poolId,
		});
		return createReadSkuLocationBalance({ store })(key);
	}

	async readOpeningBalanceEligibility(input: ReadSkuLocationBalanceInput) {
		const key = normalizeReadSkuLocationBalanceInput(input);
		const store = createCloudflareSqliteInventoryStore({ storage: this.ctx.storage, poolId: key.poolId });
		return createReadOpeningBalanceEligibility({ store })(key);
	}

	async readSkuStock(input: ReadSkuStockInput): Promise<SkuStockReadResult> {
		const query = normalizeReadSkuStockInput(input);
		const store = createCloudflareSqliteInventoryStore({
			storage: this.ctx.storage,
			poolId: query.poolId,
		});
		return createReadSkuStock({ store })(query);
	}

	async previewStockAdjustment(
		input: PreviewStockAdjustmentInputV1,
		execution: PreviewStockAdjustmentExecution,
	): Promise<{ ok: true; preview: StockAdjustmentPreviewV1 } | { ok: false; error: string; message: string }> {
		const store = createCloudflareSqliteInventoryStore({
			storage: this.ctx.storage,
			poolId: input.context.poolId,
		});
		try {
			const preview = await createPreviewStockAdjustment({
				store,
				now: () => new Date(),
				createConfirmation: () => crypto.randomUUID(),
			})(input, execution);
			return { ok: true, preview };
		} catch (error) {
			if (error instanceof StockAdjustmentPreviewError) {
				return { ok: false, error: error.code, message: error.message };
			}
			throw error;
		}
	}

	async previewOpeningBalance(
		input: PreviewOpeningBalanceInputV1,
		execution: PreviewOpeningBalanceExecution,
	): Promise<{ ok: true; preview: OpeningBalancePreviewV1 } | { ok: false; error: string; message: string }> {
		const store = createCloudflareSqliteInventoryStore({ storage: this.ctx.storage, poolId: input.context.poolId });
		try {
			return { ok: true, preview: await createPreviewOpeningBalance({
				store, now: () => new Date(), createConfirmation: () => crypto.randomUUID(),
			})(input, execution) };
		} catch (error) {
			if (error instanceof OpeningBalancePreviewError) return { ok: false, error: error.code, message: error.message };
			throw error;
		}
	}

	async confirmOpeningBalance(
		confirmation: string,
		command: SetOpeningBalanceCommandV1,
		execution: ConfirmOpeningBalanceExecution,
	): Promise<{ ok: true; result: OpeningBalanceResult } | { ok: false; error: string; message: string }> {
		const store = createCloudflareSqliteInventoryStore({ storage: this.ctx.storage, poolId: command.context.poolId });
		try {
			return { ok: true, result: await createConfirmOpeningBalance({
				store, now: () => new Date(), createReceiptId: () => crypto.randomUUID(),
			})(confirmation, command, execution) };
		} catch (error) {
			if (error instanceof OpeningBalanceConfirmationError) return { ok: false, error: error.code, message: error.message };
			throw error;
		}
	}

	async confirmStockAdjustment(
		confirmation: string,
		command: AdjustStockCommandV1,
		execution: ConfirmStockAdjustmentExecution,
	): Promise<{ ok: true; result: StockAdjustmentResult } | { ok: false; error: string; message: string }> {
		const store = createCloudflareSqliteInventoryStore({
			storage: this.ctx.storage,
			poolId: command.context.poolId,
		});
		try {
			const result = await createConfirmStockAdjustment({
				store,
				now: () => new Date(),
				createReceiptId: () => crypto.randomUUID(),
			})(confirmation, command, execution);
			return { ok: true, result };
		} catch (error) {
			if (error instanceof StockAdjustmentConfirmationError) {
				return { ok: false, error: error.code, message: error.message };
			}
			if (error instanceof InvalidStockAdjustmentCommandError) {
				return { ok: false, error: "invalid_command", message: error.message };
			}
			throw error;
		}
	}

	async readReceiptHistory(input: {
		poolId: string;
		scope: { kind: "location"; locationId: string } | { kind: "all_locations" };
	}) {
		const store = createCloudflareSqliteInventoryStore({
			storage: this.ctx.storage,
			poolId: input.poolId,
		});
		return createReadReceiptHistory({ store })(input);
	}

	async recordCounts(): Promise<CloudflareInventoryRecordCounts> {
		return readCloudflareInventoryRecordCounts(this.ctx.storage);
	}
}

export default class InventoryService extends WorkerEntrypoint<InventoryWorkerEnv> {
	async readSkuStock(input: ReadSkuStockInput): Promise<SkuStockReadResult> {
		const query = normalizeReadSkuStockInput(input);
		return this.env.INVENTORY_POOLS.getByName(query.poolId).readSkuStock(query);
	}

	async inspectSkuLocation(
		input: ReadSkuLocationBalanceInput,
	): Promise<InventoryInspection> {
		const key = normalizeReadSkuLocationBalanceInput(input);
		const pool = this.env.INVENTORY_POOLS.getByName(key.poolId);
		const [schema, balance, recordCounts] = await Promise.all([
			pool.schemaStatus(),
			pool.readSkuLocationBalance(key),
			pool.recordCounts(),
		]);
		return { schema, balance, recordCounts };
	}

	fetch(): Response {
		return new Response("Not Found", { status: 404 });
	}
}
