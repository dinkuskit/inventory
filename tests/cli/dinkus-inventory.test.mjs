import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EXIT, runCli } from "../../src/cli/kernel.mjs";
import { spec } from "../../src/cli/spec.mjs";

const ROOT = new URL("../../", import.meta.url);
const TOKEN = ["test", "never", "printed"].join("-");
const ENDPOINT = "https://inventory.example.test";
const CONTEXT_FLAGS = ["--site", "site_demo", "--pool", "pool_demo", "--location", "location_north"];
const quantity = (value) => ({ value, unit: "each" });
const balance = { poolId: "pool_demo", locationId: "location_north", skuId: "sku_keychain", onHand: quantity("5"), reserved: quantity("1"), outgoingTransferCommitted: quantity("0"), available: quantity("4"), expected: quantity("0"), inTransit: quantity("0"), version: "8", hasStockHistory: true };

function json(status, body) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A routed fake of the hosted Inventory API. Handlers receive the URL, method,
// headers and raw body; every call is recorded.
function fakeService(routes = {}) {
	const calls = [];
	const defaults = {
		"GET /v1/status": () => json(200, { status: "ready", operation: { poolId: "pool_demo" } }),
		"GET /v1/locations": () => json(200, { poolId: "pool_demo", status: "active", locations: [{ locationId: "location_north", name: "North\tbay", status: "active" }] }),
		"GET /v1/skus": () => json(200, { skus: [{ inventorySkuId: "sku_keychain", sku: "KEY-1", displayName: "Keychain", unit: "each" }] }),
		"GET /v1/stock": () => json(200, { ok: true, balance: { outcome: "found", key: {}, balance } }),
		"POST /v1/stock/adjust/preview": () => json(200, {
			effect: { skuId: "sku_keychain", locationId: "location_north", balanceBefore: { ...balance }, balanceAfter: { ...balance, onHand: quantity("3"), available: quantity("2"), version: "9" } },
			warnings: [],
			confirmation: { value: "confirm_example", expiresAt: "2026-01-01T12:05:00Z" },
		}),
		"POST /v1/stock/adjust/confirm": (request) => json(200, { outcome: "committed", commandId: JSON.parse(request.body).command.commandId, receipt: { receiptId: "rcpt_demo" } }),
	};
	const fetchImpl = async (url, init) => {
		const parsed = new URL(url);
		const request = { url: parsed, method: init.method, headers: init.headers, body: init.body };
		calls.push(request);
		const handler = routes[`${init.method} ${parsed.pathname}`] ?? defaults[`${init.method} ${parsed.pathname}`];
		if (!handler) return json(404, { error: "not_found" });
		return handler(request);
	};
	return { calls, fetchImpl };
}

function sink() {
	let text = "";
	return { write(chunk) { text += chunk; }, get text() { return text; } };
}

async function run(argv, { service = fakeService(), env = {}, cwd, stdinIsTTY = false } = {}) {
	const stdout = sink();
	const stderr = sink();
	const stateHome = mkdtempSync(join(tmpdir(), "dinkus-inventory-state-"));
	const code = await runCli(spec, {
		argv,
		env: { HOME: stateHome, XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: join(stateHome, "config"), DINKUS_INVENTORY_TOKEN: TOKEN, DINKUS_INVENTORY_ENDPOINT: ENDPOINT, ...env },
		cwd: cwd ?? stateHome,
		stdout,
		stderr,
		stdinIsTTY,
		fetchImpl: service.fetchImpl,
	});
	assert.ok(!stdout.text.includes(TOKEN) && !stderr.text.includes(TOKEN), "the credential must never be printed");
	return { code, stdout: stdout.text, stderr: stderr.text, calls: service.calls, stateHome };
}

function oneJsonDocument(text) {
	const lines = text.trim().split("\n");
	assert.equal(lines.length, 1, "--json emits exactly one document");
	return JSON.parse(lines[0]);
}

test("help works at every depth and ignores other arguments", async () => {
	for (const argv of [["--help"], ["stock", "--help"], ["stock", "adjust", "--help", "--not-a-flag"], ["help", "commands", "resolve"], ["transfers", "start", "-h"]]) {
		const result = await run(argv);
		assert.equal(result.code, EXIT.ok, argv.join(" "));
		assert.match(result.stdout, /Usage:\n {2}dinkus-inventory/);
		assert.equal(result.calls.length, 0);
	}
});

