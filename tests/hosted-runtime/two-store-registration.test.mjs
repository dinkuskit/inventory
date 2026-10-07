import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAccountAuthenticator } from "../../src/cloudflare/account-auth.ts";
import { createHostedInventoryHandler } from "../../src/cloudflare/hosted-worker.ts";

const origin = "https://inventory.invalid";
const issuer = "https://accounts.inventory.invalid";
async function authority() {
 const keys = await generateKeyPair("ES256");
 const jwk = { ...await exportJWK(keys.publicKey), alg: "ES256", kid: "synthetic-key" };
 const handler = createHostedInventoryHandler(env, createAccountAuthenticator({ issuer, jwksUrl: issuer + "/jwks", audience: "inventory" }, createLocalJWKSet({ keys: [jwk] })));
 return async (subject, siteId) => {
  const token = await new SignJWT({ site_id: siteId, scope: "inventory:admin" }).setProtectedHeader({ alg: "ES256", kid: "synthetic-key" }).setIssuer(issuer).setAudience("inventory").setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
  const request = (path, body, extraHeaders = {}) => handler(new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "X-Inventory-Site": siteId, "Content-Type": "application/json", ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { request, siteId };
 };
}
async function connect(shop, requestId = "connect") {
 const response = await shop.request("/v1/connect", { type: "create", requestId, locationName: "Shared Depot" });
 expect(response.status).toBe(200);
 return (await response.json()).operation;
}
async function register(shop, commandId = "register") {
 const response = await shop.request("/v1/skus/register", { commandId, sku: "HAT-BLACK", displayNameIfNew: "Black Hat" });
 expect(response.status).toBe(200);
 return response.json();
}
async function opening(shop, operation, sku, quantity, commandId) {
 const p = await shop.request("/v1/stock/opening/preview", { locationId: operation.locationId, skuId: sku.inventorySkuId, quantity: { value: quantity, unit: "each" }, reason: { code: "opening_balance", note: "Reviewed synthetic count" }, references: [] });
 expect(p.status).toBe(200);
 const preview = await p.json();
 const envelope = { confirmation: preview.confirmation.value, command: { schema: "dinkuskit.inventory.command/v1", commandId, type: "stock.opening_balance", context: preview.context, payload: { skuId: preview.effect.skuId, quantity: preview.effect.onHandDelta }, reason: preview.reason, references: preview.references, expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: preview.effect.balanceBefore.version }] } };
 const response = await shop.request("/v1/stock/opening/confirm", envelope);
 expect(response.status).toBe(200);
 return { envelope, result: await response.json() };
}
const stockPath = (sku, operation) => `/v1/stock?sku_id=${encodeURIComponent(sku.inventorySkuId)}&location_id=${encodeURIComponent(operation.locationId)}`;

