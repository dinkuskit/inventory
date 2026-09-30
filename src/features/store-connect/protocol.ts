import { z } from "zod";

export const STORE_CONNECT_CLIENT_ID = "dinkus-inventory-emdash";
export const STORE_CONNECT_SERVICE = "inventory";
export const STORE_CONNECT_MAX_LIFETIME_SECONDS = 600;
export const STORE_CONNECT_PROOF_VERSION = 1;
export const STORE_CONNECT_CALLBACK_PATH = "/_emdash/admin/plugins/dinkus-inventory/inventory";
export const STORE_CONNECT_PROOF_PATH = "/_emdash/api/plugins/dinkus-inventory/store-proof";
export const STORE_CONNECT_VERIFICATION_PATH = "/account/connect";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class StoreConnectError extends Error {
	readonly code:
		| "invalid_site_origin"
		| "unbound_administrator"
		| "wrong_originating_admin"
		| "connection_in_progress"
		| "challenge_expired"
		| "proof_unavailable"
		| "unexpected_website_response";
	constructor(code: StoreConnectError["code"]) {
		super(code);
		this.code = code;
	}
}

export const proofReceiptSchema = z.object({
	version: z.literal(STORE_CONNECT_PROOF_VERSION),
	connection_id: z.string().trim().min(1).max(200),
	challenge: z.string().trim().min(1).max(200),
	client_id: z.literal(STORE_CONNECT_CLIENT_ID),
	service: z.literal(STORE_CONNECT_SERVICE),
	site_id: z.string().trim().min(1).max(200),
	site_origin: z.string().url(),
	callback_uri: z.string().url(),
	code_challenge: z.string().trim().min(1).max(200),
	expires_at: z.number().int().positive(),
}).strict();
export type ProofReceipt = z.infer<typeof proofReceiptSchema>;

export const startRequestSchema = z.object({
	client_id: z.literal(STORE_CONNECT_CLIENT_ID),
	service: z.literal(STORE_CONNECT_SERVICE),
	site_id: z.string().trim().min(1).max(200),
	site_origin: z.string().url(),
	callback_uri: z.string().url(),
	code_challenge: z.string().trim().min(1).max(200),
	code_challenge_method: z.literal("S256"),
}).strict();
export type StoreConnectStartRequest = z.infer<typeof startRequestSchema>;

export const startResponseSchema = z.object({
	connection_id: z.string().trim().min(1).max(200),
	challenge: z.string().trim().min(1).max(200),
	verification_uri: z.url(),
	expires_in: z.number().int().positive().max(STORE_CONNECT_MAX_LIFETIME_SECONDS),
	expires_at: z.number().int().positive(),
	interval: z.number().int().positive().max(60),
}).strict();
export type StoreConnectStartResponse = z.infer<typeof startResponseSchema>;

export const tokenRequestSchema = z.object({
	client_id: z.literal(STORE_CONNECT_CLIENT_ID),
	connection_id: z.string().trim().min(1).max(200),
	code_verifier: z.string().trim().min(43).max(128),
}).strict();

export const tokenPendingSchema = z.object({
	error: z.literal("authorization_pending"),
	interval: z.number().int().positive().max(60).optional(),
}).strict();

export const tokenSuccessSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.literal("Bearer"),
	expires_in: z.number().int().positive(),
	site_id: z.string().trim().min(1).max(200),
}).strict();

export const tokenFailureSchema = z.object({
	error: z.enum([
		"access_denied",
		"expired_token",
		"invalid_grant",
		"slow_down",
		"already_redeemed",
		"originating_admin_mismatch",
		"ownership_conflict",
		"proof_mismatch",
	]),
}).strict();

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function canonicalizeSiteOrigin(raw: string, options: { allowLoopback?: boolean } = {}): string {
	let parsed: URL;
	try { parsed = new URL(raw); } catch { throw new StoreConnectError("invalid_site_origin"); }
	if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new StoreConnectError("invalid_site_origin");
	const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
	if (parsed.protocol === "https:") return parsed.origin;
	if (parsed.protocol === "http:" && loopback && options.allowLoopback) return parsed.origin;
	throw new StoreConnectError("invalid_site_origin");
}

export function approvedCallbackUri(siteOrigin: string): string {
	return `${siteOrigin}${STORE_CONNECT_CALLBACK_PATH}`;
}

export function proofReceiptUrl(siteOrigin: string, connectionId: string): string {
	return `${siteOrigin}${STORE_CONNECT_PROOF_PATH}?connection_id=${encodeURIComponent(connectionId)}`;
}

export function requireBoundAdministrator(user: { id?: string } | null | undefined): string {
	const id = user?.id?.trim();
	if (!id || id.length > 200) throw new StoreConnectError("unbound_administrator");
	return id;
}

export function requireOriginatingAdministrator(initiatingAdminId: string, callerId: string): void {
	if (initiatingAdminId !== callerId) throw new StoreConnectError("wrong_originating_admin");
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const verifier = bytesToBase64Url(bytes);
	return { verifier, challenge: await s256Challenge(verifier) };
}

