// Owned Node runtime IPC only. Protocol bodies remain in memory and are never
// logged or written. The surviving parent invokes the qualified Website API.
import { randomUUID } from "node:crypto";

export function createMerchantIpcTransport(channel = process, timeoutMs = 5000) {
	if (typeof channel.send !== "function" || !channel.connected || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("Merchant parent transport unavailable");
	return input => new Promise((resolve, reject) => {
		const request = new Request(input);
		const url = new URL(request.url);
		if (url.origin !== "https://dinkuskit.com" || url.username || url.password || url.search || url.hash || request.method !== "POST" || !["/api/store-connections", "/api/store-connections/token"].includes(url.pathname)) return reject(new Error("Merchant parent route rejected"));
		const id = randomUUID();
		let finished = false, sent = false, reader;
		const cleanup = () => {
			clearTimeout(timer);
			channel.off("message", response);
			channel.off("disconnect", fail);
			request.signal.removeEventListener("abort", fail);
		};
		const fail = () => {
			if (finished) return;
			finished = true;
			cleanup();
			void reader?.cancel().catch(() => {});
			if (sent && channel.connected) channel.send({ type: "merchant_fetch_cancel", id }, () => {});
			reject(new Error("Merchant parent transport unavailable"));
		};
		const response = message => {
			if (message?.type !== "merchant_fetch_response" || message.id !== id || finished) return;
			if (message.error || !Number.isInteger(message.status) || message.status < 200 || message.status > 599 || !(message.body instanceof Uint8Array) || message.body.byteLength > 8192 || !Array.isArray(message.headers)) return fail();
			try {
				const result = new Response([204, 205, 304].includes(message.status) ? null : message.body, { status: message.status, headers: message.headers });
				finished = true;
				cleanup();
				resolve(result);
			} catch { fail(); }
		};
		const timer = setTimeout(fail, timeoutMs);
		channel.on("message", response);
		channel.once("disconnect", fail);
		request.signal.addEventListener("abort", fail, { once: true });
		if (request.signal.aborted) return fail();
		void (async () => {
			reader = request.body?.getReader();
			if (!reader) return fail();
			const chunks = [];
			let length = 0;
			while (!finished) {
				const next = await reader.read();
				if (next.done) break;
				length += next.value.byteLength;
				if (length > 8192) return fail();
				chunks.push(next.value);
			}
			if (finished || !channel.connected) return;
			const body = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
			sent = true;
			channel.send({ type: "merchant_fetch_request", id, url: request.url, method: request.method, headers: [...request.headers], body }, error => { if (error) fail(); });
		})().catch(fail);
	});
}
