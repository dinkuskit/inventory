// Command implementations for dinkus-inventory. Each one calls the hosted
// Inventory API through the shared client and shapes the result for the kernel.
import { randomBytes } from "node:crypto";
import { CliError, EXIT, createHttp, usageError } from "./kernel.mjs";
import { closeRecord, digest, loadRecord, saveRecord } from "./pending-store.mjs";
import { TOKEN_ENV, createInventoryClient, readyContext } from "../client/inventory-client.mjs";

const COMMAND_SCHEMA = "dinkuskit.inventory.command/v1";
const CONFIRMATION_GATE = new Set([
	"confirmation_expired",
	"confirmation_mismatch",
	"confirmation_already_used",
	"confirmation_not_found",
	"unauthorized_context",
]);

// ---------------------------------------------------------------------------
// Formatting helpers

const quantity = (value) => (value && typeof value === "object" ? `${value.value} ${value.unit}` : String(value ?? ""));

function table(headers, rows) {
	if (rows.length === 0) return "(none)";
	const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)));
	const line = (cells) => cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
	return [line(headers), ...rows.map(line)].join("\n");
}

function contextLine(context) {
	return Object.entries(context)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");
}

export function planned(what) {
	return async () => {
		throw new CliError("not_implemented", `Not available: ${what}`, { exit: EXIT.failure });
	};
}

// ---------------------------------------------------------------------------
// Reads

export async function status(ctx) {
	const client = createInventoryClient(ctx);
	const result = await client.status();
	const context = { siteId: client.connection.siteId, poolId: result.operation?.poolId };
	const clientVersion = ctx.spec.version;
	const human = [`client: ${ctx.spec.name} ${clientVersion}`, `status: ${result.status}`, ...(context.poolId ? [`pool: ${context.poolId}`] : [])].join("\n");
	return {
		context,
		data: { clientVersion, connection: result },
		human,
		plain: [[["clientVersion", clientVersion], ["status", result.status], ["poolId", context.poolId ?? ""]]],
	};
}

async function readContext(ctx) {
	const client = createInventoryClient(ctx);
	const context = await readyContext(client, { poolId: ctx.config.resolve("pool") });
	return { client, context };
}

const locationRow = (location) => [location.locationId, location.name, location.status];
const locationRecord = (location) => [["locationId", location.locationId], ["name", location.name], ["status", location.status]];

export async function locationsList(ctx) {
	const { client, context } = await readContext(ctx);
	const { locations = [] } = await client.locations();
	return {
		context,
		data: { locations },
		human: table(["LOCATION", "NAME", "STATUS"], locations.map(locationRow)),
		plain: locations.map(locationRecord),
	};
}

export async function locationsShow(ctx) {
	const { client, context } = await readContext(ctx);
	const { locations = [] } = await client.locations();
	const location = locations.find((entry) => entry.locationId === ctx.args["location-id"]);
	if (!location) throw new CliError("location_not_found", `No active location ${ctx.args["location-id"]} in pool ${context.poolId}.`);
	return { context: { ...context, locationId: location.locationId }, data: location, human: table(["LOCATION", "NAME", "STATUS"], [locationRow(location)]), plain: [locationRecord(location)] };
}

const skuRow = (sku) => [sku.inventorySkuId, sku.sku, sku.displayName, sku.unit];
const skuRecord = (sku) => [["inventorySkuId", sku.inventorySkuId], ["sku", sku.sku], ["displayName", sku.displayName], ["unit", sku.unit]];

export async function skusList(ctx) {
	const { client, context } = await readContext(ctx);
	const { skus = [] } = await client.skus();
	return { context, data: { skus }, human: table(["SKU ID", "SKU", "NAME", "UNIT"], skus.map(skuRow)), plain: skus.map(skuRecord) };
}

export async function skusShow(ctx) {
	const { client, context } = await readContext(ctx);
	const { skus = [] } = await client.skus();
	const id = ctx.args["sku-id"];
	const sku = skus.find((entry) => entry.inventorySkuId === id || entry.sku === id);
	if (!sku) throw new CliError("sku_not_registered", `SKU ${id} is not registered in pool ${context.poolId}.`);
	return { context, data: sku, human: table(["SKU ID", "SKU", "NAME", "UNIT"], [skuRow(sku)]), plain: [skuRecord(sku)] };
}

const STOCK_HEADERS = ["SKU ID", "LOCATION", "ON HAND", "RESERVED", "AVAILABLE", "EXPECTED", "IN TRANSIT", "VERSION"];

function stockRows(skuId, response) {
	if (response.balance) {
		const balance = response.balance.outcome === "found" ? response.balance.balance : undefined;
		if (!balance) return [];
		return [{ skuId, locationId: balance.locationId, onHand: balance.onHand, reserved: balance.reserved, available: balance.available, expected: balance.expected, inTransit: balance.inTransit, version: balance.version }];
	}
	const stock = response.stock;
	if (!stock || stock.outcome !== "found") return [];
	return stock.locations.map((location) => ({ skuId, locationId: location.locationId, ...location.stock }));
}

