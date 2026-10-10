// Shared DinkusKit CLI kernel. It owns parsing, help, output modes, config
// precedence, HTTP transport, prompts, and exit codes so that command modules
// only describe API calls and formatting. Keep this file dependency-free and
// identical across DinkusKit repositories until it moves into a shared package.
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

export const EXIT = Object.freeze({
	ok: 0,
	failure: 1,
	usage: 2,
	unavailable: 3,
	blocked: 4,
	contract: 5,
});

export class CliError extends Error {
	constructor(code, message, { exit = EXIT.failure, outcome = "error", details } = {}) {
		super(message);
		this.code = code;
		this.exit = exit;
		this.outcome = outcome;
		this.details = details;
	}
}

export const usageError = (message, code = "invalid_usage") =>
	new CliError(code, message, { exit: EXIT.usage });

export const BASE_GLOBAL_FLAGS = Object.freeze({
	help: { type: "boolean", short: "h", description: "Show help for the command and ignore all other arguments." },
	version: { type: "boolean", description: "Print only the installed version." },
	json: { type: "boolean", description: "Emit exactly one JSON document to stdout." },
	plain: { type: "boolean", description: "Emit stable tab-separated key=value lines." },
	"no-input": { type: "boolean", description: "Never prompt. Missing input or confirmation fails closed." },
	"no-color": { type: "boolean", description: "Disable color. NO_COLOR and TERM=dumb do the same." },
	profile: { type: "string", value: "<name>", description: "Select a named non-secret profile from config files." },
	timeout: { type: "string", value: "<duration>", description: "Network timeout such as 1500ms, 15s or 1m (default 15s)." },
});

const SECRET_KEY = /token|secret|password|passwd|authorization|credential|api[-_]?key|cookie/i;
const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Command tree helpers

function isGroup(node) {
	return node && typeof node.commands === "object";
}

function walkLeaves(node, path = [], out = []) {
	for (const [name, child] of Object.entries(node.commands)) {
		if (isGroup(child)) walkLeaves(child, [...path, name], out);
		else out.push({ path: [...path, name], node: child });
	}
	return out;
}

function allFlagDefinitions(spec) {
	const options = { ...spec.globals };
	for (const { path, node } of walkLeaves(spec.tree)) {
		for (const [name, def] of Object.entries(node.flags ?? {})) {
			const existing = options[name];
			if (existing && (existing.type !== def.type || Boolean(existing.multiple) !== Boolean(def.multiple))) {
				throw new Error(`Flag --${name} on "${path.join(" ")}" conflicts with another definition`);
			}
			options[name] = def;
		}
	}
	return options;
}

function toParseOptions(definitions) {
	const options = {};
	for (const [name, def] of Object.entries(definitions)) {
		options[name] = { type: def.type };
		if (def.short) options[name].short = def.short;
		if (def.multiple) options[name].multiple = true;
	}
	return options;
}

// Find the deepest command path named by leading positional tokens without a
// strict parse, so that help works even when other arguments are invalid.
function lenientPath(spec, argv, definitions) {
	const stringFlags = new Set();
	const shortStringFlags = new Set();
	for (const [name, def] of Object.entries(definitions)) {
		if (def.type === "string") {
			stringFlags.add(`--${name}`);
			if (def.short) shortStringFlags.add(`-${def.short}`);
		}
	}
	const positionals = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--") break;
		if (token.startsWith("-")) {
			if (!token.includes("=") && (stringFlags.has(token) || shortStringFlags.has(token))) index += 1;
			continue;
		}
		positionals.push(token);
	}
	if (positionals[0] === "help") positionals.shift();
	const path = [];
	let node = spec.tree;
	for (const token of positionals) {
		if (!isGroup(node) || !node.commands[token]) break;
		path.push(token);
		node = node.commands[token];
	}
	return { path, node, positionals };
}