export async function s256Challenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return bytesToBase64Url(new Uint8Array(digest));
}

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
	return await s256Challenge(verifier) === challenge;
}

export function createProofReceipt(input: {
	connectionId: string;
	challenge: string;
	siteId: string;
	siteOrigin: string;
	callbackUri: string;
	codeChallenge: string;
	expiresAt: number;
}): ProofReceipt {
	return proofReceiptSchema.parse({
		version: STORE_CONNECT_PROOF_VERSION,
		connection_id: input.connectionId,
		challenge: input.challenge,
		client_id: STORE_CONNECT_CLIENT_ID,
		service: STORE_CONNECT_SERVICE,
		site_id: input.siteId,
		site_origin: input.siteOrigin,
		callback_uri: input.callbackUri,
		code_challenge: input.codeChallenge,
		expires_at: input.expiresAt,
	});
}

export function publicProofFor(receipt: ProofReceipt, connectionId: string, now: number): ProofReceipt | null {
	if (receipt.connection_id !== connectionId || receipt.expires_at <= now) return null;
	return proofReceiptSchema.parse(receipt);
}

export function assertVerificationUri(verificationUri: string, websiteOrigin: string, connectionId: string): void {
	let parsed: URL;
	try { parsed = new URL(verificationUri); } catch { throw new StoreConnectError("unexpected_website_response"); }
	if (parsed.username || parsed.password || parsed.hash) throw new StoreConnectError("unexpected_website_response");
	if (parsed.origin !== websiteOrigin) throw new StoreConnectError("unexpected_website_response");
	if (parsed.pathname !== STORE_CONNECT_VERIFICATION_PATH) throw new StoreConnectError("unexpected_website_response");
	const raw = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
	const keys = raw.split("&").filter(Boolean).map(pair => {
		const key = pair.split("=")[0] ?? "";
		try { return decodeURIComponent(key); } catch { return key; }
	});
	if (keys.length !== 1 || keys[0] !== "connection_id") throw new StoreConnectError("unexpected_website_response");
	if (parsed.searchParams.get("connection_id") !== connectionId) throw new StoreConnectError("unexpected_website_response");
}

export function assertStartResponseBounds(response: StoreConnectStartResponse, now: number): number {
	if (response.expires_in > STORE_CONNECT_MAX_LIFETIME_SECONDS) throw new StoreConnectError("unexpected_website_response");
	if (response.expires_at <= now) throw new StoreConnectError("unexpected_website_response");
	if (response.expires_at > now + STORE_CONNECT_MAX_LIFETIME_SECONDS * 1000) throw new StoreConnectError("unexpected_website_response");
	return response.expires_at;
}

export const challengeSessionSchema = z.object({
	phase: z.literal("challenge"),
	connectionId: z.string().min(1),
	challenge: z.string().min(1),
	verificationUri: z.string().url(),
	expiresAt: z.number().int().positive(),
	interval: z.number().int().positive(),
	nextPoll: z.number().int().nonnegative(),
	codeVerifier: z.string().min(43).max(128),
	initiatingAdminId: z.string().min(1).max(200),
	siteId: z.string().min(1).max(200),
	siteOrigin: z.string().url(),
	callbackUri: z.string().url(),
	codeChallenge: z.string().min(1),
}).strict();

export const tokenSessionSchema = z.object({
	phase: z.literal("token"),
	token: z.string().min(1),
	expiresAt: z.number().int().positive(),
}).strict();

export const storeConnectSessionSchema = z.discriminatedUnion("phase", [challengeSessionSchema, tokenSessionSchema]);
export type StoreConnectSession = z.infer<typeof storeConnectSessionSchema>;

// Current-main OAuth device sign-in shape. Store Connect does not resume it;
// the plugin must clear it before parsing the challenge/token union.
export const legacyDeviceSessionSchema = z.object({
	phase: z.literal("device"),
	deviceCode: z.string(),
	userCode: z.string(),
	verificationUri: z.string().url(),
	expiresAt: z.number(),
	interval: z.number(),
	nextPoll: z.number(),
});

export type StoredConnectionSession =
	| { kind: "current"; session: StoreConnectSession }
	| { kind: "legacy-device" }
	| { kind: "invalid" };

export function interpretStoredConnectionSession(raw: unknown): StoredConnectionSession {
	const current = storeConnectSessionSchema.safeParse(raw);
	if (current.success) return { kind: "current", session: current.data };
	if (legacyDeviceSessionSchema.safeParse(raw).success) return { kind: "legacy-device" };
	return { kind: "invalid" };
}

export function resumeActiveChallenge(session: StoreConnectSession | null, adminId: string, now: number): StoreConnectSession | null {
	if (!session || session.phase !== "challenge" || session.expiresAt <= now) return null;
	requireOriginatingAdministrator(session.initiatingAdminId, adminId);
	return session;
}
