import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const lockfile = JSON.parse(
	await readFile(new URL("package-lock.json", root), "utf8"),
);

test("declares the exact EmDash toolchain and its Node floor", () => {
	assert.equal(manifest.devDependencies.emdash, "0.35.0");
	assert.equal(manifest.engines.node, ">=22.12.0");
	assert.equal(lockfile.packages[""].devDependencies.emdash, "0.35.0");
	assert.equal(lockfile.packages[""].engines.node, ">=22.12.0");
	assert.equal(lockfile.packages["node_modules/astro"].engines.node, ">=22.12.0");
});

test("keeps lifecycle-bearing dependencies visible for maintainer review", () => {
	assert.equal(lockfile.packages["node_modules/esbuild"].hasInstallScript, true);
	assert.equal(
		lockfile.packages["node_modules/better-sqlite3"].hasInstallScript,
		true,
	);
});
