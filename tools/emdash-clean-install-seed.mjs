import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Synthetic host administrator. This is not website consent and not a merchant session.
export const SYNTHETIC_USER_ID = "usr_synthetic_proof_admin";
export const SYNTHETIC_USER_EMAIL = "admin@proof.invalid";
export const PLUGIN_ID = "dinkus-inventory";

// Same algorithm as @emdash-cms/auth hashPrefixedToken: SHA-256 of the full
// prefixed token string, unpadded base64url. The raw token is never stored.
export function hashPrefixedToken(token) {
	return createHash("sha256").update(token).digest("base64url");
}

export function ensureSyntheticAdmin(databasePath, rawToken) {
	if (typeof databasePath !== "string" || databasePath.length === 0) {
		throw new Error("synthetic admin seed requires the baked database path");
	}
	if (typeof rawToken !== "string" || !rawToken.startsWith("ec_pat_")) {
		throw new Error("synthetic admin seed requires an ec_pat_ token");
	}
	const db = new DatabaseSync(databasePath);
	try {
		// Role 50 is EmDash Role.ADMIN, the role that holds plugins:manage.
		db.prepare(
			`
			INSERT INTO users (id, email, name, role, disabled, created_at, updated_at)
			VALUES (?, ?, ?, 50, 0, datetime('now'), datetime('now'))
			ON CONFLICT(id) DO UPDATE SET role = 50, disabled = 0
		`,
		).run(SYNTHETIC_USER_ID, SYNTHETIC_USER_EMAIL, "Proof Admin");
		db.prepare(
			`
			INSERT INTO _emdash_api_tokens (id, user_id, name, prefix, token_hash, scopes, created_at)
			VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
			ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, scopes = excluded.scopes
		`,
		).run(
			"tok_synthetic_proof",
			SYNTHETIC_USER_ID,
			"Proof Token",
			"ec_pat_",
			hashPrefixedToken(rawToken),
			JSON.stringify(["admin"]),
		);
		db.prepare(
			`
			INSERT INTO options (name, value, revision)
			VALUES ('emdash:setup_complete', 'true', 1)
			ON CONFLICT(name) DO UPDATE SET value = 'true'
		`,
		).run();
	} finally {
		db.close();
	}
	return { userId: SYNTHETIC_USER_ID, authorization: "synthetic_host_admin_not_website_consent" };
}
