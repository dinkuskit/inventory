import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createMerchantIpcTransport } from "../../tools/emdash-merchant-ipc-transport.mjs";

function channel(send) {
	const output = new EventEmitter();
	output.connected = true;
	output.send = message => send(message, output);
	return output;
}
const target = "https://dinkuskit.com/api/store-connections";

test("owned runtime IPC preserves protocol bytes and bounded response without logging bodies", async () => {
	let captured;
	const parent = channel((message, self) => {
		captured = message;
		queueMicrotask(() => self.emit("message", { type: "merchant_fetch_response", id: message.id, status: 202, headers: [["content-type", "application/json"]], body: new TextEncoder().encode('{ "test": true }') }));
	});
	const dispatch = createMerchantIpcTransport(parent);
	const response = await dispatch(new Request(target, { method: "POST", headers: { "x-proof-marker": "test" }, body: '{ "test-only": true }' }));
	assert.equal(captured.url, target);
	assert.equal(captured.method, "POST");
	assert.equal(new Headers(captured.headers).get("x-proof-marker"), "test");
	assert.equal(new TextDecoder().decode(captured.body), '{ "test-only": true }');
	assert.equal(response.status, 202);
	assert.equal(await response.text(), '{ "test": true }');
	assert.equal(parent.listenerCount("message"), 0);
});

test("owned runtime IPC refuses widening and cannot send a body after its deadline", async () => {
	let calls = 0;
	const parent = channel(() => { calls++; });
	const dispatch = createMerchantIpcTransport(parent, 10);
	await assert.rejects(dispatch(new Request("https://foreign.invalid/api/store-connections", { method: "POST", body: "{}" })), /route rejected/);
	let cancelled = false;
	const body = new ReadableStream({
		start(controller) { setTimeout(() => { if (!cancelled) { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } }, 30); },
		cancel() { cancelled = true; },
	});
	await assert.rejects(dispatch(new Request(target, { method: "POST", body, duplex: "half" })), /transport unavailable/);
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(calls, 0);
	assert.equal(cancelled, true);
	assert.equal(parent.listenerCount("message"), 0);
});

test("owned runtime IPC cancels an in-flight dispatch when the caller aborts", async () => {
	const sent = [];
	const parent = channel(message => { sent.push(message.type); });
	const controller = new AbortController();
	const result = createMerchantIpcTransport(parent)(new Request(target, { method: "POST", body: "{}", signal: controller.signal }));
	await new Promise(resolve => setImmediate(resolve));
	controller.abort();
	await assert.rejects(result, /transport unavailable/);
	assert.deepEqual(sent, ["merchant_fetch_request", "merchant_fetch_cancel"]);
	assert.equal(parent.listenerCount("message"), 0);
});
