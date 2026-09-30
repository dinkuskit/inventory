import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
// Standalone host supplies the same empty site config Astro would generate.
// Runtime, route policy, Block Kit and sandbox runner are the published packages.
registerHooks({ resolve(specifier, context, nextResolve) {
	if (specifier === "virtual:emdash/config") return { url: "data:text/javascript,export default {}", shortCircuit: true };
	return nextResolve(specifier, context);
}, load(url, context, nextLoad) {
	if (url.startsWith("file:") && url.includes("/node_modules/emdash/dist/") && url.endsWith(".mjs")) {
		const source = readFileSync(new URL(url), "utf8");
		if (source.includes("import.meta.env")) return { format: "module", source: source.replaceAll("import.meta.env", "({DEV:false,PROD:true,SSR:true,BASE_URL:'/'})"), shortCircuit: true };
	}
	return nextLoad(url, context);
} });
await import("./hosted-onboarding-proof.mjs");