// parseArgs treats "--delta -2" as a missing value. A string flag followed by a
// negative number takes that number as its value.
function joinNegativeValues(argv, definitions) {
	const out = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--") {
			out.push(...argv.slice(index));
			break;
		}
		const name = token.startsWith("--") && !token.includes("=") ? token.slice(2) : undefined;
		if (name && definitions[name]?.type === "string" && /^-\d/.test(argv[index + 1] ?? "")) {
			out.push(`${token}=${argv[index + 1]}`);
			index += 1;
		} else {
			out.push(token);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Help

function flagLabel(name, def) {
	const short = def.short ? `-${def.short}, ` : "    ";
	return `${short}--${name}${def.type === "string" ? ` ${def.value ?? "<value>"}` : ""}`;
}

function flagTable(definitions) {
	const rows = Object.entries(definitions).map(([name, def]) => [
		flagLabel(name, def),
		`${def.description ?? ""}${def.required ? " Required." : ""}${def.multiple ? " Repeatable." : ""}`,
	]);
	const width = Math.min(34, Math.max(0, ...rows.map(([label]) => label.length)));
	return rows.map(([label, text]) => `  ${label.padEnd(width)}  ${text}`.trimEnd()).join("\n");
}

function commandTable(node, prefix = []) {
	const rows = [];
	for (const [name, child] of Object.entries(node.commands)) {
		if (isGroup(child)) rows.push(...commandTable(child, [...prefix, name]));
		else rows.push([[...prefix, name].join(" "), child.summary ?? ""]);
	}
	return rows;
}

export function renderHelp(spec, path) {
	let node = spec.tree;
	for (const name of path) node = node.commands[name];
	const lines = [];
	const fullName = [spec.name, ...path].join(" ");
	if (path.length === 0) {
		lines.push(`${spec.name} ${spec.version} - ${spec.description}`, "");
		lines.push("Usage:", `  ${spec.name} [global flags] <command> [arguments]`, "");
	} else {
		lines.push(`${fullName} - ${node.summary ?? ""}`, "");
		const usage = isGroup(node) ? `${path.join(" ")} <command> [arguments]` : node.usage ?? path.join(" ");
		lines.push("Usage:", `  ${spec.name} [global flags] ${usage}`, "");
		if (node.description) lines.push(node.description, "");
	}
	if (node.examples?.length || (path.length === 0 && spec.examples?.length)) {
		lines.push("Examples:");
		for (const example of node.examples ?? spec.examples) lines.push(`  ${example}`);
		lines.push("");
	}
	if (isGroup(node)) {
		const rows = commandTable(node, path);
		const width = Math.max(...rows.map(([label]) => label.length));
		lines.push("Commands:");
		for (const [label, summary] of rows) lines.push(`  ${label.padEnd(width)}  ${summary}`);
		lines.push("");
	} else if (node.flags && Object.keys(node.flags).length > 0) {
		lines.push("Flags:", flagTable(node.flags), "");
	}
	lines.push("Global flags:", flagTable(spec.globals), "");
	if (path.length === 0 && spec.environment?.length) {
		const width = Math.max(...spec.environment.map(([name]) => name.length));
		lines.push("Environment:");
		for (const [name, text] of spec.environment) lines.push(`  ${name.padEnd(width)}  ${text}`);
		lines.push("");
	}
	lines.push(`Run '${fullName}${isGroup(node) ? " <command>" : ""} --help' for details.`);
	if (spec.docs) lines.push(`Docs: ${spec.docs}`);
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Configuration

export function parseDuration(text) {
	const match = /^(\d+)(ms|s|m)?$/.exec(String(text).trim());
	if (!match) throw usageError(`Invalid --timeout "${text}". Use a value such as 1500ms, 15s or 1m.`);
	const value = Number(match[1]);
	const ms = match[2] === "m" ? value * 60_000 : match[2] === "ms" ? value : value * 1000;
	if (!Number.isSafeInteger(ms) || ms < 1 || ms > 600_000) throw usageError("--timeout must be between 1ms and 10m.");
	return ms;
}

function assertNoSecrets(value, file, path = "") {
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (SECRET_KEY.test(key)) {
			throw usageError(`${file} contains "${path}${key}". Config files hold non-secret metadata only.`, "secret_in_config");
		}
		assertNoSecrets(child, file, `${path}${key}.`);
	}
}

async function readConfigFile(file) {
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw usageError(`Cannot read config ${file}: ${error.message}`, "invalid_config");
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw usageError(`Config ${file} is not valid JSON.`, "invalid_config");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw usageError(`Config ${file} must be a JSON object.`, "invalid_config");
	}
	assertNoSecrets(parsed, file);
	return parsed;
}

function selectProfile(file, profile) {
	if (!file) return { values: {}, found: false };
	const { profiles, ...base } = file;
	if (!profile) return { values: base, found: false };
	const selected = profiles && typeof profiles === "object" ? profiles[profile] : undefined;
	return { values: { ...base, ...(selected ?? {}) }, found: Boolean(selected) };
}

