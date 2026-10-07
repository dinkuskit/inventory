#!/usr/bin/env node
// Create the ignored helper-repair fixture from the durable tools recipe.
// Reuses the already installed clean-site host dependencies. Repacks the
// npm tarball only when a fresh bundle from the current plugin source differs.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { CLEAN_INSTALL_HOST_PORT, CLEAN_INSTALL_RESERVED_PEER_PORT } from "./emdash-clean-install-ports.mjs";
import { bootstrapCleanInstall } from "./emdash-clean-install-bootstrap.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const runDir = process.env.EMDASH_CLEAN_INSTALL_RUN_DIR
	? resolve(process.env.EMDASH_CLEAN_INSTALL_RUN_DIR)
	: resolve(repoRoot, "runs/emdash-install-proof-runs/20260930");
const repairDir = process.env.EMDASH_CLEAN_INSTALL_FIXTURE_DIR
	? resolve(process.env.EMDASH_CLEAN_INSTALL_FIXTURE_DIR)
	: resolve(runDir, "helper-repair");
const siteDir = resolve(repairDir, "site");
const cleanSite = process.env.EMDASH_CLEAN_INSTALL_SOURCE_DIR
	? resolve(process.env.EMDASH_CLEAN_INSTALL_SOURCE_DIR)
	: resolve(runDir, "clean-site");
const pluginDir = resolve(repoRoot, "plugins/emdash-inventory");
const previousTarball = resolve(cleanSite, "dinkuskit-emdash-inventory-0.0.0.tgz");

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
	return sha256(readFileSync(path));
}

function walkFiles(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const path = resolve(dir, name);
		const st = lstatSync(path);
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) out.push(...walkFiles(path));
		else out.push(path);
	}
	return out;
}

function treeHash(paths) {
	const hash = createHash("sha256");
	for (const path of [...paths].sort()) hash.update(relative(repoRoot, path)).update("\0").update(readFileSync(path)).update("\0");
	return hash.digest("hex");
}

function readPackageVersion(name) {
	const packageRoot = process.env.EMDASH_CLEAN_INSTALL_PACKAGE_ROOT
		? resolve(process.env.EMDASH_CLEAN_INSTALL_PACKAGE_ROOT)
		: cleanSite;
	const path = resolve(packageRoot, "node_modules", name, "package.json");
	return JSON.parse(readFileSync(path, "utf8")).version;
}

function assertPortFree(port) {
	const result = spawnSync(process.execPath, [
		"-e",
		`const net=require('node:net'); const s=net.createServer(); s.once('error',e=>{console.error(e.code||e.message); process.exit(1)}); s.listen(${port},'127.0.0.1',()=>s.close(()=>process.exit(0)));`,
	], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`Controller port ${port} is not free (${(result.stderr || result.stdout || "").trim()})`);
	}
}

const sourcePaths = [
	...walkFiles(resolve(pluginDir, "src")),
	resolve(pluginDir, "emdash-plugin.jsonc"),
	resolve(pluginDir, "package.json"),
];
const distPaths = walkFiles(resolve(pluginDir, "dist")).filter(path => !path.endsWith(".tar.gz") && !path.endsWith(".tgz"));
const before = {
	source: treeHash(sourcePaths),
	dist: treeHash(distPaths),
	manifest: sha256File(resolve(pluginDir, "emdash-plugin.jsonc")),
	package: sha256File(resolve(pluginDir, "package.json")),
	private: JSON.parse(readFileSync(resolve(pluginDir, "package.json"), "utf8")).private === true,
	previousTarballSha256: existsSync(previousTarball) ? sha256File(previousTarball) : null,
	previousTarballBytes: existsSync(previousTarball) ? statSync(previousTarball).size : null,
};

mkdirSync(repairDir, { recursive: true });
const bundle = spawnSync("npm", ["run", "bundle:plugin"], {
	cwd: repoRoot,
	encoding: "utf8",
	timeout: 180000,
});
writeFileSync(resolve(repairDir, "bundle.log"), `${bundle.stdout || ""}\n${bundle.stderr || ""}`);
if (bundle.status !== 0) throw new Error(`plugin bundle exited ${bundle.status}`);

const packageAfter = JSON.parse(readFileSync(resolve(pluginDir, "package.json"), "utf8"));
if (packageAfter.private !== true) throw new Error("plugin package private flag changed");
const manifestAfter = sha256File(resolve(pluginDir, "emdash-plugin.jsonc"));
if (manifestAfter !== before.manifest) throw new Error("plugin manifest changed during bundle");
const distAfter = treeHash(walkFiles(resolve(pluginDir, "dist")).filter(path => !path.endsWith(".tar.gz") && !path.endsWith(".tgz")));

const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", repairDir], {
	cwd: pluginDir,
	encoding: "utf8",
	timeout: 60000,
});
if (pack.status !== 0) throw new Error(`npm pack exited ${pack.status}: ${pack.stderr || pack.stdout}`);
const packedName = (pack.stdout || "").trim().split("\n").filter(Boolean).at(-1);
const packedPath = resolve(repairDir, packedName);
const packedSha = sha256File(packedPath);
const packedBytes = statSync(packedPath).size;
const correspondence = before.previousTarballSha256 && packedSha === before.previousTarballSha256
	? "matches_previous_npm_tarball"
	: "repacked_from_current_source";

