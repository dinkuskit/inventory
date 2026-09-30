import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import {
	STORE_CONNECT_CLIENT_ID,
	canonicalizeSiteOrigin,
} from "../../src/features/store-connect/index.ts";
import { createAccountConnections } from "../../src/features/hosted-onboarding/index.ts";

const require = createRequire(import.meta.url);

test("store-connect public entry does not expose protocol internals", async () => {
	const entry = await import("../../src/features/store-connect/index.ts");
	assert.equal(typeof entry.canonicalizeSiteOrigin, "function");
	assert.equal(typeof entry.createPkcePair, "function");
	assert.equal(entry.STORE_CONNECT_CLIENT_ID, STORE_CONNECT_CLIENT_ID);
	assert.equal(Object.hasOwn(entry, "bytesToBase64Url"), false);
	assert.equal(canonicalizeSiteOrigin("https://shop.example.com"), "https://shop.example.com");
});

test("package root composes the store-connect public entry", async () => {
	const root = await import("../../src/index.ts");
	assert.equal(root.STORE_CONNECT_CLIENT_ID, STORE_CONNECT_CLIENT_ID);
	assert.equal(typeof root.createAccountConnections, "function");
	assert.equal(typeof createAccountConnections, "function");
});

test("plugin source uses host-attested user binding and public proof route", async () => {
	const source = await readFile(new URL("../../plugins/emdash-inventory/src/plugin.ts", import.meta.url), "utf8");
	assert.match(source, /permission:\s*"plugins:manage"/);
	assert.match(source, /requireBoundAdministrator/);
	assert.match(source, /"store-proof"/);
	assert.match(source, /public:\s*true/);
	assert.doesNotMatch(source, /oauth\/device_authorization/);
	assert.doesNotMatch(source, /device_code/);
	void require;
});
