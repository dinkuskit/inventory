import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commerceRoot = resolve(
	process.env.DINKUSKIT_COMMERCE_CHECKOUT_ROOT ??
		join(root, "..", "commerce-checkout-experience"),
);
/**
 * Accepted Commerce revision whose CheckoutInventoryPort.reserve may return
 * `{ outcome: "reserved", ticketIds }`. Currently the dinkuskit/commerce#78
 * head; bump to the Commerce main merge commit that contains #78 before
 * this proof is treated as final.
 */
export const COMMERCE_PORT_SHA = "a979d510504a7634c293b06e6c75111926a8dad3";

function extract(source, name) {
	const match =
		source.match(new RegExp(`export interface ${name} \\{[^\\n]*\\}`, "u")) ??
		source.match(
			new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`, "u"),
		);
	if (!match) {
		throw new Error(`Commerce source is missing ${name}.`);
	}
	return match[0];
}

function extractType(source, name) {
	const match = source.match(
		new RegExp(`export type ${name} =[\\s\\S]*?;\\n`, "u"),
	);
	if (!match) {
		throw new Error(`Commerce source is missing type ${name}.`);
	}
	return match[0];
}

const checkoutSource = await readFile(
	join(commerceRoot, "src/features/checkout/types.ts"),
	"utf8",
);
const bindingSource = await readFile(
	join(commerceRoot, "src/features/inventory-provider/types.ts"),
	"utf8",
);

const binding = extract(bindingSource, "InventoryProviderBinding");
const requirement = extract(checkoutSource, "StockRequirement");
const request = extract(checkoutSource, "StockRequest");
const reserveResult = extractType(checkoutSource, "CheckoutReserveResult");
const port = extract(checkoutSource, "CheckoutInventoryPort");

if (!port.includes("reserve(request: StockRequest): Promise<CheckoutReserveResult>")) {
	throw new Error("Commerce CheckoutInventoryPort reserve shape changed.");
}
if (!/outcome: "reserved"/u.test(reserveResult) || !/ticketIds: readonly string\[\]/u.test(reserveResult)) {
	throw new Error("Commerce CheckoutReserveResult no longer carries ticket ids.");
}
if (!port.includes('release(request: StockRequest): Promise<"released" | "unknown">')) {
	throw new Error("Commerce CheckoutInventoryPort release shape changed.");
}
if (!request.includes("operationId: string")) {
	throw new Error("Commerce StockRequest.operationId changed.");
}
if (!request.includes("binding: InventoryProviderBinding")) {
	throw new Error("Commerce StockRequest.binding changed.");
}
if (!requirement.includes("skuId: string") || !requirement.includes("allowBackorders: boolean")) {
	throw new Error("Commerce StockRequirement shape changed.");
}

const sha = spawnSync("git", ["rev-parse", "HEAD"], {
	cwd: commerceRoot,
	encoding: "utf8",
});
if (sha.status !== 0) {
	throw new Error("Unable to read Commerce HEAD.");
}
const actualSha = sha.stdout.trim();
if (actualSha !== COMMERCE_PORT_SHA) {
	throw new Error(
		`Commerce source SHA ${actualSha} is not the accepted ${COMMERCE_PORT_SHA}.`,
	);
}

const work = await mkdtemp(join(tmpdir(), "dinkuskit-checkout-port-"));
const proof = join(work, "assignability.ts");
const tsconfig = join(work, "tsconfig.json");
await writeFile(
	proof,
	`import type {
	CheckoutInventoryPort as InventoryPort,
	CheckoutReservePortResult,
	StockRequest as InventoryStockRequest,
} from ${JSON.stringify(join(root, "src/features/checkout-inventory/index.ts"))};

${binding}
${requirement}
${request}
${reserveResult}
${port}

type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Request shape is identical in both directions.
type _Request = Assert<InventoryStockRequest extends StockRequest ? true : false>;
type _RequestBack = Assert<StockRequest extends InventoryStockRequest ? true : false>;

// Inventory's port is a drop-in Commerce port.
type _Port = Assert<InventoryPort extends CheckoutInventoryPort ? true : false>;

// Commerce's port, minus only the legacy ticketless "reserved" string it still
// accepts from older providers, is exactly Inventory's port.
interface CommerceTicketPort {
	reserve(request: StockRequest): Promise<Exclude<CheckoutReserveResult, "reserved">>;
	release: CheckoutInventoryPort["release"];
}
type _PortBack = Assert<CommerceTicketPort extends InventoryPort ? true : false>;
type _PortForward = Assert<InventoryPort extends CommerceTicketPort ? true : false>;
type _ResultExact = Assert<Same<Exclude<CheckoutReserveResult, "reserved">, CheckoutReservePortResult>>;
type _LegacyOnly = Assert<Same<Exclude<CheckoutReserveResult, CheckoutReservePortResult>, "reserved">>;
type _Release = Assert<Same<Awaited<ReturnType<CheckoutInventoryPort["release"]>>, Awaited<ReturnType<InventoryPort["release"]>>>>;

// Ticket-id fields Commerce consumes.
type Reserved = Extract<CheckoutReservePortResult, { outcome: "reserved" }>;
type CommerceReserved = Extract<CheckoutReserveResult, { outcome: "reserved" }>;
type _Tickets = Assert<Reserved["ticketIds"] extends readonly string[] ? true : false>;
type _TicketFields = Assert<Same<keyof Reserved, "outcome" | "ticketIds">>;
type _CommerceTicketFields = Assert<Same<keyof CommerceReserved, keyof Reserved>>;
type _ReservedBoth = Assert<Same<Reserved, CommerceReserved>>;

export const proof: CheckoutInventoryPort = {
	reserve: async (_request: StockRequest) => ({ outcome: "reserved", ticketIds: [] }),
	release: async (_request: StockRequest) => "released",
};
`,
);
await writeFile(
	tsconfig,
	JSON.stringify(
		{
			compilerOptions: {
				target: "ES2023",
				module: "ESNext",
				moduleResolution: "Bundler",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
				allowImportingTsExtensions: true,
			},
			files: [proof],
		},
		null,
		2,
	),
);

const typecheck = spawnSync(
	join(root, "node_modules/.bin/tsc"),
	["--project", tsconfig],
	{ encoding: "utf8" },
);
if (typecheck.status !== 0) {
	process.stderr.write(typecheck.stdout);
	process.stderr.write(typecheck.stderr);
	throw new Error("Commerce port assignability typecheck failed.");
}

process.stdout.write(
	JSON.stringify(
		{
			commerceSha: actualSha,
			typecheck: "passed",
			interfaces: [
				"InventoryProviderBinding",
				"StockRequirement",
				"StockRequest",
				"CheckoutReserveResult",
				"CheckoutInventoryPort",
			],
		},
		null,
		2,
	) + "\n",
);
