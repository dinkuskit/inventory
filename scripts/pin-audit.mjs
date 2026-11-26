import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { auditRepositoryPins, writePinEvidence } from "./pin-audit-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
	options: { base: { type: "string" }, evidence: { type: "string" } },
});

if (values.evidence) {
	const report = await writePinEvidence({
		root,
		base: /^0*$/u.test(values.base ?? "") ? undefined : values.base,
		directory: values.evidence,
	});
	console.log(report.join("\n"));
}

const findings = await auditRepositoryPins(root);

if (findings.length > 0) {
	console.error(findings.join("\n"));
	process.exit(1);
}

console.log("inventory_pins=reviewed");
