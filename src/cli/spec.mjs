// dinkus-inventory command tree. The contract is docs/CLI-SPEC.md; this file
// only binds that surface to the shared kernel and the command modules.
import { readFileSync } from "node:fs";
import {
	adjustStock,
	commandsResolve,
	commandsShow,
	locationsList,
	locationsShow,
	planned,
	receiptsList,
	setInitialStock,
	skusList,
	skusShow,
	status,
	stockList,
	stockShow,
} from "./commands.mjs";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const reference = { type: "string", multiple: true, value: "<type:id>", description: "Typed external reference." };
const dryRun = { type: "boolean", description: "Preview the exact effect and print a confirmation value; send nothing." };
const confirm = { type: "string", value: "<value>", description: "Commit only if this matches a fresh preview of the same action." };
const unit = { type: "string", value: "<unit>", required: true, description: "Quantity unit, such as each." };
const note = { type: "string", value: "<text>", required: true, description: "Public-safe human reason. No customer or payment data." };
const mutationContext = "--site <id> --pool <id> --location <id>";

const transferPlanned = planned("the Inventory service has no transfer preview/confirm or read endpoint yet.");

export const spec = {
	name: "dinkus-inventory",
	version,
	description: "Inspect and administer DinkusKit Inventory through its authenticated API.",
	schema: "dinkuskit.inventory.cli/v1",
	configName: "inventory",
	docs: "https://github.com/dinkuskit/inventory/blob/main/docs/CLI-SPEC.md",
	envMap: {
		endpoint: "DINKUS_INVENTORY_ENDPOINT",
		profile: "DINKUS_INVENTORY_PROFILE",
		site: "DINKUS_INVENTORY_SITE",
		pool: "DINKUS_INVENTORY_POOL",
		location: "DINKUS_INVENTORY_LOCATION",
	},
	globals: {
		endpoint: { type: "string", value: "<url>", description: "Inventory API endpoint. Never includes credentials." },
		site: { type: "string", value: "<id>", description: "Initiating site. Required as a flag for mutations." },
		pool: { type: "string", value: "<id>", description: "Canonical pool. Required as a flag for mutations." },
		location: { type: "string", value: "<id>", description: "Location for one-location commands. Required as a flag for mutations." },
	},
	environment: [
		["DINKUS_INVENTORY_TOKEN", "Bearer credential (inventory:admin). Never accepted as a flag or from config."],
		["DINKUS_INVENTORY_ENDPOINT", "Default endpoint. Also _PROFILE, _SITE, _POOL, _LOCATION for reads."],
		["XDG_CONFIG_HOME", "User config: $XDG_CONFIG_HOME/dinkuskit/inventory/config.json."],
		["XDG_STATE_HOME", "Pending-command store: $XDG_STATE_HOME/dinkuskit/inventory/commands/."],
	],
	examples: [
		"dinkus-inventory --profile demo status",
		"dinkus-inventory --profile demo --location location_north stock show sku_keychain --json",
		`dinkus-inventory ${mutationContext} stock adjust sku_keychain --delta -2 --unit each --note "Damaged in storage" --dry-run --json`,
	],
	tree: {
		commands: {
			status: {
				summary: "Show client version, service connection state and bound pool.",
				usage: "status",
				run: status,
			},
			locations: {
				summary: "Read locations.",
				commands: {
					list: { summary: "List active locations in the site's pool.", usage: "locations list", run: locationsList },
					show: { summary: "Show one location.", usage: "locations show <location-id>", args: [{ name: "location-id" }], run: locationsShow },
				},
			},
			skus: {
				summary: "Read Inventory SKU identity.",
				commands: {
					list: { summary: "List managed SKUs.", usage: "skus list", run: skusList },
					show: { summary: "Show one SKU by Inventory SKU ID or SKU code.", usage: "skus show <sku-id>", args: [{ name: "sku-id" }], run: skusShow },
				},
			},
			stock: {
				summary: "Read and change stock.",
				commands: {
					list: {
						summary: "Stock for every managed SKU, optionally at one --location.",
						usage: "stock list [--location <id>]",
						run: stockList,
					},
					show: {
						summary: "Stock for one SKU at one --location or across all locations.",
						usage: "stock show <sku-id> [--location <id>]",
						args: [{ name: "sku-id" }],
						examples: ["dinkus-inventory --site site_demo --location location_north stock show sku_keychain --json"],
						run: stockShow,
					},
					"set-initial": {
						summary: "Set an opening balance for a SKU-location with no stock history.",
						usage: `${mutationContext} stock set-initial <sku-id> --quantity <decimal> --unit <unit> --reason <code> --note <text> (--dry-run | --confirm <value>)`,
						args: [{ name: "sku-id" }],
						flags: {
							quantity: { type: "string", value: "<decimal>", required: true, description: "Opening on-hand quantity, non-negative." },
							unit,
							reason: { type: "string", value: "<code>", required: true, description: "Stable machine reason, such as physical_count." },
							note,
							reference,
							"dry-run": dryRun,
							confirm,
						},
						examples: [
							`dinkus-inventory ${mutationContext} stock set-initial sku_keychain --quantity 5 --unit each --reason physical_count --note "Set Initial Stock" --dry-run --json`,
							`dinkus-inventory ${mutationContext} stock set-initial sku_keychain --quantity 5 --unit each --reason physical_count --note "Set Initial Stock" --no-input --confirm <value> --json`,
						],
						run: setInitialStock,
					},
					adjust: {
						summary: "Adjust on-hand stock by a signed delta against the previewed version.",
						usage: `${mutationContext} stock adjust <sku-id> --delta <signed-decimal> --unit <unit> --note <text> (--dry-run | --confirm <value>)`,
						args: [{ name: "sku-id" }],
						flags: {
							delta: { type: "string", value: "<signed-decimal>", required: true, description: "Non-zero change such as -2 or +3. Never an absolute count." },
							unit,
							note,
							reference,
							"dry-run": dryRun,
							confirm,
						},
						examples: [`dinkus-inventory ${mutationContext} stock adjust sku_keychain --delta -2 --unit each --note "Damaged in storage" --dry-run`],
						run: adjustStock,
					},
					receive: {
						summary: "Record received quantities at a location (planned).",
						usage: `${mutationContext} stock receive --item <sku-id>=<decimal>:<unit>`,
						flags: { item: { type: "string", multiple: true, value: "<sku-id>=<decimal>:<unit>", description: "Received item." }, reference, "dry-run": dryRun, confirm },
						run: planned("the Inventory service has no receiving endpoint yet."),
					},
				},
			},
			transfers: {
				summary: "Staged transfers between locations.",
				commands: {
					list: { summary: "List transfers (planned).", usage: "transfers list", run: transferPlanned },
					show: { summary: "Show one transfer (planned).", usage: "transfers show <transfer-id>", args: [{ name: "transfer-id" }], run: transferPlanned },
					create: { summary: "Save a Created transfer draft (planned).", usage: "transfers create", run: transferPlanned },
					update: { summary: "Replace a Created transfer's editable fields (planned).", usage: "transfers update <transfer-id>", args: [{ name: "transfer-id" }], run: transferPlanned },
					cancel: { summary: "Cancel a Created transfer (planned).", usage: "transfers cancel <transfer-id>", args: [{ name: "transfer-id" }], run: transferPlanned },
					start: { summary: "Dispatch a Created transfer (planned).", usage: "transfers start <transfer-id>", args: [{ name: "transfer-id" }], run: transferPlanned },
					reopen: { summary: "Move an In transit transfer back to Created (planned).", usage: "transfers reopen <transfer-id>", args: [{ name: "transfer-id" }], run: transferPlanned },
					receive: { summary: "Receive every line of an In transit transfer (planned).", usage: "transfers receive <transfer-id>", args: [{ name: "transfer-id" }], run: transferPlanned },
				},
			},
			receipts: {
				summary: "Read the canonical receipt ledger.",
				commands: {
					list: { summary: "Latest receipts at one --location or across the pool.", usage: "receipts list [--location <id>]", run: receiptsList },
					show: { summary: "Show one receipt (planned).", usage: "receipts show <receipt-id>", args: [{ name: "receipt-id" }], run: planned("the Inventory service has no receipt lookup endpoint yet.") },
				},
			},
			commands: {
				summary: "Inspect and recover commands with unknown outcomes.",
				commands: {
					show: { summary: "Show the local record of a command.", usage: "commands show <command-id>", args: [{ name: "command-id" }], run: commandsShow },
					resolve: {
						summary: "Replay the exact frozen envelope under the same command ID.",
						usage: "commands resolve <command-id>",
						args: [{ name: "command-id" }],
						run: commandsResolve,
					},
				},
			},
		},
	},
};