assertPortFree(CLEAN_INSTALL_HOST_PORT);
assertPortFree(CLEAN_INSTALL_RESERVED_PEER_PORT);

if (existsSync(siteDir)) throw new Error(`Fixture site already exists at ${siteDir}`);
mkdirSync(siteDir, { recursive: true });
const versions = {
	astro: readPackageVersion("astro"),
	emdash: readPackageVersion("emdash"),
	"@astrojs/node": readPackageVersion("@astrojs/node"),
	"@astrojs/react": readPackageVersion("@astrojs/react"),
	react: readPackageVersion("react"),
	"react-dom": readPackageVersion("react-dom"),
	"@emdash-cms/sandbox-workerd": readPackageVersion("@emdash-cms/sandbox-workerd"),
};
writeFileSync(resolve(siteDir, "package.json"), JSON.stringify({
	name: "clean-emdash-site",
	version: "0.0.0",
	type: "module",
	private: true,
	dependencies: {
		"@astrojs/node": versions["@astrojs/node"],
		"@astrojs/react": versions["@astrojs/react"],
		"@dinkuskit/emdash-inventory": `file:${packedName}`,
		"@emdash-cms/sandbox-workerd": versions["@emdash-cms/sandbox-workerd"],
		astro: versions.astro,
		emdash: versions.emdash,
		react: versions.react,
		"react-dom": versions["react-dom"],
	},
}, null, 2));
cpSync(packedPath, resolve(siteDir, packedName));

const configSource = readFileSync(resolve(repoRoot, "tools/emdash-clean-install-astro.config.mjs"), "utf8")
	.replace('import { CLEAN_INSTALL_HOST_PORT } from "./emdash-clean-install-ports.mjs";\n', "")
	.replaceAll("CLEAN_INSTALL_HOST_PORT", String(CLEAN_INSTALL_HOST_PORT));
writeFileSync(resolve(siteDir, "astro.config.mjs"), configSource);

for (const name of [
	"emdash-clean-install-host.mjs",
	"emdash-clean-install-seed.mjs",
	"emdash-clean-install-login.mjs",
	"emdash-clean-install-ports.mjs",
	"emdash-database-path.mjs",
]) {
	cpSync(resolve(repoRoot, "tools", name), resolve(siteDir, name));
}
writeFileSync(resolve(siteDir, "server.mjs"), `import { resolve } from "node:path";
import { startCleanInstallHost } from "./emdash-clean-install-host.mjs";
await startCleanInstallHost({ siteDir: import.meta.dirname, repoRoot: resolve(import.meta.dirname, "../../../../../") });
`);
mkdirSync(resolve(siteDir, "src/pages/_proof"), { recursive: true });
writeFileSync(resolve(siteDir, "src/pages/_proof/login.mjs"), `export { GET } from "../../../emdash-clean-install-login.mjs";
`);

const packageRoot = process.env.EMDASH_CLEAN_INSTALL_PACKAGE_ROOT
	? resolve(process.env.EMDASH_CLEAN_INSTALL_PACKAGE_ROOT)
	: cleanSite;
const cloned = spawnSync("cp", ["-cR", resolve(packageRoot, "node_modules"), resolve(siteDir, "node_modules")], { encoding: "utf8" });
if (cloned.status !== 0) {
	cpSync(resolve(packageRoot, "node_modules"), resolve(siteDir, "node_modules"), { recursive: true });
}
rmSync(resolve(siteDir, "node_modules/@dinkuskit"), { recursive: true, force: true });
const install = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", packedName], {
	cwd: siteDir,
	encoding: "utf8",
	timeout: 180000,
});
writeFileSync(resolve(repairDir, "npm-install.log"), `${install.stdout || ""}\n${install.stderr || ""}`);
if (install.status !== 0) throw new Error(`npm install of packed plugin exited ${install.status}`);
const installedDir = resolve(siteDir, "node_modules/@dinkuskit/emdash-inventory");
const installedStat = lstatSync(installedDir);
if (installedStat.isSymbolicLink()) throw new Error("Installed plugin is a symlink");

const provenance = {
	correspondence,
	previousTarballSha256: before.previousTarballSha256,
	previousTarballBytes: before.previousTarballBytes,
	packedPath: relative(repoRoot, packedPath),
	packedSha256: packedSha,
	packedBytes,
	sourceHash: before.source,
	distHashBeforeBundle: before.dist,
	distHashAfterBundle: distAfter,
	manifestSha256: manifestAfter,
	packageSha256: sha256File(resolve(pluginDir, "package.json")),
	private: true,
	installedRealpathIsSymlink: false,
	pinned: versions,
	ports: { host: CLEAN_INSTALL_HOST_PORT, reservedPeer: CLEAN_INSTALL_RESERVED_PEER_PORT, peerBound: false },
	sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox",
};
writeFileSync(resolve(repairDir, "artifact-hashes.json"), JSON.stringify(provenance, null, 2));
const migration = bootstrapCleanInstall({
	repoRoot,
	siteDir,
	runDir,
	databasePath: resolve(repairDir, "host-state/data.db"),
	storageDir: resolve(repairDir, "host-state/storage"),
});
writeFileSync(resolve(repairDir, "bootstrap.json"), JSON.stringify(migration, null, 2));
console.log(JSON.stringify({ ok: true, correspondence, packedSha256: packedSha, distChanged: distAfter !== before.dist, migration }, null, 2));
