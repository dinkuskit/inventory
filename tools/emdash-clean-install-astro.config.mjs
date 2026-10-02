import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";
import { local } from "emdash/astro";
import inventoryPlugin from "@dinkuskit/emdash-inventory";
import { CLEAN_INSTALL_HOST_PORT } from "./emdash-clean-install-ports.mjs";

// astro build evaluates this module once and bakes database.config.url into
// the server bundle. A later EMDASH_DATABASE_URL does not retarget that build.
const databaseUrl = process.env.EMDASH_DATABASE_URL;
const storageDirectory = process.env.EMDASH_STORAGE_DIR;
if (typeof databaseUrl !== "string" || !databaseUrl.startsWith("file:/")) {
	throw new Error("EMDASH_DATABASE_URL must be an absolute file: URL at build");
}
if (typeof storageDirectory !== "string" || storageDirectory.length === 0) {
	throw new Error("EMDASH_STORAGE_DIR is required at build");
}

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	session: {
		cookie: {
			name: "astro-session",
			sameSite: "lax",
			httpOnly: true,
			secure: false,
			path: "/",
		},
	},
	integrations: [
		{
			name: "inventory-synthetic-proof-login",
			hooks: {
				"astro:config:setup": ({ injectRoute }) => injectRoute({
					pattern: "/_proof/login",
					entrypoint: new URL("./emdash-clean-install-login.mjs", import.meta.url).pathname,
				}),
			},
		},
		react(),
		emdash({
			database: sqlite({ url: databaseUrl }),
			storage: local({
				directory: storageDirectory,
				baseUrl: "/_emdash/api/media/file",
			}),
			sandboxed: [inventoryPlugin],
			sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox",
		}),
	],
	server: {
		port: CLEAN_INSTALL_HOST_PORT,
		host: "127.0.0.1",
	},
});
