import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const script = 'import { installedProofVersions } from "./tools/emdash-proof-versions.mjs"; console.log(JSON.stringify(installedProofVersions()));';
function probe(extra) {
	return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: root, encoding: "utf8",
		env: { ...process.env, EMDASH_PROOF_EMDASH_VERSION: "", EMDASH_PROOF_SANDBOX_VERSION: "", ...extra },
	});
}

test("proof version labels come from the installed toolchain", () => {
	const result = probe({});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		emdash: manifest.devDependencies.emdash,
		sandbox: manifest.devDependencies["@emdash-cms/sandbox-workerd"],
	});
});

test("a historical override cannot relabel current package proof", () => {
	for (const selector of ["EMDASH_PROOF_EMDASH_VERSION", "EMDASH_PROOF_SANDBOX_VERSION"]) {
		const result = probe({ [selector]: "0.0.0-uninstalled" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /does not match the installed package version/);
	}
});
