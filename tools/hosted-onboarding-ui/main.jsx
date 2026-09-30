import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BlockRenderer } from "@emdash-cms/blocks";
import "./proof.css";
function App() {
	const [blocks, setBlocks] = useState([]);
	const [busy, setBusy] = useState(false);
	async function invoke(interaction = { type: "page_load", page: "/inventory" }) { setBusy(true); try { const response = await fetch("/proof-api", { method: "POST", body: JSON.stringify(interaction) }); const result = await response.json(); setBlocks(result.blocks ?? []); } finally { setBusy(false); } }
	useEffect(() => { invoke(); }, []);
	return <main><aside><b>EmDash 1.0.1</b><p>Sandboxed plugin proof</p><nav>Inventory</nav></aside><article><div className="fixture">LOCAL PROOF • Synthetic identity • Local SQLite Durable Objects</div><p>This harness uses EmDash’s actual Block Kit renderer, private route dispatcher and workerd sandbox. It is not a Registry install or real account login.</p><section aria-busy={busy}><BlockRenderer blocks={blocks} onAction={invoke} resolveLinkTarget={target => target.kind === "external" ? "/activate" : null} /></section><button className="fixture-button" onClick={async () => { await fetch("/proof-api/approve", { method: "POST" }); alert("Synthetic account approved. Return to Inventory and check sign-in."); }}>Proof fixture: approve synthetic account</button></article></main>;
}
createRoot(document.getElementById("root")).render(<App />);