test("--version prints only the package version, also from the executable", async () => {
	const { version } = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
	assert.equal((await run(["--version"])).stdout, `${version}\n`);
	const output = execFileSync(process.execPath, [new URL("bin/dinkus-inventory.mjs", ROOT).pathname, "--version"], { encoding: "utf8" });
	assert.equal(output, `${version}\n`);
});

test("status sends the bearer credential and site header and emits one JSON document", async () => {
	const result = await run(["--site", "site_demo", "status", "--json"]);
	assert.equal(result.code, EXIT.ok);
	const document = oneJsonDocument(result.stdout);
	assert.equal(document.schema, "dinkuskit.inventory.cli/v1");
	assert.equal(document.command, "status");
	assert.equal(document.outcome, "ok");
	assert.deepEqual(document.context, { siteId: "site_demo", poolId: "pool_demo" });
	assert.equal(result.calls[0].headers.authorization, `Bearer ${TOKEN}`);
	assert.equal(result.calls[0].headers["x-inventory-site"], "site_demo");
	assert.equal(result.stderr, "");
});

test("configuration and credential failures map to usage and gate exit codes", async () => {
	assert.equal((await run(["--site", "site_demo", "status"], { env: { DINKUS_INVENTORY_TOKEN: "" } })).code, EXIT.blocked);
	assert.equal((await run(["--site", "site_demo", "status"], { env: { DINKUS_INVENTORY_ENDPOINT: "" } })).code, EXIT.usage);
	const credentialedEndpoint = new URL("https://inventory.example.test");
	credentialedEndpoint.username = "user";
	credentialedEndpoint.password = "pass";
	assert.equal((await run(["--site", "site_demo", "--endpoint", credentialedEndpoint.href, "status"])).code, EXIT.usage);
	assert.equal((await run(["--site", "site_demo", "--endpoint", "http://inventory.example.test", "status"])).code, EXIT.usage);
	assert.equal((await run(["status"])).code, EXIT.usage, "a site is always required");
	assert.equal((await run(["--json", "--plain", "status"])).code, EXIT.usage);
	assert.equal((await run(["stock", "frobnicate"])).code, EXIT.usage);
});

test("config files are non-secret and profiles select read context", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "dinkus-inventory-project-"));
	mkdirSync(join(cwd, ".dinkuskit"));
	writeFileSync(join(cwd, ".dinkuskit", "inventory.json"), JSON.stringify({ profiles: { demo: { site: "site_demo", location: "location_north" } } }));
	const result = await run(["--profile", "demo", "stock", "show", "sku_keychain", "--json"], { cwd });
	assert.equal(result.code, EXIT.ok);
	assert.equal(oneJsonDocument(result.stdout).context.locationId, "location_north");
	assert.equal(result.calls.at(-1).url.searchParams.get("location_id"), "location_north");

	writeFileSync(join(cwd, ".dinkuskit", "inventory.json"), JSON.stringify({ site: "site_demo", token: "nope" }));
	const secret = await run(["status"], { cwd });
	assert.equal(secret.code, EXIT.usage);
	assert.match(secret.stderr, /non-secret/);
});

test("the token is never sent to an endpoint from project config", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "dinkus-inventory-project-"));
	mkdirSync(join(cwd, ".dinkuskit"));
	const projectConfigs = [
		[{ site: "site_demo", endpoint: "https://config.example.invalid" }, ["status", "--json"]],
		[{ site: "site_demo", profiles: { demo: { endpoint: "https://config.example.invalid" } } }, ["--profile", "demo", "status", "--json"]],
	];
	for (const [config, argv] of projectConfigs) {
		writeFileSync(join(cwd, ".dinkuskit", "inventory.json"), JSON.stringify(config));
		const refused = await run(argv, { cwd, env: { DINKUS_INVENTORY_ENDPOINT: "" } });
		assert.equal(refused.code, EXIT.blocked, argv.join(" "));
		assert.equal(refused.calls.length, 0, "nothing is sent to the project-config host");
		assert.equal(oneJsonDocument(refused.stdout).error.code, "untrusted_endpoint");
	}

	const fromEnv = await run(["status", "--json"], { cwd });
	assert.equal(fromEnv.code, EXIT.ok, fromEnv.stderr);
	assert.equal(fromEnv.calls[0].url.origin, ENDPOINT);

	const fromFlag = await run(["--endpoint", ENDPOINT, "status", "--json"], { cwd, env: { DINKUS_INVENTORY_ENDPOINT: "" } });
	assert.equal(fromFlag.code, EXIT.ok, fromFlag.stderr);

	const userConfig = mkdtempSync(join(tmpdir(), "dinkus-inventory-xdg-"));
	mkdirSync(join(userConfig, "dinkuskit", "inventory"), { recursive: true });
	writeFileSync(join(userConfig, "dinkuskit", "inventory", "config.json"), JSON.stringify({ endpoint: ENDPOINT }));
	const fromUser = await run(["--site", "site_demo", "status", "--json"], { env: { DINKUS_INVENTORY_ENDPOINT: "", XDG_CONFIG_HOME: userConfig } });
	assert.equal(fromUser.code, EXIT.ok, fromUser.stderr);
	assert.equal(fromUser.calls.length, 1);
});

