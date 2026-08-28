import { WorkerEntrypoint } from "cloudflare:workers";

import {
	normalizeReadSkuLocationBalanceInput,
	type ReadSkuLocationBalanceInput,
} from "../src/domain/inventory-read.ts";
import type { InventoryInspection } from "../src/cloudflare/worker.ts";

interface InventoryServiceBinding {
	inspectSkuLocation(input: ReadSkuLocationBalanceInput): Promise<InventoryInspection>;
}

interface ProbeEnv {
	INVENTORY_SERVICE: InventoryServiceBinding;
}

export default class CloudflareRemoteProbe extends WorkerEntrypoint<ProbeEnv> {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({ error: "method_not_allowed" }, { status: 405 });
		}
		try {
			const key = normalizeReadSkuLocationBalanceInput(await request.json());
			const inspection = await this.env.INVENTORY_SERVICE.inspectSkuLocation(key);
			return Response.json(inspection);
		} catch (error) {
			return Response.json(
				{
					error: "invalid_probe_request",
					message: error instanceof Error ? error.message : "Invalid request.",
				},
				{ status: 400 },
			);
		}
	}
}
