import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const scripts = ["aggregate-stock-read", "checkout-inventory", "stock-adjustment", "stock-reservation"];

test("all real proof runners share lineage cleanup and close server stdin", async () => {
  for (const name of scripts) {
    const source = await readFile(join(root, `bin/prove-${name}-real`), "utf8");
    assert.match(source, /\. "\$repo_root\/scripts\/proof-runtime\.sh"/u, name);
    assert.match(source, /<\/dev\/null/u, name);
    assert.match(source, /cleanup\(\) \{\s*stop_proof_runtime/u, name);
    assert.doesNotMatch(source, /kill "\$proof_pid"|wait "\$proof_pid"/u, name);
    // Signal traps exit, letting EXIT cleanup run exactly once rather than
    // deleting storage and then continuing the proof after TERM/HUP/INT.
    assert.match(source, /trap 'exit 143' TERM/u, name);
    assert.doesNotMatch(source, /setsid|kill[^\n]*-"\$proof_pid"/u, name);
  }
});

for (const mode of ["stop-and-restart", "exit-failure", "signal"]) {
  test(`proof runtime cleanup: ${mode}`, { timeout: 10000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "inventory-proof-processes-"));
    let shell;
    const pids = async () => Promise.all((await readdir(directory)).filter(name => name.endsWith(".pid")).map(async name => Number(await readFile(join(directory, name), "utf8"))));
    t.after(async () => {
      shell?.kill("SIGKILL");
      for (const pid of await pids()) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      await rm(directory, { recursive: true, force: true });
    });
    const program = `
      set -eu
      . "$HELPER"
      proof_pid=""
      sibling=""
      cleanup() { stop_proof_runtime; if [ -n "$sibling" ]; then kill "$sibling" 2>/dev/null || true; wait "$sibling" 2>/dev/null || true; fi; }
      trap cleanup EXIT
      trap 'exit 143' TERM
      start() {
        "$NODE" "$TREE" 2 "$DIRECTORY" </dev/null &
        proof_pid=$!
        attempts=0
        while [ ! -f "$DIRECTORY/0.pid" ]; do
          attempts=$((attempts + 1)); [ "$attempts" -lt 200 ]; sleep 0.01
        done
      }
      sleep 60 &
      sibling=$!
      echo "$sibling" > "$DIRECTORY/sibling.pid"
      start
      case "$MODE" in
        stop-and-restart)
          stop_proof_runtime
          [ -z "$proof_pid" ]
          stop_proof_runtime
          kill -0 "$sibling"
          rm "$DIRECTORY/0.pid" "$DIRECTORY/1.pid" "$DIRECTORY/2.pid"
          start
          stop_proof_runtime
          kill -0 "$sibling"
          ;;
        exit-failure) exit 17 ;;
        signal) kill -TERM $$; exit 99 ;;
      esac
    `;
    shell = spawn("sh", ["-c", program], {
      env: { ...process.env, HELPER: join(root, "scripts/proof-runtime.sh"), NODE: process.execPath,
        TREE: join(root, "tests/helpers/proof-process-tree.mjs"), DIRECTORY: directory, MODE: mode },
      // Keep the parent's input pipe open: a runtime must not hold it or the
      // output pipes open after cleanup, and must remain in the runner's group.
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    shell.stderr.on("data", chunk => { stderr += chunk; });
    shell.stdout.resume();
    const result = await new Promise((resolve, reject) => {
      shell.once("error", reject);
      shell.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, mode === "exit-failure" ? 17 : mode === "signal" ? 143 : 0, stderr);
    const group = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
    for (const depth of [0, 1, 2]) {
      assert.equal((await readFile(join(directory, `${depth}.pgid`), "utf8")).trim(), group, "server escaped outer runner's process group");
    }
    for (const pid of await pids()) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `runtime descendant ${pid} survived cleanup`);
    }
  });
}
