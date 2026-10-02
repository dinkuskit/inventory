#!/usr/bin/env node
// Build the clean-install fixture and apply emdash migrate --from-config to the
// same absolute SQLite URL the Astro build bakes. Does not open, dump, or
// delete preserved databases.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveEmdashDatabasePath } from "./emdash-database-path.mjs";

export function stampPreserved(path) {
	if (!existsSync(path)) return { path, exists: false };
	const st = statSync(path);
	return { path, exists: true, size: st.size, mtimeMs: st.mtimeMs };
}

function bundleContains(dir, needle) {
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const name of readdirSync(current)) {
			const path = resolve(current, name);
			const st = statSync(path);
			if (st.isDirectory()) stack.push(path);
			else if (name.endsWith(".mjs") && readFileSync(path).includes(needle)) return path;
		}
	}
	return null;
}

function parseReport(stdout) {
	const lines = stdout.trim().split("\n").filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			return JSON.parse(lines[index]);
		} catch {
			// keep scanning
		}
	}
	throw new Error("emdash migrate did not print a JSON report");
}

export function bootstrapCleanInstall({ repoRoot, siteDir, runDir, databasePath, storageDir, logDir = resolve(runDir, "helper-repair") }) {
	const databaseUrl = `file:${databasePath}`;
	const node = existsSync(resolve(runDir, ".bin/node")) ? resolve(runDir, ".bin/node") : process.execPath;
	const astroBin = resolve(siteDir, "node_modules/astro/bin/astro.mjs");
	const emdashCli = resolve(siteDir, "node_modules/emdash/dist/cli/index.mjs");
	mkdirSync(resolve(databasePath, ".."), { recursive: true });
	mkdirSync(storageDir, { recursive: true });
	const preserved = [
		resolve(repoRoot, "data.db"),
		resolve(repoRoot, "data.db-wal"),
		resolve(repoRoot, "data.db-shm"),
		resolve(runDir, "clean-site/data.db"),
		resolve(runDir, "clean-site/data.db-wal"),
		resolve(runDir, "clean-site/data.db-shm"),
		resolve(runDir, "clean-site/emdash.db"),
		resolve(runDir, "clean-site/grok-proof-state/data.db"),
		resolve(runDir, "bootstrap-repair/host-state/data.db"),
		resolve(runDir, "bootstrap-repair/host-state/data.db-wal"),
		resolve(runDir, "bootstrap-repair/host-state/data.db-shm"),
	];
	const before = preserved.map(stampPreserved);

	function run(label, args) {
		const result = spawnSync(node, args, {
			cwd: siteDir,
			env: {
				...process.env,
				EMDASH_DATABASE_URL: databaseUrl,
				EMDASH_STORAGE_DIR: storageDir,
				EMDASH_DATABASE_PATH: databasePath,
			},
			encoding: "utf8",
			timeout: 180000,
			killSignal: "SIGTERM",
		});
		writeFileSync(
			resolve(logDir, `${label}.log`),
			[
				`$ exit=${result.status} signal=${result.signal ?? "null"}`,
				`database_url=${databaseUrl}`,
				"--- stdout ---",
				result.stdout || "",
				"--- stderr ---",
				result.stderr || "",
				"",
			].join("\n"),
		);
		return result;
	}

	if (!existsSync(astroBin)) throw new Error(`Astro CLI missing at ${astroBin}`);
	if (!existsSync(emdashCli)) throw new Error(`EmDash CLI missing at ${emdashCli}`);
	const build = run("astro-build", [astroBin, "build"]);
	if (build.status !== 0) throw new Error(`astro build exited ${build.status}`);
	const configured = resolveEmdashDatabasePath(siteDir, { EMDASH_DATABASE_PATH: databasePath });
	if (configured.configuredUrl !== databaseUrl || configured.path !== databasePath) {
		throw new Error(`Built manifest URL ${configured.configuredUrl} does not match ${databaseUrl}`);
	}
	const serverDir = resolve(siteDir, "dist/server");
	if (!bundleContains(serverDir, databaseUrl)) throw new Error("Built server bundle does not contain the fresh database URL");
	if (!bundleContains(serverDir, storageDir)) throw new Error("Built server bundle does not contain the fresh storage directory");

	const status = run("migrate-status", [emdashCli, "migrate", "--from-config", "--config", "astro.config.mjs", "--status", "--json"]);
	if (status.status !== 0) throw new Error(`emdash migrate --status exited ${status.status}`);
	const statusReport = parseReport(status.stdout);
	const fingerprint = statusReport?.target?.fingerprint;
	if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
		throw new Error("emdash migrate --status did not return a target fingerprint");
	}
	if (statusReport.target.label !== databasePath) {
		throw new Error(`Migration status target ${statusReport.target.label} is not ${databasePath}`);
	}
	const pendingBefore = Array.isArray(statusReport.pending) ? statusReport.pending.length : null;

	const apply = run("migrate-apply", [
		emdashCli,
		"migrate",
		"--from-config",
		"--config",
		"astro.config.mjs",
		"--expected-target-fingerprint",
		fingerprint,
		"--json",
	]);
	if (apply.status !== 0) throw new Error(`emdash migrate apply exited ${apply.status}`);
	const applyReport = parseReport(apply.stdout);
	if (applyReport.target?.fingerprint !== fingerprint || applyReport.target?.label !== databasePath) {
		throw new Error("Migration apply target does not match the status target");
	}
	const pendingAfter = Array.isArray(applyReport.pending) ? applyReport.pending.length : null;
	const appliedCount = Array.isArray(applyReport.knownApplied) ? applyReport.knownApplied.length : null;
	if (pendingAfter !== 0) throw new Error("Migrations still pending after apply");
	if (appliedCount !== 88) throw new Error(`Expected 88 applied migrations, got ${appliedCount}`);

	const after = preserved.map(stampPreserved);
	const drifted = after.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(before[index]));
	if (drifted.length > 0) throw new Error(`Preserved database files changed: ${drifted.map(entry => entry.path).join(", ")}`);

	return {
		databaseUrl,
		databasePath,
		fingerprint,
		pendingBefore,
		pendingAfter,
		appliedCount,
		exits: { build: build.status, status: status.status, apply: apply.status },
		preservedUnchanged: drifted.length === 0,
	};
}
