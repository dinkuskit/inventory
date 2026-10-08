// Operator-local pending-command store. It holds recovery metadata only: the
// command ID, the frozen public-safe envelope and its digest, and the terminal
// reference once known. It never stores credentials or balances.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { usageError } from "./kernel.mjs";

const COMMAND_ID = /^cmd_[A-Za-z0-9]{8,64}$/;

export function pendingStoreDirectory(env) {
	const stateHome = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
	return join(stateHome, "dinkuskit", "inventory", "commands");
}

export function digest(text) {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function recordPath(env, commandId) {
	if (!COMMAND_ID.test(commandId)) throw usageError(`"${commandId}" is not a command ID.`, "invalid_command_id");
	return join(pendingStoreDirectory(env), `${commandId}.json`);
}

export async function saveRecord(env, record) {
	const directory = pendingStoreDirectory(env);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = recordPath(env, record.commandId);
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

export async function loadRecord(env, commandId) {
	try {
		return JSON.parse(await readFile(recordPath(env, commandId), "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

export async function closeRecord(env, record, terminal) {
	await saveRecord(env, { ...record, state: "closed", closedAt: new Date().toISOString(), terminal });
}
