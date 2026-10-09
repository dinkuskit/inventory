// Proves the zod/mini plugin validation matches the full-zod version it replaced.
// Usage: node --experimental-strip-types proof/registry-size-zod-mini-20261009/compare-validation.mjs [base-ref]
// Copies the base ref's plugin and Store Connect protocol next to the working tree's,
// exports every named schema from both, then (1) compares the two schema trees rule by
// rule and (2) parses 135,000 seeded random inputs through both and compares the result.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const base = process.argv[2] ?? "fd2df02";
const work = resolve(root, ".grilltrack/work/zod-mini-compare");
const PLUGIN = "plugins/emdash-inventory/src/plugin.ts";
const PROTOCOL = "src/features/store-connect/protocol.ts";
rmSync(work, { recursive: true, force: true });

function stage(label, read) {
	const dir = resolve(work, label);
	mkdirSync(dir, { recursive: true });
	writeFileSync(resolve(dir, "protocol.ts"), read(PROTOCOL));
	let plugin = read(PLUGIN).replace('"../../../src/features/store-connect/index.ts"', '"./protocol.ts"');
	const names = [...plugin.matchAll(/^const (\w+) = /gm)].map((m) => m[1]);
	plugin += `\nexport const __schemas = { ${names.join(", ")} };\n`;
	writeFileSync(resolve(dir, "plugin.ts"), plugin);
	return dir;
}
const oldDir = stage("old", (path) => execFileSync("git", ["show", `${base}:${path}`], { cwd: root, encoding: "utf8" }));
const newDir = stage("new", (path) => readFileSync(resolve(root, path), "utf8"));
const load = async (dir) => {
	const plugin = await import(pathToFileURL(resolve(dir, "plugin.ts")));
	const protocol = await import(pathToFileURL(resolve(dir, "protocol.ts")));
	const schemas = {};
	for (const [k, v] of Object.entries(plugin.__schemas)) if (v?._zod) schemas[`plugin.${k}`] = v;
	for (const [k, v] of Object.entries(protocol)) if (v?._zod) schemas[`protocol.${k}`] = v;
	return schemas;
};
const before = await load(oldDir);
const after = await load(newDir);

// 1. Rule-by-rule comparison of the schema trees.
const IGNORE = new Set(["error", "abort", "when"]);
function tree(x, seen = new Map()) {
	if (x === null || (typeof x !== "object" && typeof x !== "function")) return x;
	if (typeof x === "function") return `fn:${x.toString().replace(/\s+/g, " ")}`;
	if (x instanceof RegExp) return `re:${x.source}`;
	if (Array.isArray(x)) return x.map((v) => tree(v, seen));
	if (x._zod) {
		if (seen.has(x)) return seen.get(x);
		const out = {};
		seen.set(x, out);
		const def = x._zod.def;
		for (const k of Object.keys(def).sort()) if (!IGNORE.has(k) && def[k] !== undefined) out[k] = tree(def[k], seen);
		return out;
	}
	const out = {};
	for (const k of Object.keys(x).sort()) out[k] = tree(x[k], seen);
	return out;
}
const names = Object.keys(before);
const missing = names.filter((k) => !after[k]);
const treeDiffs = names.filter((k) => after[k] && JSON.stringify(tree(before[k])) !== JSON.stringify(tree(after[k])));

// 2. Seeded random inputs through both versions.
let seed = 20261009;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const strings = ["", " ", "a", "  padded  ", "x".repeat(43), "x".repeat(128), "x".repeat(129), "x".repeat(200), "x".repeat(201), "https://shop.example.com", "not a url", "S256", "each", "pending", "ready"];
const numbers = [0, 1, -1, 1.5, 60, 61, 600, 601, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY];
function sample(schema, depth = 0) {
	const def = schema._zod.def;
	switch (def.type) {
		case "string": return pick(strings);
		case "number": return pick(numbers);
		case "boolean": return rnd() < 0.5;
		case "literal": return pick(def.values);
		case "enum": return pick(Object.values(def.entries));
		case "unknown": case "any": return pick([1, "x", null, {}]);
		case "never": return undefined;
		case "nullable": return rnd() < 0.2 ? null : sample(def.innerType, depth);
		case "optional": case "default": return rnd() < 0.3 ? undefined : sample(def.innerType, depth);
		case "array": return depth > 6 ? [] : Array.from({ length: pick([0, 1, 2]) }, () => sample(def.element, depth + 1));
		case "union": return sample(pick(def.options), depth);
		case "object": {
			const out = {};
			for (const [k, v] of Object.entries(def.shape)) { const x = sample(v, depth + 1); if (x !== undefined) out[k] = x; }
			return out;
		}
		default: throw new Error(`unhandled schema type ${def.type}`);
	}
}
function mutate(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const keys = Object.keys(value);
		const out = { ...value };
		const r = rnd();
		if (r < 0.2 && keys.length) delete out[pick(keys)];
		else if (r < 0.35) out.extra = 1;
		else if (r < 0.6 && keys.length) { const k = pick(keys); out[k] = mutate(out[k]); }
		else if (r < 0.7 && keys.length) out[pick(keys)] = pick([null, 5, "s", [], {}]);
		return out;
	}
	if (Array.isArray(value)) return value.length && rnd() < 0.5 ? value.map(mutate) : [...value, pick([1, "x", {}])];
	return rnd() < 0.5 ? pick([...strings, ...numbers, null, true]) : value;
}
const view = (r) => JSON.stringify(r.success ? { data: r.data } : { issues: r.error.issues });
let inputs = 0, accepted = 0, mismatches = 0;
for (const k of names) {
	if (!after[k]) continue;
	for (let i = 0; i < 3000; i++) {
		let value = sample(before[k]);
		for (let j = Math.floor(rnd() * 3); j > 0; j--) value = mutate(value);
		const a = view(before[k].safeParse(value));
		const b = view(after[k].safeParse(value));
		inputs++;
		if (a.startsWith('{"data"')) accepted++;
		if (a !== b) { mismatches++; if (mismatches <= 3) console.log(`MISMATCH ${k} ${JSON.stringify(value)}\n before ${a}\n after  ${b}`); }
	}
}
rmSync(work, { recursive: true, force: true });
console.log(`Base ${base}: ${names.length} schemas; ${missing.length} missing; ${treeDiffs.length} differ rule by rule${treeDiffs.length ? ` (${treeDiffs.join(", ")})` : ""}`);
console.log(`${inputs} random inputs: ${accepted} accepted, ${inputs - accepted} rejected, ${mismatches} differ in result, data or error details`);
process.exit(missing.length || treeDiffs.length || mismatches ? 1 : 0);
