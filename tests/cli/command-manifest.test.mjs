import assert from "node:assert/strict";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EXIT, runCli } from "../../src/cli/kernel.mjs";
import { spec } from "../../src/cli/spec.mjs";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

function* fencedCommands(file) {
	const markdown = readFileSync(new URL(file, root), "utf8");
	for (const [, , language, block] of markdown.matchAll(/^ *(\x60{3,}|~{3,})([^\n]*)\n([\s\S]*?)^ *\1 *$/gm)) {
		const shell = ["sh", "bash", "shell", "console"].includes(language.trim());
		for (const line of block.replaceAll(/\\\r?\n/g, "").split("\n")) {
			const example = line.trim().replace(/^\$ /, "");
			if (!example || example.startsWith("#")) continue;
			if (shell || (file === "README.md" && /^(?:dinkus-inventory|npm|(?:\.\/)?bin\/)/.test(example))) {
				yield { example, source: file };
			}
		}
	}
}

function words(example) {
	const argument = /\s*(?:"([^"\\`$]*)"|'([^']*)'|([^\s'"\\<>;&|`$]+))(?=\s|$)/y;
	const tokens = [];
	while (argument.lastIndex < example.length) {
		const match = argument.exec(example);
		assert.ok(match, `Expected literal command arguments (no shell evaluation): ${example}`);
		tokens.push(match[1] ?? match[2] ?? match[3]);
	}
	return tokens;
}

function checkDevelopmentCommand(example, [program, command, ...args]) {
	if (program === "npm") {
		if (command === "ci" && !args.length) return;
		if (command === "test" && !args.length && pkg.scripts.test) return;
		if (command === "run" && args.length === 1 && Object.hasOwn(pkg.scripts, args[0])) return;
		if (command === "ls" && args.length === 2 && args[1] === "--depth=0" &&
			Object.hasOwn({ ...pkg.dependencies, ...pkg.devDependencies }, args[0])) return;
	} else if (program.startsWith("bin/") && Object.values(pkg.scripts).includes(example)) {
		accessSync(new URL(program, root), constants.X_OK);
		return;
	}
	assert.fail(`Unknown README development command: ${example}`);
}

test("test_command_manifest_examples_parse", async (context) => {
	const home = mkdtempSync(join(tmpdir(), "inventory-examples-"));
	context.after(() => rmSync(home, { recursive: true, force: true }));
	mkdirSync(join(home, ".dinkuskit"));
	writeFileSync(join(home, ".dinkuskit/inventory.json"), JSON.stringify({ profiles: { demo: {} } }));

	const examples = spec.examples.map((example) => ({ example, source: "spec" }));
	let dispatched;
	function parseOnly(node, path = []) {
		for (const example of node.examples ?? []) examples.push({ example, source: "spec", command: path.join(".") });
		if (!node.commands) return { ...node, run(ctx) { dispatched = ctx.command; return {}; } };
		return { ...node, commands: Object.fromEntries(Object.entries(node.commands).map(([name, child]) =>
			[name, parseOnly(child, [...path, name])])) };
	}
	const parser = { ...spec, tree: parseOnly(spec.tree) };
	for (const { example, source, command } of [...examples, ...fencedCommands("README.md"), ...fencedCommands("docs/CLI-SPEC.md")]) {
		const [program, ...argv] = words(example);
		if (source === "README.md" && program !== spec.name) {
			checkDevelopmentCommand(example, [program, ...argv]);
			continue;
		}
		assert.equal(program, spec.name, `${source}: ${example}`);
		let diagnostic = "";
		dispatched = undefined;
		const code = await runCli(parser, { argv, cwd: home, env: { HOME: home }, stdout: { write() {} },
			stderr: { write(chunk) { diagnostic += chunk; } }, fetchImpl: assert.fail });
		assert.equal(code, EXIT.ok, `${source}: ${example}\n${diagnostic}`);
		if (command) assert.equal(dispatched, command, example);
	}
});
