import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveEmdashDatabasePath } from "../../tools/emdash-database-path.mjs";
import { hashPrefixedToken } from "../../tools/emdash-clean-install-seed.mjs";
import { CLEAN_INSTALL_HOST_PORT, CLEAN_INSTALL_RESERVED_PEER_PORT } from "../../tools/emdash-clean-install-ports.mjs";

const root = resolve(import.meta.dirname, "../..");

test("helper modules parse", () => {
	for (const name of [
		"tools/emdash-clean-install-host.mjs",
		"tools/emdash-clean-install-seed.mjs",
		"tools/emdash-clean-install-login.mjs",
		"tools/emdash-clean-install-proof.mjs",
		"tools/emdash-clean-install-fixture.mjs",
		"tools/emdash-clean-install-bootstrap.mjs",
		"tools/emdash-database-path.mjs",
	]) {
		const result = spawnSync(process.execPath, ["--check", resolve(root, name)], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
});

test("connection session uses the authorized settings API", () => {
	const host = readFileSync(resolve(root, "tools/emdash-clean-install-host.mjs"), "utf8");
	const seed = readFileSync(resolve(root, "tools/emdash-clean-install-seed.mjs"), "utf8");
	assert.match(host, /\/_emdash\/api\/admin\/plugins\/\$\{PLUGIN_ID\}\/settings/);
	assert.match(host, /method: "PUT"/);
	assert.match(host, /connectionSession: JSON\.stringify\(session\)/);
	assert.doesNotMatch(host, /:setting:connectionSession/);
	assert.doesNotMatch(seed, /connectionSession/);
	assert.doesNotMatch(host, /state:selected-location/);
	assert.doesNotMatch(host, /state:selected-sku/);
});

test("plugin package stays private", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "plugins/emdash-inventory/package.json"), "utf8"));
	assert.equal(pkg.private, true);
});

test("prefixed token hash is unpadded sha256 base64url", () => {
	const token = "ec_pat_example";
	assert.equal(hashPrefixedToken(token), createHash("sha256").update(token).digest("base64url"));
	assert.notEqual(hashPrefixedToken(token), token);
});

test("database path helper reads the baked manifest and rejects a different override", () => {
	const dir = mkdtempSync(join(tmpdir(), "emdash-db-path-"));
	const database = join(dir, "fresh.db");
	const manifestDir = join(dir, ".emdash");
	mkdirSync(manifestDir);
	writeFileSync(join(manifestDir, "migrations.json"), JSON.stringify({
		database: { executorConfig: { url: `file:${database}` } },
	}));
	const resolved = resolveEmdashDatabasePath(dir);
	assert.equal(resolved.path, database);
	assert.throws(() => resolveEmdashDatabasePath(dir, { EMDASH_DATABASE_PATH: join(dir, "other.db") }));
});

test("controller ports stay distinct", () => {
	assert.notEqual(CLEAN_INSTALL_HOST_PORT, CLEAN_INSTALL_RESERVED_PEER_PORT);
	assert.equal(CLEAN_INSTALL_HOST_PORT, 47631);
});
