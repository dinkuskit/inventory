import { resolve } from "node:path";

import { auditInventoryArchitecture } from "./architecture-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const findings = await auditInventoryArchitecture(root);

if (findings.length > 0) {
	console.error(findings.join("\n"));
	process.exit(1);
}

console.log("inventory_architecture=clean");
