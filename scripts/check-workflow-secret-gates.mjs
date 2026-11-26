import { resolve } from "node:path";

import { auditWorkflowSecretGates } from "./workflow-secret-gate-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const findings = await auditWorkflowSecretGates(root);

if (findings.length > 0) {
	console.error(findings.join("\n"));
	process.exit(1);
}

console.log("workflow_secret_gates=clean");