test("plain output is one escaped record per line", async () => {
	const result = await run(["--site", "site_demo", "locations", "list", "--plain"]);
	assert.equal(result.code, EXIT.ok);
	assert.equal(result.stdout, "schema=dinkuskit.inventory.cli/v1\tcommand=locations.list\toutcome=ok\tlocationId=location_north\tname=North\\tbay\tstatus=active\n");
});

test("service failures map to unavailable and contract exit codes", async () => {
	const down = fakeService({ "GET /v1/status": () => json(503, { error: "service_unavailable" }) });
	assert.equal((await run(["--site", "site_demo", "skus", "list"], { service: down })).code, EXIT.unavailable);
	const garbled = fakeService({ "GET /v1/skus": () => new Response("<html>", { status: 200 }) });
	assert.equal((await run(["--site", "site_demo", "skus", "list"], { service: garbled })).code, EXIT.contract);
	const unreachable = { calls: [], fetchImpl: async () => { throw new TypeError("fetch failed"); } };
	assert.equal((await run(["--site", "site_demo", "skus", "list"], { service: unreachable })).code, EXIT.unavailable);
	const denied = fakeService({ "GET /v1/status": () => json(401, { error: "unauthorized" }) });
	assert.equal((await run(["--site", "site_demo", "skus", "list"], { service: denied })).code, EXIT.blocked);
});

test("planned commands stay discoverable but fail without calling the service", async () => {
	const result = await run(["transfers", "list", "--json"]);
	assert.equal(result.code, EXIT.failure);
	assert.equal(oneJsonDocument(result.stdout).error.code, "not_implemented");
	assert.equal(result.calls.length, 0);
});

const adjust = ["stock", "adjust", "sku_keychain", "--delta", "-2", "--unit", "each", "--note", "Damaged in storage"];

test("mutations require explicit context flags and never use profile or environment context", async () => {
	const result = await run([...adjust, "--dry-run"], { env: { DINKUS_INVENTORY_SITE: "site_demo", DINKUS_INVENTORY_POOL: "pool_demo", DINKUS_INVENTORY_LOCATION: "location_north" } });
	assert.equal(result.code, EXIT.usage);
	assert.match(result.stderr, /--site, --pool, --location/);
	assert.equal(result.calls.length, 0);
});

test("a mutation fails closed when --pool is not the pool bound to the site", async () => {
	const result = await run(["--site", "site_demo", "--pool", "pool_other", "--location", "location_north", ...adjust, "--dry-run"]);
	assert.equal(result.code, EXIT.blocked);
	assert.ok(result.calls.every((call) => call.method === "GET"));
});

test("--dry-run previews and prints the confirmation value without committing", async () => {
	const result = await run([...CONTEXT_FLAGS, ...adjust, "--dry-run", "--json"]);
	assert.equal(result.code, EXIT.ok);
	const document = oneJsonDocument(result.stdout);
	assert.equal(document.outcome, "preview");
	assert.deepEqual(document.confirmation, { value: "confirm_example", expiresAt: "2026-01-01T12:05:00Z" });
	assert.deepEqual(document.context, { siteId: "site_demo", poolId: "pool_demo", locationId: "location_north" });
	assert.equal(document.commandId, undefined);
	assert.ok(!result.calls.some((call) => call.url.pathname.endsWith("/confirm")));
	const preview = JSON.parse(result.calls.find((call) => call.url.pathname === "/v1/stock/adjust/preview").body);
	assert.deepEqual(preview.delta, { value: "-2", unit: "each" });
});

