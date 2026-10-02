// Explicit local proof variant. Does not modify production plugin authorities.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapCleanInstall } from "./emdash-clean-install-bootstrap.mjs";

const root = resolve(import.meta.dirname, "..");
const runDir = resolve(root, "runs/emdash-install-proof-runs/20260930");
const merchantConnect = process.argv.includes("--merchant-connect");
const fixture = resolve(runDir, merchantConnect ? "merchant-connect-variant" : process.argv.includes("--site-identity-repair") ? "site-identity-variant" : "transport-variant");
const site = resolve(fixture, "site");
const previous = resolve(runDir, "helper-repair/site");
if (existsSync(site)) throw new Error("Transport fixture already exists; refusing overwrite");
mkdirSync(site, { recursive: true });
const pluginDir = resolve(fixture, "build/plugins/emdash-inventory");
cpSync(resolve(root, "src"), resolve(fixture, "build/src"), { recursive: true });
cpSync(resolve(root, "plugins/emdash-inventory/src"), resolve(pluginDir, "src"), { recursive: true });
cpSync(resolve(root, "plugins/emdash-inventory/package.json"), resolve(pluginDir, "package.json"));
const pluginSource = readFileSync(resolve(pluginDir, "src/plugin.ts"), "utf8");
if (pluginSource.split('const SERVICE = "https://inventory.dinkuskit.invalid";').length !== 2) throw new Error("Service anchor differs");
let variantSource = pluginSource.replace('const SERVICE = "https://inventory.dinkuskit.invalid";', 'const SERVICE = "https://dinkuskit.com";');
if (merchantConnect) {
	for (const anchor of ['const WEBSITE = "https://accounts.dinkuskit.invalid";', 'assertVerificationUri(started.verification_uri, WEBSITE, started.connection_id);']) {
		if (pluginSource.split(anchor).length !== 2) throw new Error("Merchant variant anchor differs");
	}
	variantSource = variantSource.replace('const WEBSITE = "https://accounts.dinkuskit.invalid";', 'const WEBSITE = "https://dinkuskit.com";')
		.replace('assertVerificationUri(started.verification_uri, WEBSITE, started.connection_id);', 'assertVerificationUri(started.verification_uri, "http://127.0.0.1:47632", started.connection_id);');
}
writeFileSync(resolve(pluginDir, "src/plugin.ts"), variantSource);
const manifest = JSON.parse(readFileSync(resolve(root, "plugins/emdash-inventory/emdash-plugin.jsonc"), "utf8"));
manifest.allowedHosts = merchantConnect ? ["dinkuskit.com"] : ["dinkuskit.com", "accounts.dinkuskit.invalid"];
writeFileSync(resolve(pluginDir, "emdash-plugin.jsonc"), JSON.stringify(manifest, null, 2));
function run(label, cmd, args, cwd) {
	const result = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 180000 });
	writeFileSync(resolve(fixture, `${label}.log`), `${result.stdout || ""}\n${result.stderr || ""}`);
	if (result.status !== 0) throw new Error(`${label} exited ${result.status}`);
	return result.stdout;
}
run("variant-build", resolve(root, "node_modules/.bin/emdash-plugin"), ["bundle", "--dir", pluginDir], root);
const tarName = run("variant-pack", "npm", ["pack", "--ignore-scripts", "--pack-destination", fixture], pluginDir).trim().split("\n").at(-1);
cpSync(resolve(fixture, tarName), resolve(site, tarName));
const pkg = JSON.parse(readFileSync(resolve(previous, "package.json"), "utf8"));
pkg.dependencies["@dinkuskit/emdash-inventory"] = `file:${tarName}`;
writeFileSync(resolve(site, "package.json"), JSON.stringify(pkg, null, 2));
// Reuse pinned dependency bytes without copying any prior host state or DB.
run("copy-pinned-dependencies", "cp", ["-cR", resolve(previous, "node_modules"), resolve(site, "node_modules")], root);
run("install-variant", "npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", tarName], site);
const installed = resolve(site, "node_modules/@dinkuskit/emdash-inventory");
if (lstatSync(installed).isSymbolicLink()) throw new Error("Variant installation is a symlink");
if (readFileSync(resolve(installed, "dist/plugin.mjs"), "utf8") !== readFileSync(resolve(pluginDir, "dist/plugin.mjs"), "utf8")) throw new Error("Installed variant bytes differ");
for (const name of ["emdash-clean-install-host.mjs", "emdash-clean-install-seed.mjs", "emdash-clean-install-login.mjs", "emdash-clean-install-ports.mjs", "emdash-database-path.mjs", "emdash-proof-sandbox.mjs", "emdash-merchant-proof-sandbox.mjs", "emdash-merchant-loopback-transport.mjs"]) {
	cpSync(resolve(root, "tools", name), resolve(site, name));
}
writeFileSync(resolve(site, "server.mjs"), `import { startCleanInstallHost } from "./emdash-clean-install-host.mjs";\nawait startCleanInstallHost({ siteDir: import.meta.dirname, repoRoot: ${JSON.stringify(root)}, proofTransport: true, merchantConnect: ${merchantConnect} });\n`);
const sandboxName = merchantConnect ? "emdash-merchant-proof-sandbox.mjs" : "emdash-proof-sandbox.mjs";
writeFileSync(resolve(site, "astro.config.mjs"), readFileSync(resolve(root, "tools/emdash-clean-install-astro.config.mjs"), "utf8").replace('sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox"', `sandboxRunner: ${JSON.stringify(resolve(site, sandboxName))}`));
mkdirSync(resolve(site, "src/pages/_proof"), { recursive: true });
writeFileSync(resolve(site, "src/pages/_proof/login.js"), 'export { GET } from "../../../emdash-clean-install-login.mjs";\n');
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(resolve(fixture, "variant-hashes.json"), JSON.stringify({
	qualification: "local_test_variant_not_registry_approval", serviceAuthority: "https://dinkuskit.com",
	source: sha(resolve(pluginDir, "src/plugin.ts")), manifest: sha(resolve(pluginDir, "emdash-plugin.jsonc")),
	code: sha(resolve(installed, "dist/plugin.mjs")), descriptor: sha(resolve(installed, "dist/index.mjs")),
	tarball: sha(resolve(fixture, tarName)), sandbox: sha(resolve(site, sandboxName)), installedSymlink: false,
	merchantConnect, browserWebsiteOrigin: merchantConnect ? "http://127.0.0.1:47632" : null
}, null, 2));
const migration = bootstrapCleanInstall({ repoRoot: root, siteDir: site, runDir,
	databasePath: resolve(fixture, "host-state/data.db"), storageDir: resolve(fixture, "host-state/storage"), logDir: fixture });
writeFileSync(resolve(fixture, "bootstrap.json"), JSON.stringify(migration, null, 2));
console.log("TRANSPORT_FIXTURE_READY local_test_variant_not_registry_approval");
