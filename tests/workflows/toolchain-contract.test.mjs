import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const lockfile = JSON.parse(
	await readFile(new URL("package-lock.json", root), "utf8"),
);

test("declares the exact EmDash toolchain and its Node floor", () => {
	assert.equal(manifest.devDependencies.emdash, "1.2.0");
	assert.equal(manifest.devDependencies["@emdash-cms/blocks"], "1.2.0");
	assert.equal(manifest.devDependencies["@emdash-cms/plugin-cli"], "0.13.3");
	assert.equal(manifest.devDependencies["@emdash-cms/sandbox-workerd"], "0.9.3");
	assert.equal(manifest.engines.node, "^22.22.2 || ^24.15.0 || >=26.0.0");
	assert.equal(lockfile.packages[""].devDependencies.emdash, "1.2.0");
	assert.equal(lockfile.packages[""].engines.node, "^22.22.2 || ^24.15.0 || >=26.0.0");
	assert.equal(lockfile.packages["node_modules/astro"].engines.node, ">=22.12.0");
	assert.equal(lockfile.packages["node_modules/@emdash-cms/plugin-types"].version, "0.6.0");
	assert.equal(lockfile.packages["node_modules/@emdash-cms/admin"].version, "1.2.0");
	assert.equal(lockfile.packages["node_modules/@emdash-cms/auth"].version, "1.2.0");
	assert.equal(
		lockfile.packages["node_modules/@emdash-cms/registry-verification"].version,
		"0.3.4",
	);
	assert.equal(lockfile.packages["node_modules/@emdash-cms/registry-client"].version, "0.7.0");
	assert.equal(lockfile.packages["node_modules/@emdash-cms/registry-lexicons"].version, "0.7.0");
});

test("keeps lifecycle-bearing dependencies visible for maintainer review", () => {
	assert.equal(lockfile.packages["node_modules/esbuild"].hasInstallScript, true);
	assert.equal(lockfile.packages["node_modules/workerd"].hasInstallScript, true);
});
