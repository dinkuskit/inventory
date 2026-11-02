# Sourced by local real-runtime proof runners. Keep the server in the caller's
# process group so an outer test runner can still tear down the whole run.
# npm/Wrangler wrappers do not necessarily forward TERM to their descendants.
proof_terminate_tree() (
	for child_pid in $(pgrep -P "$1" 2>/dev/null || true); do
		proof_terminate_tree "$child_pid"
	done
	kill "$1" 2>/dev/null || true
)

stop_proof_runtime() {
	if [ -n "${proof_pid:-}" ]; then
		proof_terminate_tree "$proof_pid"
		wait "$proof_pid" 2>/dev/null || true
		proof_pid=""
	fi
}