describe("signed-identity two-store onboarding on real SQLite Durable Objects", () => {
 it("isolates overlapping SKU names, opening balances and receipts, and replays original commands", async () => {
  const customer = await authority();
  const alpha = await customer("customer_alpha", "site_alpha");
  const beta = await customer("customer_beta", "site_beta");
  const a = await connect(alpha), b = await connect(beta);
  expect(a.poolId).not.toBe(b.poolId);
  expect(await connect(alpha)).toEqual(a);
  const ar = await register(alpha), br = await register(beta);
  const as = ar.inventorySku, bs = br.inventorySku;
  expect(as.inventorySkuId).not.toBe(bs.inventorySkuId);
  expect(await register(alpha)).toEqual(ar);
  expect((await register(alpha, "register_existing")).inventorySku).toEqual(as);
  expect((await (await alpha.request("/v1/skus")).json()).skus).toEqual([{ ...as, unit: "each" }]);
  expect((await (await beta.request("/v1/skus")).json()).skus).toEqual([{ ...bs, unit: "each" }]);
  expect((await (await alpha.request(stockPath(as, a))).json()).balance.outcome).toBe("not_found");
  const before = await (await alpha.request("/v1/receipts")).json();
  expect(before.receipts.filter(r => r.type === "stock.opening_balance")).toHaveLength(0);
  const ao = await opening(alpha, a, as, "7", "open_alpha");
  const bo = await opening(beta, b, bs, "11", "open_beta");
  expect(ao.result.receipt.receiptId).not.toBe(bo.result.receipt.receiptId);
  expect(await (await alpha.request("/v1/stock/opening/confirm", ao.envelope)).json()).toEqual(ao.result);
  // A new handler request re-resolves the account/pool rather than relying on client state.
  const alphaReload = await customer("customer_alpha", "site_alpha");
  expect((await (await alphaReload.request(stockPath(as, a))).json()).balance.balance.onHand.value).toBe("7");
  expect((await (await beta.request(stockPath(bs, b))).json()).balance.balance.onHand.value).toBe("11");
  for (const [shop, own, foreign] of [[alpha, ao, bo], [beta, bo, ao]]) {
   const receipts = (await (await shop.request("/v1/receipts")).json()).receipts;
   expect(receipts.filter(r => r.type === "stock.opening_balance")).toHaveLength(1);
   expect(receipts.some(r => r.receiptId === own.result.receipt.receiptId)).toBe(true);
   expect(receipts.some(r => r.receiptId === foreign.result.receipt.receiptId)).toBe(false);
  }
  expect((await (await alpha.request(stockPath(bs, b))).json()).balance.outcome).toBe("not_found");
  expect((await (await alpha.request(`/v1/receipts?location_id=${encodeURIComponent(b.locationId)}`)).json()).receipts).toHaveLength(0);
  expect((await (await beta.request("/v1/operations")).json()).operations.some(op => op.operationId === a.operationId)).toBe(false);
  expect((await beta.request("/v1/stock/opening/confirm", ao.envelope)).status).toBe(403);
  expect((await beta.request("/v1/connect", { type: "reconnect", requestId: "foreign", operationId: a.operationId })).status).toBe(404);
  for (const field of ["accountId", "poolId", "siteId", "principal", "context"]) {
   expect((await alpha.request("/v1/skus/register", { commandId: "foreign_claim", sku: "HAT-RED", displayNameIfNew: "Red Hat", [field]: b.poolId })).status).toBe(400);
  }
  expect((await alpha.request("/v1/skus", undefined, { "X-Inventory-Site": beta.siteId })).status).toBe(401);
  const altered = await alpha.request("/v1/skus/register", { commandId: "register", sku: "HAT-RED", displayNameIfNew: "Red Hat" });
  expect(altered.status).toBe(409); expect((await altered.json()).code).toBe("command_id_conflict");
 });
 it("defaults same-account new stores to separate pools and permits only deliberate authorized joining", async () => {
  const customer = await authority();
  const first = await customer("same_customer", "same_site_a");
  const second = await customer("same_customer", "same_site_b");
  const joiner = await customer("same_customer", "same_site_c");
  const outsider = await customer("other_customer", "outside_site");
  const a = await connect(first), b = await connect(second);
  expect(a.poolId).not.toBe(b.poolId);
  const sku = (await register(first)).inventorySku;
  const joinInput = { type: "reconnect", requestId: "join_owned", operationId: a.operationId };
  const joined = await joiner.request("/v1/connect", joinInput);
  expect(joined.status).toBe(200); expect((await joined.json()).operation).toEqual(a);
  expect((await (await joiner.request("/v1/skus")).json()).skus).toEqual([{ ...sku, unit: "each" }]);
  expect((await (await joiner.request("/v1/connect", joinInput)).json()).operation).toEqual(a);
  expect((await outsider.request("/v1/connect", joinInput)).status).toBe(404);
  // A store that already has a separate pool cannot silently migrate or merge it.
  expect((await second.request("/v1/connect", joinInput)).status).toBe(409);
  expect((await (await second.request("/v1/status")).json()).operation.poolId).toBe(b.poolId);
 });
});