test("--no-input without --confirm and a declined prompt both send nothing", async () => {
	const noInput = await run([...CONTEXT_FLAGS, ...adjust, "--no-input"]);
	assert.equal(noInput.code, EXIT.blocked);
	assert.ok(!noInput.calls.some((call) => call.method === "POST"));
	const noTty = await run([...CONTEXT_FLAGS, ...adjust]);
	assert.equal(noTty.code, EXIT.blocked, "prompts require a TTY");
	assert.ok(!noTty.calls.some((call) => call.url.pathname.endsWith("/confirm")));
});

test("--confirm freezes the envelope before sending and closes it on a committed receipt", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "dinkus-inventory-state-"));
	const commands = join(stateHome, "dinkuskit", "inventory", "commands");
	let recordAtSend;
	const service = fakeService({
		"POST /v1/stock/adjust/confirm": (request) => {
			const body = JSON.parse(request.body);
			recordAtSend = JSON.parse(readFileSync(join(commands, `${body.command.commandId}.json`), "utf8"));
			return json(200, { outcome: "committed", commandId: body.command.commandId, receipt: { receiptId: "rcpt_demo" } });
		},
	});
	const result = await run([...CONTEXT_FLAGS, ...adjust, "--no-input", "--confirm", "confirm_example", "--json"], { service, env: { XDG_STATE_HOME: stateHome } });
	assert.equal(result.code, EXIT.ok);
	const document = oneJsonDocument(result.stdout);
	assert.equal(document.outcome, "committed");
	assert.equal(document.receipt.receiptId, "rcpt_demo");
	assert.match(document.commandId, /^cmd_[0-9a-f]{32}$/);
	assert.equal(recordAtSend.state, "pending", "the envelope is on disk before the send");
	const sent = JSON.parse(result.calls.find((call) => call.url.pathname === "/v1/stock/adjust/confirm").body);
	assert.equal(sent.confirmation, "confirm_example");
	assert.deepEqual(sent.command.expectedVersions, [{ skuId: "sku_keychain", locationId: "location_north", version: "8" }]);
	assert.deepEqual(sent.command.context, { siteId: "site_demo", poolId: "pool_demo", locationId: "location_north" });
	const closed = JSON.parse(readFileSync(join(commands, `${document.commandId}.json`), "utf8"));
	assert.equal(closed.state, "closed");
	assert.equal(closed.terminal.receiptId, "rcpt_demo");
	assert.ok(!JSON.stringify(closed).includes(TOKEN));
});

test("a stored business rejection exits 1 and a confirmation-gate refusal exits 4", async () => {
	const rejected = fakeService({ "POST /v1/stock/adjust/confirm": (request) => json(409, { outcome: "rejected", commandId: JSON.parse(request.body).command.commandId, code: "stale_version", message: "Balance changed." }) });
	const rejection = await run([...CONTEXT_FLAGS, ...adjust, "--no-input", "--confirm", "confirm_example", "--json"], { service: rejected });
	assert.equal(rejection.code, EXIT.failure);
	assert.deepEqual(oneJsonDocument(rejection.stdout).rejection, { code: "stale_version", message: "Balance changed." });

	const expired = fakeService({ "POST /v1/stock/adjust/confirm": () => json(409, { error: "confirmation_expired" }) });
	const gate = await run([...CONTEXT_FLAGS, ...adjust, "--no-input", "--confirm", "confirm_example", "--json"], { service: expired });
	assert.equal(gate.code, EXIT.blocked);
	assert.equal(oneJsonDocument(gate.stdout).error.code, "confirmation_expired");
});