export async function loadConfig(spec, { flags, env, cwd }) {
	const profile = flags.profile ?? env[spec.envMap?.profile] ?? undefined;
	const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
	const files = {
		project: join(cwd, ".dinkuskit", `${spec.configName}.json`),
		user: join(configHome, "dinkuskit", spec.configName, "config.json"),
	};
	const project = selectProfile(await readConfigFile(files.project), profile);
	const user = selectProfile(await readConfigFile(files.user), profile);
	if (profile && !project.found && !user.found) {
		throw usageError(`Profile "${profile}" was not found in ${files.project} or ${files.user}.`, "unknown_profile");
	}
	const lookup = (key) => {
		if (flags[key] !== undefined) return { value: flags[key], source: "flag" };
		const envName = spec.envMap?.[key];
		if (envName && env[envName] !== undefined && env[envName] !== "") return { value: env[envName], source: "env" };
		if (project.values[key] !== undefined) return { value: project.values[key], source: "project" };
		if (user.values[key] !== undefined) return { value: user.values[key], source: "user" };
		if (spec.defaults?.[key] !== undefined) return { value: spec.defaults[key], source: "default" };
		return { value: undefined, source: undefined };
	};
	// source() lets a command refuse a value from the project file when that
	// value decides where a credential is sent: the project file travels with
	// whatever directory the operator happens to run in.
	return { profile, files, resolve: (key) => lookup(key).value, source: (key) => lookup(key).source };
}

export function validateEndpoint(text, flagName = "--endpoint") {
	let url;
	try {
		url = new URL(text);
	} catch {
		throw usageError(`${flagName} "${text}" is not a valid URL.`, "invalid_endpoint");
	}
	if (url.username || url.password) throw usageError(`${flagName} must not contain credentials.`, "invalid_endpoint");
	if (url.search || url.hash) throw usageError(`${flagName} must not contain a query or fragment.`, "invalid_endpoint");
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw usageError(`${flagName} must use https (http is allowed only for localhost).`, "invalid_endpoint");
	}
	return url.href.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// HTTP transport