const stockTableRow = (row) => [row.skuId, row.locationId, quantity(row.onHand), quantity(row.reserved), quantity(row.available), quantity(row.expected), quantity(row.inTransit), row.version ?? ""];
const stockRecord = (row) => [
	["skuId", row.skuId],
	["locationId", row.locationId],
	["onHand", row.onHand?.value],
	["reserved", row.reserved?.value],
	["available", row.available?.value],
	["expected", row.expected?.value],
	["inTransit", row.inTransit?.value],
	["unit", row.onHand?.unit],
	["version", row.version ?? ""],
];

export async function stockShow(ctx) {
	const { client, context } = await readContext(ctx);
	const skuId = ctx.args["sku-id"];
	const locationId = ctx.config.resolve("location");
	const response = await client.stock(skuId, locationId);
	const rows = stockRows(skuId, response);
	if (rows.length === 0) throw new CliError("stock_not_found", `No stock record for ${skuId}${locationId ? ` at ${locationId}` : ""}.`);
	return { context: { ...context, locationId }, data: response.balance ?? response.stock, human: table(STOCK_HEADERS, rows.map(stockTableRow)), plain: rows.map(stockRecord) };
}

export async function stockList(ctx) {
	const { client, context } = await readContext(ctx);
	const locationId = ctx.config.resolve("location");
	const { skus = [] } = await client.skus();
	const rows = [];
	for (const sku of skus) rows.push(...stockRows(sku.inventorySkuId, await client.stock(sku.inventorySkuId, locationId)));
	return { context: { ...context, locationId }, data: { stock: rows }, human: table(STOCK_HEADERS, rows.map(stockTableRow)), plain: rows.map(stockRecord) };
}

export async function receiptsList(ctx) {
	const { client, context } = await readContext(ctx);
	const locationId = ctx.config.resolve("location");
	const history = await client.receipts(locationId);
	const receipts = history.receipts ?? [];
	return {
		context: { ...context, locationId },
		data: history,
		human: table(["RECEIPT", "TYPE", "COMMITTED", "COMMAND"], receipts.map((receipt) => [receipt.receiptId, receipt.type, receipt.committedAt, receipt.commandId])),
		plain: receipts.map((receipt) => [["receiptId", receipt.receiptId], ["type", receipt.type], ["committedAt", receipt.committedAt], ["commandId", receipt.commandId]]),
	};
}

// ---------------------------------------------------------------------------
// Mutations: preview, confirm, frozen envelope, awaited terminal result.

const DECIMAL = /^\d+(?:\.\d+)?$/;
const SIGNED_DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;

function references(ctx) {
	return (ctx.flags.reference ?? []).map((text) => {
		const separator = text.indexOf(":");
		if (separator < 1 || separator === text.length - 1) throw usageError(`--reference "${text}" must look like <type>:<id>.`);
		return { kind: text.slice(0, separator), id: text.slice(separator + 1) };
	});
}

function mutationContext(ctx) {
	const missing = ["site", "pool", "location"].filter((name) => ctx.flags[name] === undefined);
	if (missing.length) {
		throw usageError(`Mutations need ${missing.map((name) => `--${name}`).join(", ")} on the command line; profiles and environment are not used for mutation context.`, "missing_context");
	}
	if (ctx.flags["dry-run"] && ctx.flags.confirm !== undefined) throw usageError("--dry-run and --confirm cannot be combined.");
	return { poolId: ctx.flags.pool, locationId: ctx.flags.location };
}

const newCommandId = () => `cmd_${randomBytes(16).toString("hex")}`;

const OPENING = {
	name: "stock.set-initial",
	previewPath: "/v1/stock/opening/preview",
	confirmPath: "/v1/stock/opening/confirm",
	input(ctx, locationId) {
		const value = ctx.flags.quantity;
		if (!DECIMAL.test(value)) throw usageError(`--quantity "${value}" must be a non-negative decimal such as 5 or 2.5.`);
		return {
			locationId,
			skuId: ctx.args["sku-id"],
			quantity: { value, unit: ctx.flags.unit },
			reason: { code: ctx.flags.reason, note: ctx.flags.note },
			references: references(ctx),
		};
	},
	async currentVersion(client, input) {
		const eligibility = await client.openingEligibility(input.skuId, input.locationId);
		return eligibility.balance?.version ?? "0";
	},
	command: ({ commandId, context, input, version }) => ({
		schema: COMMAND_SCHEMA,
		commandId,
		type: "stock.opening_balance",
		context,
		payload: { skuId: input.skuId, quantity: input.quantity },
		reason: input.reason,
		references: input.references,
		expectedVersions: [{ skuId: input.skuId, locationId: input.locationId, version }],
	}),
};

