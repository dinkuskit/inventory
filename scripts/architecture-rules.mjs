import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FEATURE_IDS = [
	"dinkus.opening-balance",
	"dinkus.location-registry",
	"dinkus.stock-read",
	"dinkus.managed-sku",
	"dinkus.stock-adjustment",
	"dinkus.stock-transfer",
];

const FEATURE_STRUCTURE = new Map([
	["dinkus.opening-balance", "mapped current location"],
	["dinkus.location-registry", "mapped current location"],
	["dinkus.stock-read", "mapped current location"],
	["dinkus.managed-sku", "migrated pilot"],
	["dinkus.stock-adjustment", "migrated feature"],
	["dinkus.stock-transfer", "migrated feature"],
]);

const FEATURE_SHARED_DEPENDENCIES = new Map([
	[
		"managed-sku",
		new Set([
			"src/domain/opening-balance.ts",
			"src/storage/inventory-store.ts",
		]),
	],
	[
		"stock-adjustment",
		new Set([
			"src/domain/exact-decimal.ts",
			"src/domain/opening-balance.ts",
			"src/storage/inventory-store.ts",
		]),
	],
	[
		"stock-transfer",
		new Set([
			"src/domain/exact-decimal.ts",
			"src/domain/opening-balance.ts",
			"src/storage/inventory-store.ts",
		]),
	],
]);

const REQUIRED_FILES = [
	"FEATURE_MAP.md",
	"bin/verify-inventory",
	"skills/inventory-verification/SKILL.md",
	"scripts/check-architecture.mjs",
	"scripts/architecture-rules.mjs",
	"src/domain/exact-decimal.ts",
	"src/features/managed-sku/domain.ts",
	"src/features/managed-sku/index.ts",
	"src/features/managed-sku/register.ts",
	"src/features/stock-adjustment/adjust.ts",
	"src/features/stock-adjustment/domain.ts",
	"src/features/stock-adjustment/index.ts",
	"src/features/stock-adjustment/preview-confirm.ts",
	"src/features/stock-transfer/domain.ts",
	"src/features/stock-transfer/execute.ts",
	"src/features/stock-transfer/index.ts",
	"src/features/stock-transfer/read.ts",
	"tests/managed-sku/public-entry.test.mjs",
	"tests/stock-adjustment/domain.test.mjs",
	"tests/stock-adjustment/preview-confirm-stock-adjustment.test.mjs",
	"tests/stock-adjustment/public-entry.test.mjs",
	"tests/cloudflare/stock-adjustment.test.mjs",
	"tests/stock-transfer/created-stock-transfer.test.mjs",
	"tests/stock-transfer/domain.test.mjs",
	"tests/stock-transfer/in-transit-stock-transfer.test.mjs",
	"tests/stock-transfer/public-entry.test.mjs",
	"tests/stock-transfer/received-stock-transfer.test.mjs",
	"tests/cloudflare/stock-transfer.test.mjs",
	"bin/verify-stock-adjustment",
	"skills/stock-adjustment-verification/SKILL.md",
	"bin/verify-stock-transfer",
	"skills/stock-transfer-verification/SKILL.md",
	"tests/workflows/repository-architecture.test.mjs",
	".github/workflows/repo-contract.yml",
];

function repositoryRoot(root) {
	return root instanceof URL ? fileURLToPath(root) : root;
}

async function walk(root, directory = root) {
	const paths = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if ([".git", "node_modules"].includes(entry.name)) continue;
		const absolute = join(directory, entry.name);
		if (entry.isDirectory()) paths.push(...(await walk(root, absolute)));
		else paths.push(relative(root, absolute).replaceAll("\\", "/"));
	}
	return paths;
}

function moduleSpecifiers(source) {
	const specifiers = new Set();
	const fromPattern = /\b(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)?\s*from\s*["']([^"']+)["']/gs;
	const exportAllPattern = /\bexport\s+\*\s+from\s*["']([^"']+)["']/g;
	const sideEffectPattern = /\bimport\s*["']([^"']+)["']/g;
	const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const pattern of [
		fromPattern,
		exportAllPattern,
		sideEffectPattern,
		dynamicPattern,
	]) {
		for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
	}
	return [...specifiers];
}

function resolvedRepositoryPath(path, specifier) {
	if (!specifier.startsWith(".")) return null;
	return posix.normalize(posix.join(posix.dirname(path), specifier));
}

