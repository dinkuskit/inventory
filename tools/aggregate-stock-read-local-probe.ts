import { WorkerEntrypoint } from "cloudflare:workers";

import {
	normalizeReadSkuStockInput,
	type ReadSkuStockInput,
	type SkuStockReadResult,
} from "../src/domain/inventory-read.ts";

interface InventoryServiceBinding {
	readSkuStock(input: ReadSkuStockInput): Promise<SkuStockReadResult>;
}

interface AggregateStockProofEnv {
	INVENTORY_SERVICE: InventoryServiceBinding;
}

export default class AggregateStockReadLocalProbe extends WorkerEntrypoint<AggregateStockProofEnv> {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({ error: "method_not_allowed" }, { status: 405 });
		}
		try {
			const query = normalizeReadSkuStockInput(await request.json());
			const result = await this.env.INVENTORY_SERVICE.readSkuStock(query);
			return Response.json(result);
		} catch (error) {
			return Response.json(
				{
					error: "invalid_proof_request",
					message: error instanceof Error ? error.message : "Invalid request.",
				},
				{ status: 400 },
			);
		}
	}
}
