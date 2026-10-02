import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// Same path rule as emdash/internal/db/sqlite-migrations resolveDatabasePath:
// strip a file: prefix, then absolute paths stay absolute and relative paths
// resolve from the Astro project root. EmDash bakes this URL at build time.
export function resolveEmdashDatabasePath(projectRoot, env = process.env) {
	const manifestPath = resolve(projectRoot, ".emdash/migrations.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const configuredUrl = manifest?.database?.executorConfig?.url;
	if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
		throw new Error(`EmDash migration manifest ${manifestPath} is missing database.executorConfig.url`);
	}
	const filePath = configuredUrl.startsWith("file:") ? configuredUrl.slice(5) : configuredUrl;
	if (filePath.length === 0) throw new Error("EmDash migration database path is empty");
	const path = isAbsolute(filePath) ? resolve(filePath) : resolve(projectRoot, filePath);
	const override = env.EMDASH_DATABASE_PATH;
	if (typeof override === "string" && override.length > 0 && resolve(override) !== path) {
		throw new Error(`EMDASH_DATABASE_PATH ${resolve(override)} does not match built EmDash database ${path}`);
	}
	return { manifestPath, configuredUrl, path };
}