test("a lost response reports an unknown outcome and resolve replays the exact envelope", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "dinkus-inventory-state-"));
	const lost = fakeService({ "POST /v1/stock/adjust/confirm": () => { throw new TypeError("socket hang up"); } });
	const first = await run([...CONTEXT_FLAGS, ...adjust, "--no-input", "--confirm", "confirm_example", "--json"], { service: lost, env: { XDG_STATE_HOME: stateHome } });
	assert.equal(first.code, EXIT.unavailable);
	const document = oneJsonDocument(first.stdout);
	assert.equal(document.outcome, "unknown");
	assert.match(first.stderr, /commands resolve cmd_/);
	const sentFirst = first.calls.find((call) => call.url.pathname === "/v1/stock/adjust/confirm").body;

	const shown = await run(["commands", "show", document.commandId, "--json"], { env: { XDG_STATE_HOME: stateHome } });
	assert.equal(oneJsonDocument(shown.stdout).data.state, "pending");

	const recovered = fakeService();
	const second = await run(["commands", "resolve", document.commandId, "--json"], { service: recovered, env: { XDG_STATE_HOME: stateHome } });
	assert.equal(second.code, EXIT.ok);
	assert.equal(oneJsonDocument(second.stdout).outcome, "committed");
	assert.equal(recovered.calls.length, 1, "resolve sends only the frozen envelope");
	assert.equal(recovered.calls[0].body, sentFirst, "replay is byte-identical, same command ID");

	const again = await run(["commands", "resolve", document.commandId, "--json"], { service: fakeService(), env: { XDG_STATE_HOME: stateHome } });
	assert.equal(again.code, EXIT.ok);
	assert.equal(again.calls.length, 0, "a closed command is never resent");
});

// Leaves one adjustment pending (lost response) and returns its command ID.
async function pendingAdjustment(stateHome) {
	const lost = fakeService({ "POST /v1/stock/adjust/confirm": () => { throw new TypeError("socket hang up"); } });
	const first = await run([...CONTEXT_FLAGS, ...adjust, "--no-input", "--confirm", "confirm_example", "--json"], { service: lost, env: { XDG_STATE_HOME: stateHome } });
	assert.equal(first.code, EXIT.unavailable);
	return oneJsonDocument(first.stdout).commandId;
}

async function localState(stateHome, commandId) {
	const shown = await run(["commands", "show", commandId, "--json"], { env: { XDG_STATE_HOME: stateHome } });
	return oneJsonDocument(shown.stdout).data.state;
}

test("a result that does not name the frozen command, or has the wrong status, keeps it pending", async () => {
	const answers = [
		() => json(200, { outcome: "committed", commandId: "cmd_someone_else", receipt: { receiptId: "rcpt_other" } }),
		() => json(409, { outcome: "rejected", commandId: "cmd_someone_else", code: "stale_version" }),
		(request) => json(201, { outcome: "committed", commandId: JSON.parse(request.body).command.commandId, receipt: { receiptId: "rcpt_demo" } }),
		(request) => json(200, { outcome: "rejected", commandId: JSON.parse(request.body).command.commandId, code: "stale_version" }),
		(request) => json(200, { outcome: "committed", commandId: JSON.parse(request.body).command.commandId }),
	];
	for (const answer of answers) {
		const stateHome = mkdtempSync(join(tmpdir(), "dinkus-inventory-state-"));
		const result = await run([...CONTEXT_FLAGS, ...adjust, "--no-input", "--confirm", "confirm_example", "--json"], {
			service: fakeService({ "POST /v1/stock/adjust/confirm": answer }),
			env: { XDG_STATE_HOME: stateHome },
		});
		assert.equal(result.code, EXIT.contract);
		const document = oneJsonDocument(result.stdout);
		assert.equal(document.outcome, "unknown");
		assert.equal(document.unknown.reason, "unmatched_result");
		assert.equal(await localState(stateHome, document.commandId), "pending");
	}
});

