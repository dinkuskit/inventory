// One installed request with an observational host variant, restored in finally.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const runDir = resolve(root, "runs/emdash-install-proof-runs/20260930");
const outputDir = resolve(runDir, "execution-recovery/diagnostic");
const target = resolve(runDir, "helper-repair/site/node_modules/emdash/dist/context-BpTIzY5h.mjs");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const original = await readFile(target);
if (digest(original) !== "7f9906b7964f63d1bf6fffe358490fad931ed61a74bf7268190cb4c81414ae9e") {
	throw new Error("Pinned host module differs; refusing instrumentation");
}
const anchor = '\t\tconst message = error instanceof SsrfError ? error.message : "SSRF validation failed";';
const transportAnchor = '\t\t\tconst response = await fetchImpl(currentUrl, {';
const source = original.toString();
if (source.split(anchor).length !== 2 || source.split(transportAnchor).length !== 3) {
	throw new Error("Pinned host boundaries differ; refusing instrumentation");
}
const observerUrl = pathToFileURL(resolve(root, "tools/emdash-host-observer.mjs")).href;
const instrumented = `import { emitHostObservation } from ${JSON.stringify(observerUrl)};\n` + source
	.replace(anchor, '\t\temitHostObservation("target_validation", error);\n' + anchor)
	.replace(transportAnchor, '\t\t\temitHostObservation("transport");\n' + transportAnchor);
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, "host-module.original.mjs"), original, { flag: "wx" });
let exitCode;
try {
	await writeFile(target, instrumented);
	exitCode = await new Promise((resolveExit, reject) => {
		const child = spawn(process.execPath, ["tools/emdash-clean-install-proof.mjs"], {
			cwd: root, env: { ...process.env, EMDASH_PROOF_OUTPUT_DIR: outputDir }, stdio: "inherit"
		});
		child.once("error", reject);
		child.once("exit", code => resolveExit(code));
	});
} finally {
	await writeFile(target, original);
	const restored = await readFile(target);
	await writeFile(resolve(outputDir, "observer-receipt.json"), JSON.stringify({
		originalSha256: digest(original), variantSha256: digest(instrumented),
		restoredSha256: digest(restored), restored: digest(restored) === digest(original), exitCode,
		qualification: "observational_host_variant_original_plugin_package"
	}, null, 2));
	if (digest(restored) !== digest(original)) throw new Error("Host restoration verification failed");
}
process.exitCode = exitCode;
