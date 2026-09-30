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
const expectedSha = "1cb55c756ef746bcb042b9679dc43b57e67bcb0d";

function extract(source, name) {
	const match = source.match(
		new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`, "u"),
	);
	if (!match) {
		throw new Error(`Commerce source is missing ${name}.`);
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
const port = extract(checkoutSource, "CheckoutInventoryPort");

if (!port.includes('reserve(request: StockRequest): Promise<"reserved" | "rejected" | "unknown">')) {
	throw new Error("Commerce CheckoutInventoryPort reserve shape changed.");
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
if (actualSha !== expectedSha) {
	throw new Error(
		`Commerce source SHA ${actualSha} is not the accepted ${expectedSha}.`,
	);
}

const work = await mkdtemp(join(tmpdir(), "dinkuskit-checkout-port-"));
const proof = join(work, "assignability.ts");
const tsconfig = join(work, "tsconfig.json");
await writeFile(
	proof,
	`import type {
	CheckoutInventoryPort as InventoryPort,
	StockRequest as InventoryStockRequest,
} from ${JSON.stringify(join(root, "src/features/checkout-inventory/index.ts"))};

${binding}
${requirement}
${request}
${port}

type Assert<T extends true> = T;
type _Port = Assert<InventoryPort extends CheckoutInventoryPort ? true : false>;
type _PortBack = Assert<CheckoutInventoryPort extends InventoryPort ? true : false>;
type _Request = Assert<InventoryStockRequest extends StockRequest ? true : false>;
type _RequestBack = Assert<StockRequest extends InventoryStockRequest ? true : false>;

export const proof: CheckoutInventoryPort = {
	reserve: async (_request: StockRequest) => "reserved",
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
				"CheckoutInventoryPort",
			],
		},
		null,
		2,
	) + "\n",
);
