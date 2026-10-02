// Local merchant proof only. The website owner must start and qualify its
// actual runner before this adapter is installed in the EmDash host process.
// Host allowedHosts, DNS and SSRF validation precede this httpFetch dispatch.
const website = "http://127.0.0.1:47632";
const paths = new Set(["/api/store-connections", "/api/store-connections/token"]);

export function createMerchantLoopbackTransport({ fetch: dispatch = globalThis.fetch } = {}) {
	if (typeof dispatch !== "function") throw new Error("Merchant loopback dispatch unavailable");
	return async input => {
		const request = new Request(input);
		const url = new URL(request.url);
		if (url.origin !== "https://dinkuskit.com" || url.username || url.password || url.search || url.hash || request.method !== "POST" || !paths.has(url.pathname)) {
			throw new Error("Merchant loopback route rejected");
		}
		const reader = request.body?.getReader();
		if (!reader) throw new Error("Merchant loopback body rejected");
		const chunks = [];
		let bytes = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 8192) { await reader.cancel(); throw new Error("Merchant loopback body rejected"); }
			chunks.push(chunk.value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
		// Keep the protocol body/headers intact and never follow or rewrite a
		// redirect. The plugin validates the original verification URI itself.
		return dispatch(`${website}${url.pathname}`, {
			method: request.method, headers: request.headers, body,
			redirect: "manual", signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
		});
	};
}