test("a refused retry keeps the command pending unless the refusal proves nothing committed", async () => {
	for (const [status, error] of [[401, "unauthorized"], [403, "unauthorized_context"], [409, "confirmation_mismatch"], [409, "confirmation_not_found"], [400, "invalid_request"]]) {
		const stateHome = mkdtempSync(join(tmpdir(), "dinkus-inventory-state-"));
		const commandId = await pendingAdjustment(stateHome);
		const retry = await run(["commands", "resolve", commandId, "--json"], {
			service: fakeService({ "POST /v1/stock/adjust/confirm": () => json(status, { error }) }),
			env: { XDG_STATE_HOME: stateHome },
		});
		assert.equal(retry.code, status === 400 ? EXIT.failure : EXIT.blocked, error);
		const document = oneJsonDocument(retry.stdout);
		assert.equal(document.outcome, "unknown", error);
		assert.equal(document.error.code, error);
		assert.equal(await localState(stateHome, commandId), "pending", `${error} must not close the record`);

		const recovered = await run(["commands", "resolve", commandId, "--json"], { service: fakeService(), env: { XDG_STATE_HOME: stateHome } });
		assert.equal(recovered.code, EXIT.ok, error);
		assert.equal(oneJsonDocument(recovered.stdout).outcome, "committed");
	}

	for (const error of ["confirmation_expired", "confirmation_already_used"]) {
		const stateHome = mkdtempSync(join(tmpdir(), "dinkus-inventory-state-"));
		const commandId = await pendingAdjustment(stateHome);
		const retry = await run(["commands", "resolve", commandId, "--json"], {
			service: fakeService({ "POST /v1/stock/adjust/confirm": () => json(409, { error }) }),
			env: { XDG_STATE_HOME: stateHome },
		});
		assert.equal(retry.code, EXIT.blocked, error);
		assert.equal(oneJsonDocument(retry.stdout).outcome, "blocked");
		assert.equal(await localState(stateHome, commandId), "closed", `${error} settles the command`);
	}
});

test("a refused first send closes the record because nothing was committed", async () => {
	const stateHome = mkdtempSync(join(tmpdir(), "dinkus-inventory-state-"));
	const result = await run([...CONTEXT_FLAGS, ...adjust, "--no-input", "--confirm", "confirm_example", "--json"], {
		service: fakeService({ "POST /v1/stock/adjust/confirm": () => json(401, { error: "unauthorized" }) }),
		env: { XDG_STATE_HOME: stateHome },
	});
	assert.equal(result.code, EXIT.blocked);
	const document = oneJsonDocument(result.stdout);
	assert.equal(document.error.code, "unauthorized");
	assert.equal(await localState(stateHome, document.commandId), "closed");
});

test("resolve without a local envelope refuses to fabricate a command", async () => {
	const result = await run(["commands", "resolve", "cmd_0123456789abcdef"]);
	assert.equal(result.code, EXIT.failure);
	assert.equal(result.calls.length, 0);
});

test("client-side validation rejects absolute counts and malformed quantities", async () => {
	for (const delta of ["0", "abc", "5x"]) {
		const result = await run([...CONTEXT_FLAGS, "stock", "adjust", "sku_keychain", "--delta", delta, "--unit", "each", "--note", "n", "--dry-run"]);
		assert.equal(result.code, EXIT.usage, delta);
	}
	const negative = await run([...CONTEXT_FLAGS, "stock", "set-initial", "sku_keychain", "--quantity", "-1", "--unit", "each", "--reason", "physical_count", "--note", "n", "--dry-run"]);
	assert.equal(negative.code, EXIT.usage);
});

test("CLI modules never import the database, storage, domain rules or feature internals", () => {
	for (const directory of ["src/cli", "src/client"]) {
		for (const file of readdirSync(new URL(directory, ROOT))) {
			const source = readFileSync(new URL(`${directory}/${file}`, ROOT), "utf8");
			for (const [, specifier] of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
				const allowed = specifier.startsWith("node:") || /^\.\/[\w-]+\.mjs$/.test(specifier) || /^\.\.\/(?:cli|client)\/[\w-]+\.mjs$/.test(specifier);
				assert.ok(allowed, `${directory}/${file} imports ${specifier}`);
			}
		}
	}
	assert.ok(existsSync(new URL("bin/dinkus-inventory.mjs", ROOT)));
});

test("service text cannot inject terminal control sequences", async () => {
	const hostile = fakeService({ "GET /v1/status": () => json(409, { error: "inventory_not_ready", message: "\u001b[2Jcleared" }) });
	const result = await run(["--site", "site_demo", "skus", "list"], { service: hostile });
	assert.equal(result.code, EXIT.failure);
	assert.ok(!result.stderr.includes("\u001b"));
	const named = fakeService({ "GET /v1/locations": () => json(200, { locations: [{ locationId: "location_north", name: "\u001b]0;title\u0007North", status: "active" }] }) });
	const listed = await run(["--site", "site_demo", "locations", "list"], { service: named });
	assert.ok(!listed.stdout.includes("\u001b") && listed.stdout.includes("\\u001b"));
});