const ADJUST = {
	name: "stock.adjust",
	previewPath: "/v1/stock/adjust/preview",
	confirmPath: "/v1/stock/adjust/confirm",
	input(ctx, locationId) {
		const delta = ctx.flags.delta;
		if (!SIGNED_DECIMAL.test(delta) || Number(delta) === 0) throw usageError(`--delta "${delta}" must be a non-zero signed decimal such as -2 or +3.`);
		return {
			locationId,
			skuId: ctx.args["sku-id"],
			delta: { value: delta.replace(/^\+/, ""), unit: ctx.flags.unit },
			reason: { note: ctx.flags.note },
			references: references(ctx),
		};
	},
	async currentVersion(client, input) {
		const response = await client.stock(input.skuId, input.locationId);
		const version = response.balance?.outcome === "found" ? response.balance.balance.version : undefined;
		if (!version) throw new CliError("opening_balance_required", `${input.skuId} has no balance at ${input.locationId}; set initial stock first.`);
		return version;
	},
	command: ({ commandId, context, input, version }) => ({
		schema: COMMAND_SCHEMA,
		commandId,
		type: "stock.adjust",
		context,
		payload: { skuId: input.skuId, delta: input.delta },
		reason: input.reason,
		references: input.references,
		expectedVersions: [{ skuId: input.skuId, locationId: input.locationId, version }],
	}),
};

function previewHuman(context, preview) {
	const effect = preview.effect ?? {};
	const before = effect.balanceBefore ?? {};
	const after = effect.balanceAfter ?? {};
	const lines = [
		`context: ${contextLine(context)}`,
		`sku: ${effect.skuId}`,
		`on hand: ${quantity(before.onHand)} -> ${quantity(after.onHand)}`,
		`available: ${quantity(before.available)} -> ${quantity(after.available)}`,
	];
	for (const warning of preview.warnings ?? []) lines.push(`warning: ${warning.message ?? warning.code}`);
	if (preview.warning) lines.push(`warning: ${preview.warning}`);
	lines.push(`confirmation: ${preview.confirmation?.value} (expires ${preview.confirmation?.expiresAt})`);
	return lines.join("\n");
}

// Interpret the confirm response. Only 2xx/409 bodies with a known shape are
// terminal; anything else after a send leaves the outcome unknown.
async function terminalResult(ctx, kind, record, response) {
	const { json } = response;
	const context = record.context;
	if (response.ok && json?.outcome === "committed" && json.receipt) {
		await closeRecord(ctx.env, record, { outcome: "committed", receiptId: json.receipt.receiptId });
		return { outcome: "committed", context, commandId: record.commandId, receipt: json.receipt, human: `committed ${kind} ${record.commandId}\nreceipt: ${json.receipt.receiptId}` };
	}
	if (response.status === 409 && json?.outcome === "rejected") {
		await closeRecord(ctx.env, record, { outcome: "rejected", code: json.code });
		return { outcome: "rejected", context, commandId: record.commandId, rejection: { code: json.code, message: json.message }, human: `rejected ${kind}: ${json.code}${json.message ? ` (${json.message})` : ""}`, exit: EXIT.failure };
	}
	if (json && typeof json.error === "string" && (response.status === 409 || response.status === 403) && CONFIRMATION_GATE.has(json.error)) {
		await closeRecord(ctx.env, record, { outcome: "blocked", code: json.error });
		throw new CliError(json.error, `Confirmation gate blocked ${kind} (${json.error}); nothing was committed. Preview again.`, { exit: EXIT.blocked, outcome: "blocked", details: { context, document: { commandId: record.commandId } } });
	}
	if (json && typeof json.error === "string" && [400, 401, 403].includes(response.status)) {
		await closeRecord(ctx.env, record, { outcome: "refused", code: json.error });
		throw new CliError(json.error, `The service refused ${kind} (${json.error}); nothing was committed.`, { exit: response.status === 400 ? EXIT.failure : EXIT.blocked, details: { context, document: { commandId: record.commandId } } });
	}
	return unknownResult(record, response.json === undefined ? "malformed_response" : `http_${response.status}`, response.json === undefined ? EXIT.contract : EXIT.unavailable);
}

function unknownResult(record, reason, exit = EXIT.unavailable) {
	return {
		outcome: "unknown",
		context: record.context,
		commandId: record.commandId,
		unknown: { reason, next: `dinkus-inventory commands resolve ${record.commandId}` },
		human: `outcome=unknown commandId=${record.commandId}`,
		notes: [`The outcome is unknown. The frozen command is kept locally; run: dinkus-inventory commands resolve ${record.commandId}`],
		exit,
	};
}

