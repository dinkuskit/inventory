// Non-forwarding npm -> Wrangler -> workerd analogue for runner lifecycle tests.
// Each wrapper waits for its own child to exit, but never relays SIGTERM to it.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const depth = Number(process.argv[2]);
const directory = process.argv[3];
const child = depth > 0 ? spawn(process.execPath, [import.meta.filename, String(depth - 1), directory], { stdio: "inherit" }) : null;
assert.equal(readFileSync(0).length, 0, "background server stdin must be EOF");
writeFileSync(join(directory, `${depth}.pgid`), execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
writeFileSync(join(directory, `${depth}.pid`), String(process.pid));
process.on("SIGTERM", () => {
  if (child && child.exitCode === null) child.once("exit", () => process.exit(0));
  else process.exit(0);
});
setInterval(() => {}, 1000);