export function createHttp({ baseUrl, headers = {}, timeoutMs, fetchImpl, signal }) {
	return async function request(method, path, { query, body, headers: extra = {} } = {}) {
		const url = new URL(`${baseUrl}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		const init = { method, headers: { accept: "application/json", ...headers, ...extra } };
		if (body !== undefined) {
			init.headers["content-type"] = "application/json";
			// A string body is sent byte-for-byte (frozen command envelopes).
			init.body = typeof body === "string" ? body : JSON.stringify(body);
		}
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (signal) signals.push(signal);
		init.signal = AbortSignal.any(signals);
		let response;
		try {
			response = await fetchImpl(url, init);
		} catch (error) {
			if (error?.name === "TimeoutError") {
				throw new CliError("timeout", `No response from ${url.origin} within ${timeoutMs}ms.`, { exit: EXIT.unavailable });
			}
			if (error?.name === "AbortError") {
				throw new CliError("interrupted", "Request interrupted.", { exit: EXIT.unavailable });
			}
			throw new CliError("service_unreachable", `Could not reach ${url.origin}.`, { exit: EXIT.unavailable });
		}
		const text = await response.text();
		let json;
		if (text.length > 0) {
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
		}
		return { status: response.status, ok: response.ok, json, text };
	};
}

// Map a non-success HTTP response to the shared exit-code contract. Commands
// handle the statuses that carry business meaning before calling this.
export function httpFailure(response, what) {
	// Accept both { error: "code", message } and EmDash's { error: { code, message } }.
	const nested = response.json?.error && typeof response.json.error === "object" ? response.json.error : undefined;
	const rawCode = nested ? nested.code : response.json?.error;
	const rawMessage = nested ? nested.message : response.json?.message;
	const code = typeof rawCode === "string" ? rawCode : `http_${response.status}`;
	const message = typeof rawMessage === "string" ? rawMessage : `${what} failed (${code}).`;
	if (response.status === 401) return new CliError(code, `${what}: the service rejected the credential.`, { exit: EXIT.blocked });
	if (response.status === 403) return new CliError(code, `${what}: not permitted (${code}).`, { exit: EXIT.blocked });
	if (response.status >= 500) return new CliError(code, `${what}: service unavailable (${code}).`, { exit: EXIT.unavailable });
	if (response.json === undefined) return new CliError("malformed_response", `${what}: the service returned a non-JSON response.`, { exit: EXIT.contract });
	return new CliError(code, message, { exit: EXIT.failure });
}

export function expectJson(response, what) {
	if (!response.ok) throw httpFailure(response, what);
	if (response.json === undefined || response.json === null || typeof response.json !== "object") {
		throw new CliError("malformed_response", `${what}: the service returned a response outside the contract.`, { exit: EXIT.contract });
	}
	return response.json;
}

// ---------------------------------------------------------------------------
// Output

// Service-supplied text must not drive the terminal. Human output and stderr
// keep newlines and tabs but show every other control character escaped.
export function sanitizeTerminal(text) {
	return String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function escapePlain(value) {
	const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
	return sanitizeTerminal(text.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r"));
}

function flatten(value, prefix = "", out = []) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
	} else if (prefix) {
		out.push([prefix, value]);
	}
	return out;
}

function plainLine(head, record) {
	return [...head, ...record].map(([key, value]) => `${key}=${escapePlain(value)}`).join("\t");
}

function humanDefault(document) {
	const body = document.data ?? document.receipt ?? document.rejection ?? document.unknown;
	const lines = flatten(body ?? {}).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
	return lines.length ? lines.join("\n") : document.outcome;
}

const DOCUMENT_KEYS = ["commandId", "data", "receipt", "rejection", "unknown", "confirmation", "warnings", "error"];

function buildDocument(spec, commandName, result) {
	const document = { schema: spec.schema, command: commandName, outcome: result.outcome ?? "ok", context: result.context ?? {} };
	for (const key of DOCUMENT_KEYS) if (result[key] !== undefined) document[key] = result[key];
	return document;
}

function write(stream, text) {
	if (text) stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function emit(spec, io, mode, commandName, result) {
	const document = buildDocument(spec, commandName, result);
	if (mode === "json") {
		write(io.stdout, JSON.stringify(document));
	} else if (mode === "plain") {
		const head = [["schema", document.schema], ["command", document.command], ["outcome", document.outcome]];
		const records = result.plain ?? [flatten({ context: document.context, ...Object.fromEntries(DOCUMENT_KEYS.filter((key) => document[key] !== undefined).map((key) => [key, document[key]])) })];
		write(io.stdout, records.map((record) => plainLine(head, record)).join("\n"));
	} else {
		write(io.stdout, sanitizeTerminal(result.human ?? humanDefault(document)));
	}
	for (const note of result.notes ?? []) write(io.stderr, sanitizeTerminal(note));
}

function emitError(spec, io, mode, commandName, error) {
	if (mode === "json") {
		write(io.stdout, JSON.stringify(buildDocument(spec, commandName ?? "", {
			outcome: error.outcome,
			context: error.details?.context,
			error: { code: error.code, message: error.message },
			...(error.details?.document ?? {}),
		})));
	} else if (mode === "plain") {
		write(io.stdout, plainLine([["schema", spec.schema], ["command", commandName ?? ""], ["outcome", error.outcome]], [["code", error.code], ["message", error.message]]));
	}
	write(io.stderr, `${spec.name}: ${sanitizeTerminal(error.message)}`);
}

// ---------------------------------------------------------------------------
// Entry point

export async function runCli(spec, { argv, env = {}, cwd = ".", stdout, stderr, stdin, stdinIsTTY = false, fetchImpl = globalThis.fetch, signal, lifecycle = {} }) {
	const io = { stdout, stderr };
	spec = { ...spec, globals: { ...BASE_GLOBAL_FLAGS, ...spec.globals } };
	const definitions = allFlagDefinitions(spec);

	const lenient = lenientPath(spec, argv, definitions);
	const helpRequested = argv.slice(0, argv.includes("--") ? argv.indexOf("--") : argv.length).some((token) => token === "-h" || token === "--help");
	if (helpRequested || argv[0] === "help") {
		write(io.stdout, renderHelp(spec, lenient.path));
		return EXIT.ok;
	}
	if (argv.includes("--version")) {
		write(io.stdout, spec.version);
		return EXIT.ok;
	}

	let mode = "human";
	let commandName;
	try {
		let parsed;
		try {
			parsed = parseArgs({ args: joinNegativeValues(argv, definitions), options: toParseOptions(definitions), allowPositionals: true, strict: true });
		} catch (error) {
			throw usageError(error.message.replace(/\. To specify a positional argument.*$/s, "."));
		}
		const flags = parsed.values;
		if (flags.json && flags.plain) throw usageError("--json and --plain cannot be combined.");
		mode = flags.json ? "json" : flags.plain ? "plain" : "human";

		const positionals = [...parsed.positionals];
		const path = [];
		let node = spec.tree;
		while (isGroup(node)) {
			const name = positionals[0];
			if (name === undefined) {
				write(io.stderr, renderHelp(spec, path));
				throw usageError(path.length ? `Missing command after "${path.join(" ")}".` : "Missing command.", "missing_command");
			}
			if (!node.commands[name]) {
				const known = Object.keys(node.commands).join(", ");
				throw usageError(`Unknown command "${[...path, name].join(" ")}". Expected one of: ${known}.`, "unknown_command");
			}
			path.push(positionals.shift());
			node = node.commands[name];
		}
		commandName = path.join(".");

		const allowed = new Set([...Object.keys(spec.globals), ...Object.keys(node.flags ?? {})]);
		for (const name of Object.keys(flags)) {
			if (!allowed.has(name)) throw usageError(`--${name} is not a flag of "${path.join(" ")}".`, "unknown_flag");
		}
		for (const [name, def] of Object.entries(node.flags ?? {})) {
			if (def.required && flags[name] === undefined) throw usageError(`"${path.join(" ")}" requires --${name}.`, "missing_flag");
		}
		const args = {};
		for (const arg of node.args ?? []) {
			const value = positionals.shift();
			if (value === undefined && arg.required !== false) throw usageError(`"${path.join(" ")}" requires <${arg.name}>.`, "missing_argument");
			args[arg.name] = value;
		}
		if (positionals.length > 0) throw usageError(`Unexpected argument "${positionals[0]}" for "${path.join(" ")}".`, "unexpected_argument");

		const timeoutMs = flags.timeout !== undefined ? parseDuration(flags.timeout) : DEFAULT_TIMEOUT_MS;
		const config = await loadConfig(spec, { flags, env, cwd });
		const ctx = {
			spec,
			command: commandName,
			args,
			flags,
			env,
			cwd,
			config,
			mode,
			timeoutMs,
			fetchImpl,
			signal,
			io,
			stdin,
			interactive: Boolean(stdinIsTTY && stdin && !flags["no-input"]),
			lifecycle,
			async prompt(question) {
				if (flags["no-input"] || !stdinIsTTY || !stdin) {
					throw new CliError("input_required", "Confirmation is required but prompting is disabled (no TTY or --no-input).", { exit: EXIT.blocked });
				}
				const readline = createInterface({ input: stdin, output: stderr, terminal: false });
				try {
					// End of input (Ctrl-D) is a refusal, never a hang.
					return await new Promise((resolve, reject) => {
						// Deferred so that a final line arriving with end of input still answers.
						readline.once("close", () => setImmediate(() => reject(new CliError("input_closed", "Input ended before confirmation; nothing was sent.", { exit: EXIT.blocked }))));
						readline.question(question).then((answer) => resolve(answer.trim()), reject);
					});
				} finally {
					readline.close();
				}
			},
		};
		const result = await node.run(ctx);
		emit(spec, io, mode, commandName, result);
		return result.exit ?? EXIT.ok;
	} catch (error) {
		if (!(error instanceof CliError)) {
			const wrapped = new CliError("internal_error", `Unexpected error: ${error?.message ?? error}`, { exit: EXIT.contract });
			emitError(spec, io, mode, commandName, wrapped);
			return wrapped.exit;
		}
		emitError(spec, io, mode, commandName, error);
		if (error.exit === EXIT.usage && commandName) write(io.stderr, `Run '${spec.name} ${commandName.replace(/\./g, " ")} --help' for usage.`);
		return error.exit;
	}
}

// Process wrapper used by bin entrypoints. Ctrl-C before an authoritative send
// exits 4 with nothing sent; during a send it reports an unknown outcome (3).
export async function main(spec) {
	const controller = new AbortController();
	const lifecycle = { sending: false };
	process.once("SIGINT", () => {
		if (lifecycle.sending) {
			process.stderr.write(`${spec.name}: interrupted after the request was sent; the outcome is unknown.\n`);
			process.exitCode = EXIT.unavailable;
		} else {
			process.stderr.write(`${spec.name}: interrupted; nothing was sent.\n`);
			process.exitCode = EXIT.blocked;
		}
		controller.abort();
		setTimeout(() => process.exit(), 250).unref();
	});
	const code = await runCli(spec, {
		argv: process.argv.slice(2),
		env: process.env,
		cwd: process.cwd(),
		stdout: process.stdout,
		stderr: process.stderr,
		stdin: process.stdin,
		stdinIsTTY: Boolean(process.stdin.isTTY),
		signal: controller.signal,
		lifecycle,
	});
	if (process.exitCode === undefined) process.exitCode = code;
}
