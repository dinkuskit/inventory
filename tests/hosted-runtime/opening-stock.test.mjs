import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createHostedInventoryHandler } from '../../src/cloudflare/hosted-worker.ts';
import { createCloudflareSqliteInventoryStore } from '../../src/storage/cloudflare-sqlite-inventory-store.ts';
import { createFixtureManagedSku } from '../helpers/managed-sku-fixture.mjs';

const origin = 'https://inventory.invalid';
const path = '/v1/stock/opening/';
async function setup(suffix) {
 const principal = { accountId: `acct_opening_${suffix}`, siteId: `site_opening_${suffix}` };
 const handler = createHostedInventoryHandler(env, async () => principal);
 const post = async (route, body) => handler(new Request(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
 const connected = await post('/v1/connect', { type: 'create', requestId: 'setup', locationName: 'Synthetic Depot' });
 const { operation } = await connected.json();
 const pool = env.INVENTORY_POOLS.getByName(operation.poolId);
 await runInDurableObject(pool, async (_, state) => {
  await createFixtureManagedSku(createCloudflareSqliteInventoryStore({ storage: state.storage, poolId: operation.poolId }), { poolId: operation.poolId, skuId: 'sku_synthetic' });
 });
 const input = { locationId: operation.locationId, skuId: 'sku_synthetic', quantity: { value: '7', unit: 'each' }, reason: { code: 'opening_balance', note: 'Reviewed synthetic count' }, references: [] };
 return { principal, handler, post, operation, pool, input };
}
function command(preview, id) {
 return { schema: 'dinkuskit.inventory.command/v1', commandId: id, type: 'stock.opening_balance', context: preview.context, payload: { skuId: preview.effect.skuId, quantity: preview.effect.onHandDelta }, reason: preview.reason, references: preview.references, expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: preview.effect.balanceBefore.version }] };
}
describe('hosted reviewed opening stock without seeded balances', () => {
 it('admits fresh registered identity, previews without movement, commits once, and replays after expiry', async () => {
  const x = await setup('success');
  const eligibility = await x.handler(new Request(origin + path + `eligibility?sku_id=sku_synthetic&location_id=${x.operation.locationId}`));
  expect(eligibility.status).toBe(200);
  const admitted = await eligibility.json();
  expect(admitted.balance).toBeNull(); expect(admitted.hasStockHistory).toBe(false);
  const before = await x.pool.schemaStatus();
  const p = await x.post(path + 'preview', x.input); expect(p.status).toBe(200);
  const preview = await p.json();
  expect(preview.effect.balanceBefore.onHand.value).toBe('0');
  const balance = await x.pool.readSkuLocationBalance({ poolId: x.operation.poolId, skuId: 'sku_synthetic', locationId: x.operation.locationId });
  expect(balance.outcome).toBe('not_found');
  expect(await x.pool.schemaStatus()).toEqual(before);
  const envelope = { confirmation: preview.confirmation.value, command: command(preview, 'cmd_initial') };
  const confirmed = await x.post(path + 'confirm', envelope); expect(confirmed.status).toBe(200);
  const result = await confirmed.json(); expect(result.outcome).toBe('committed');
  // Simulate normal passage beyond preview TTL in the disposable confirmation record.
  await runInDurableObject(x.pool, async (_, state) => { state.storage.sql.exec("UPDATE inventory_opening_balance_confirmations SET expires_at = '2000-01-01T00:00:00.000Z'"); });
  const replay = await x.post(path + 'confirm', envelope); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(result);
  const after = await x.pool.readSkuLocationBalance({ poolId: x.operation.poolId, skuId: 'sku_synthetic', locationId: x.operation.locationId });
  const historical = await x.handler(new Request(origin + path + `eligibility?sku_id=sku_synthetic&location_id=${x.operation.locationId}`));
  expect((await historical.json()).eligibility).toBe('history_exists');
  expect(after.balance.onHand.value).toBe('7'); expect(after.balance.version).toBe('1'); expect(after.balance.hasStockHistory).toBe(true);
  const history = await x.handler(new Request(origin + '/v1/receipts'));
  expect((await history.json()).receipts.filter(r => r.type === 'stock.opening_balance')).toHaveLength(1);
  expect((await x.post(path + 'preview', x.input)).status).toBe(409);
 });
 it('refuses unknown SKU, inactive/missing location, foreign contexts/accounts/sites and posted authority', async () => {
  const x = await setup('refusals');
  expect((await x.handler(new Request(origin + path + `eligibility?sku_id=unknown&location_id=${x.operation.locationId}`))).status).toBe(404);
  expect((await x.handler(new Request(origin + path + 'eligibility?sku_id=sku_synthetic&location_id=missing'))).status).toBe(409);
  expect((await x.post(path + 'preview', { ...x.input, poolId: 'foreign' })).status).toBe(400);
  expect((await x.post(path + 'preview', { ...x.input, quantity: { value: '-1', unit: 'each' } })).status).toBe(400);
  const p = await x.post(path + 'preview', x.input); const preview = await p.json();
  const c = command(preview, 'cmd_foreign');
  for (const field of ['siteId', 'poolId']) {
   expect((await x.post(path + 'confirm', { confirmation: preview.confirmation.value, command: { ...c, context: { ...c.context, [field]: 'foreign' } } })).status).toBe(403);
  }
  for (const principal of [{ ...x.principal, siteId: 'other_site' }, { ...x.principal, accountId: 'other_account' }]) {
   const foreign = createHostedInventoryHandler(env, async () => principal);
   expect((await foreign(new Request(origin + path + `eligibility?sku_id=sku_synthetic&location_id=${x.operation.locationId}`))).status).toBe(409);
  }
  const unauth = createHostedInventoryHandler(env, async () => { throw new Error('unauthorized'); });
  expect((await unauth(new Request(origin + path + 'eligibility'))).status).toBe(401);
 });
});
