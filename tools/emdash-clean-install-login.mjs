import { ensureSyntheticAdmin } from "./emdash-clean-install-seed.mjs";
import { SYNTHETIC_USER_ID } from "./emdash-clean-install-seed.mjs";

// Browser entry for a parent CUA. Sets the Astro session user id only.
// The raw API token is not read, printed, or placed in the redirect.
function runtimeEnv(name) {
	// Member access on process.env is inlined by Vite at build time. The
	// token and database path exist only in the host process after build.
	const env = process["env"];
	const value = env[name];
	return typeof value === "string" && value.length > 0 ? value : "";
}

export async function GET(context) {
	const databasePath = runtimeEnv("EMDASH_DATABASE_PATH");
	const rawToken = runtimeEnv("EMDASH_PROOF_ADMIN_TOKEN");
	if (!context.session) {
		return new Response("Sign-in needs an Astro session driver. Configure session.driver in astro.config.mjs.", {
			status: 500,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	if (typeof databasePath !== "string" || typeof rawToken !== "string") {
		return new Response("Synthetic session is not configured for this host.", {
			status: 500,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	ensureSyntheticAdmin(databasePath, rawToken);
	await context.session.set("user", { id: SYNTHETIC_USER_ID });
	return context.redirect("/_emdash/admin/plugins/dinkus-inventory/inventory");
}