function featureOwner(path) {
	return path.match(/^src\/features\/([^/]+)\//)?.[1] ?? null;
}

function featureTarget(path) {
	const match = path.match(/^src\/features\/([^/]+)(?:\/(.*))?$/);
	if (!match) return null;
	return { id: match[1], remainder: match[2] ?? "" };
}

function isFeatureEntry(remainder) {
	return remainder === "" || /^index(?:\.[cm]?[jt]sx?)?$/.test(remainder);
}

export function findImportViolations(path, source) {
	const violations = [];
	for (const specifier of moduleSpecifiers(source)) {
		const target = resolvedRepositoryPath(path, specifier);
		if (!target) continue;
		const owner = featureOwner(path);
		const targetFeature = featureTarget(target);
		if (targetFeature) {
			if (owner === targetFeature.id) continue;
			if (!isFeatureEntry(targetFeature.remainder)) {
				violations.push({
					path,
					specifier,
					reason: "feature internals are private outside their owner",
				});
			}
			continue;
		}
		if (owner) {
			const allowed = FEATURE_SHARED_DEPENDENCIES.get(owner) ?? new Set();
			if (target.startsWith("src/") && !allowed.has(target)) {
				violations.push({
					path,
					specifier,
					reason: "feature dependency is not declared",
				});
			}
		}
	}
	return violations;
}

function tableCells(line) {
	return line
		.slice(1, -1)
		.split("|")
		.map((cell) => cell.trim());
}

function codeSpans(value) {
	return [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

async function pathExists(root, path) {
	try {
		await access(join(root, path));
		return true;
	} catch {
		return false;
	}
}

export async function validateFeatureMap(rootInput) {
	const root = repositoryRoot(rootInput);
	let source;
	try {
		source = await readFile(join(root, "FEATURE_MAP.md"), "utf8");
	} catch {
		return ["FEATURE_MAP.md is missing"];
	}
	const errors = [];
	const lines = source.split("\n");
	const headerIndex = lines.findIndex((line) =>
		line.startsWith("| Stable feature ID |"),
	);
	if (headerIndex === -1) return ["FEATURE_MAP.md is missing the canonical table"];
	const rows = [];
	for (const line of lines.slice(headerIndex + 2)) {
		if (!line.startsWith("|")) break;
		rows.push(tableCells(line));
	}
	if (rows.length !== FEATURE_IDS.length) {
		errors.push(`expected ${FEATURE_IDS.length} feature rows, found ${rows.length}`);
	}
	const observed = [];
	for (const cells of rows) {
		if (cells.length !== 10) {
			errors.push(`feature row has ${cells.length} columns: ${cells[0] ?? "unknown"}`);
			continue;
		}
		if (cells.some((cell) => cell.length === 0)) {
			errors.push(`feature row has an empty field: ${cells[0]}`);
		}
		const [id] = codeSpans(cells[0]);
		observed.push(id);
		if (cells[6] !== "`bin/verify-inventory quick`") {
			errors.push(`${id} has a noncanonical quick verifier`);
		}
		if (cells[7] !== "`bin/verify-inventory full`") {
			errors.push(`${id} has a noncanonical full verifier`);
		}
		if (cells[9] !== FEATURE_STRUCTURE.get(id)) {
			errors.push(`${id} has an unexpected structure status`);
		}
		for (const path of [
			...codeSpans(cells[2]),
			...codeSpans(cells[3]),
			...codeSpans(cells[5]),
		]) {
			if (path.startsWith("@") || !path.includes("/")) continue;
			if (!(await pathExists(root, path))) {
				errors.push(`${id} references missing path ${path}`);
			}
		}
	}
	if (new Set(observed).size !== observed.length) {
		errors.push("feature IDs must be unique");
	}
	for (const id of FEATURE_IDS) {
		if (!observed.includes(id)) errors.push(`feature map is missing ${id}`);
	}
	return errors;
}

export async function auditInventoryArchitecture(rootInput) {
	const root = repositoryRoot(rootInput);
	const findings = [];
	const files = await walk(root);
	for (const required of REQUIRED_FILES) {
		if (!files.includes(required)) findings.push(`missing required file: ${required}`);
	}
	for (const forbidden of [
		"src/domain/managed-sku.ts",
		"src/application/register-managed-sku.ts",
	]) {
		if (files.includes(forbidden)) findings.push(`superseded pilot path remains: ${forbidden}`);
	}
	for (const error of await validateFeatureMap(root)) {
		findings.push(`FEATURE_MAP.md: ${error}`);
	}
	for (const path of files) {
		if (!/^(?:src|tests|scripts|tools)\//.test(path)) continue;
		if (!/[.](?:[cm]?[jt]sx?|mjs)$/.test(path)) continue;
		const source = await readFile(join(root, path), "utf8");
		for (const violation of findImportViolations(path, source)) {
			findings.push(`${path}: ${violation.specifier}: ${violation.reason}`);
		}
	}
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	if (manifest.scripts?.["audit:features"] !== "node scripts/check-architecture.mjs") {
		findings.push("package audit:features must run the architecture check");
	}
	if (manifest.scripts?.["verify:quick"] !== "bin/verify-inventory quick") {
		findings.push("package verify:quick must use the canonical verifier");
	}
	if (manifest.scripts?.["verify:full"] !== "bin/verify-inventory full") {
		findings.push("package verify:full must use the canonical verifier");
	}
	const rootEntry = await readFile(join(root, "src/index.ts"), "utf8");
	if (!rootEntry.includes('from "./features/managed-sku/index.ts"')) {
		findings.push("src/index.ts must compose the managed-SKU public entry");
	}
	if (!rootEntry.includes('from "./features/stock-adjustment/index.ts"')) {
		findings.push("src/index.ts must compose the stock-adjustment public entry");
	}
	if (!rootEntry.includes('from "./features/stock-transfer/index.ts"')) {
		findings.push("src/index.ts must compose the stock-transfer public entry");
	}
	return findings;
}
