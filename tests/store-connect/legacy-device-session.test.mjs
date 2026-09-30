import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../../plugins/emdash-inventory/src/plugin.ts";

// Exact current-main OAuth device session persisted in connectionSession.
const CURRENT_MAIN_DEVICE_SESSION = {
	phase: "device",
	deviceCode: "dev-code-1",
	userCode: "WDJB-MJHT",
	verificationUri: "https://accounts.dinkuskit.invalid/device",
	expiresAt: 9_000_000_000_000,
	interval: 5000,
	nextPoll: 1000,
};

function createSettings(initial) {
	const items = new Map();
	let rev = 0;
	if (initial) {
		items.set("connectionSession", { value: JSON.stringify(initial), revision: `r${++rev}` });
	}
	return {
		async get(key) {
			return items.get(key)?.value ?? null;
		},
		async getVersioned(key) {
			return items.get(key) ?? null;
		},
		async compareAndSet(key, revision, value) {
			const cur = items.get(key);
			if ((cur?.revision ?? null) !== revision) return { applied: false };
			const next = `r${++rev}`;
			items.set(key, { value, revision: next });
			return { applied: true, revision: next };
		},
		async compareAndDelete(key, revision) {
			const cur = items.get(key);
			if (!cur || cur.revision !== revision) return { applied: false };
			items.delete(key);
			return { applied: true };
		},
		snapshot() {
			const stored = items.get("connectionSession");
			return stored ? JSON.parse(stored.value) : null;
		},
	};
}

function createKv() {
	const items = new Map();
	return {
		async get(key) {
			return items.get(key)?.value ?? null;
		},
		async getVersioned(key) {
			return items.get(key) ?? null;
		},
		async compareAndSet(key, revision, value) {
			const cur = items.get(key);
			if ((cur?.revision ?? null) !== revision) return { applied: false };
			items.set(key, { value, revision: "r1" });
			return { applied: true, revision: "r1" };
		},
		async compareAndDelete() {
			return { applied: false };
		},
	};
}

test("page load clears a current-main device session and shows Connect", async () => {
	const settings = createSettings(CURRENT_MAIN_DEVICE_SESSION);
	const ctx = {
		site: { url: "https://shop.example.com" },
		url(path) {
			return `https://shop.example.com${path}`;
		},
		http: {
			fetch: async () => {
				throw new Error("network must not run for leftover device clearance");
			},
		},
		settings,
		kv: createKv(),
	};
	const result = await plugin.routes.admin.handler(
		{ input: { type: "page_load", page: "/inventory" }, user: { id: "admin-1" } },
		ctx,
	);
	const text = JSON.stringify(result);
	assert.equal(settings.snapshot(), null);
	assert.match(text, /Connect Inventory/);
	assert.doesNotMatch(text, /Connection could not be confirmed/);
	assert.doesNotMatch(text, /WDJB-MJHT/);
});
