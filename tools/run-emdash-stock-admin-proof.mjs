import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter, resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = resolve(root, "tools/emdash-stock-admin-host.mjs");

function nodeMajor(executable) {
	try {
		return Number(execFileSync(executable, ["-p", "process.versions.node"], { encoding: "utf8" }).trim().split(".")[0]);
	} catch {
		return 0;
	}
}

function discoverNode24() {
	const seen = new Set();
	const candidates = [];
	if (process.env.NODE24) candidates.push(process.env.NODE24);
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		candidates.push(resolve(dir, "node"));
		candidates.push(resolve(dir, "node24"));
	}
	candidates.push(process.execPath);
	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate) || !existsSync(candidate)) continue;
		seen.add(candidate);
		if (nodeMajor(candidate) >= 24) return candidate;
	}
	return null;
}

const selected = discoverNode24();
if (!selected) {
	console.error("Node 24+ is required for the standalone proof host (registerHooks). Set NODE24 to a Node 24 executable or put Node 24 on PATH. No executable was found.");
	process.exit(2);
}
console.log(`Using Node ${nodeMajor(selected)} for the EmDash stock admin proof host.`);
const child = spawn(selected, [host, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", code => process.exit(code ?? 1));