async function send(ctx, kind, record) {
	const request = createHttp({
		baseUrl: record.endpoint,
		headers: { authorization: `Bearer ${ctx.env[TOKEN_ENV]}`, "x-inventory-site": record.context.siteId },
		timeoutMs: ctx.timeoutMs,
		fetchImpl: ctx.fetchImpl,
		signal: ctx.signal,
	});
	ctx.lifecycle.sending = true;
	let response;
	try {
		response = await request("POST", record.path, { body: record.body });
	} catch (error) {
		if (error instanceof CliError && error.exit === EXIT.unavailable) return unknownResult(record, error.code);
		throw error;
	} finally {
		ctx.lifecycle.sending = false;
	}
	return terminalResult(ctx, kind, record, response);
}

async function mutate(ctx, kind) {
	const declared = mutationContext(ctx);
	const client = createInventoryClient(ctx);
	const base = await readyContext(client, { poolId: declared.poolId });
	const context = { ...base, locationId: declared.locationId };
	const input = kind.input(ctx, declared.locationId);

	if (ctx.flags["dry-run"]) {
		const preview = await client.preview(kind.previewPath, input, `Preview ${kind.name}`);
		const warnings = preview.warnings ?? (preview.warning ? [{ message: preview.warning }] : undefined);
		return { outcome: "preview", context, data: preview.effect, warnings, confirmation: preview.confirmation, human: previewHuman(context, preview) };
	}

	let confirmation;
	let version;
	if (ctx.flags.confirm !== undefined) {
		confirmation = ctx.flags.confirm;
		version = await kind.currentVersion(client, input);
	} else {
		if (ctx.flags["no-input"]) {
			throw new CliError("confirmation_required", "A real mutation with --no-input needs --confirm with the value from a fresh --dry-run.", { exit: EXIT.blocked });
		}
		const preview = await client.preview(kind.previewPath, input, `Preview ${kind.name}`);
		ctx.io.stderr.write(`${previewHuman(context, preview)}\n`);
		const answer = await ctx.prompt(`Type ${preview.confirmation.value} to commit, or anything else to cancel: `);
		if (answer !== preview.confirmation.value) {
			throw new CliError("not_confirmed", "Not confirmed; nothing was sent.", { exit: EXIT.blocked });
		}
		confirmation = preview.confirmation.value;
		version = preview.effect?.balanceBefore?.version;
	}

	const commandId = newCommandId();
	const body = JSON.stringify({ confirmation, command: kind.command({ commandId, context, input, version }) });
	const record = {
		schema: "dinkuskit.inventory.cli-pending/v1",
		state: "pending",
		commandId,
		command: kind.name,
		endpoint: client.connection.endpoint,
		path: kind.confirmPath,
		context,
		body,
		digest: digest(body),
		createdAt: new Date().toISOString(),
	};
	await saveRecord(ctx.env, record);
	return send(ctx, kind.name, record);
}

export const setInitialStock = (ctx) => mutate(ctx, OPENING);
export const adjustStock = (ctx) => mutate(ctx, ADJUST);

// ---------------------------------------------------------------------------
// Unknown-outcome recovery

function recordSummary(record) {
	return { commandId: record.commandId, command: record.command, state: record.state, createdAt: record.createdAt, digest: record.digest, terminal: record.terminal ?? null };
}

export async function commandsShow(ctx) {
	const record = await loadRecord(ctx.env, ctx.args["command-id"]);
	if (!record) {
		throw new CliError("command_not_found", `No local record of ${ctx.args["command-id"]}. Service-side command lookup is not available yet.`);
	}
	const summary = recordSummary(record);
	return { context: record.context, commandId: record.commandId, data: summary, human: Object.entries(summary).map(([key, value]) => `${key}: ${typeof value === "object" && value ? JSON.stringify(value) : value}`).join("\n") };
}

export async function commandsResolve(ctx) {
	const record = await loadRecord(ctx.env, ctx.args["command-id"]);
	if (!record) {
		throw new CliError("envelope_missing", `No frozen envelope for ${ctx.args["command-id"]} on this machine; replay is blocked and no new command is created.`);
	}
	if (record.state === "closed") {
		return { outcome: record.terminal?.outcome === "committed" ? "committed" : "ok", context: record.context, commandId: record.commandId, data: recordSummary(record), human: `${record.commandId} is already closed (${record.terminal?.outcome})` };
	}
	if (digest(record.body) !== record.digest) {
		throw new CliError("envelope_corrupt", `The frozen envelope for ${record.commandId} does not match its digest; refusing to replay.`, { exit: EXIT.contract });
	}
	if (!ctx.env[TOKEN_ENV]) throw new CliError("missing_credential", `Set ${TOKEN_ENV} to an Inventory access token for this site.`, { exit: EXIT.blocked });
	return send(ctx, record.command, record);
}
