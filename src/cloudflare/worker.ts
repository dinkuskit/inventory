import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import {
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

	async readSkuStock(input: ReadSkuStockInput): Promise<SkuStockReadResult> {
		const query = normalizeReadSkuStockInput(input);
		const store = createCloudflareSqliteInventoryStore({
			storage: this.ctx.storage,
			poolId: query.poolId,
		});
		return createReadSkuStock({ store })(query);
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
