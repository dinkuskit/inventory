// Test-host observation only. Never retain URLs, headers, bodies or raw errors.
const stages = new Set(["target_validation", "transport"]);
const names = new Set(["Error", "TypeError", "SsrfError"]);

export function classifyHostError(error) {
	const message = typeof error?.message === "string" ? error.message : "";
	if (error?.code === "SSRF_BLOCKED") {
		if (message.startsWith("Could not resolve hostname:")) return "dns_resolution_failed";
		if (message === "Hostname resolved to no addresses") return "dns_no_addresses";
		if (message === "Hostname resolves to a non-public IP address") return "dns_non_public_address";
		return "ssrf_blocked";
	}
	return "unclassified";
}

export function hostObservation(stage, error) {
	if (!stages.has(stage)) throw new Error("Unknown observer stage");
	return Object.freeze({
		stage,
		outcome: error ? "rejected" : "entered",
		errorClass: error ? (names.has(error.name) ? error.name : "Other") : null,
		category: error ? classifyHostError(error) : null,
	});
}

export function emitHostObservation(stage, error) {
	try {
		process.stdout.write(`HOST_OBSERVER ${JSON.stringify(hostObservation(stage, error))}\n`);
	} catch { /* Observation must never change the original operation. */ }
}
