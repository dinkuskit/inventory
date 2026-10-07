import { readFileSync } from "node:fs";

export function installedProofVersions() {
	const version = name => JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve(name)), "utf8")).version;
	const emdash = version("emdash");
	const sandbox = version("@emdash-cms/sandbox-workerd");
	for (const [selector, actual] of [["EMDASH_PROOF_EMDASH_VERSION", emdash], ["EMDASH_PROOF_SANDBOX_VERSION", sandbox]]) {
		if (process.env[selector] && process.env[selector] !== actual) throw new Error(`${selector} does not match the installed package version`);
	}
	return { emdash, sandbox };
}
