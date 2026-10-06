/** Local component proof only: identity registration, never a seeded balance. */
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { InventoryPool as CanonicalPool, InventoryAccount, createHostedInventoryHandler, type HostedInventoryEnv } from '../src/cloudflare/hosted-worker.ts';
import { createAccountAuthenticator } from '../src/cloudflare/account-auth.ts';
import { createCloudflareSqliteInventoryStore } from '../src/storage/cloudflare-sqlite-inventory-store.ts';
import { createRegisterManagedSku } from '../src/features/managed-sku/index.ts';
export { InventoryAccount };
export class InventoryPool extends CanonicalPool {
 async registerSyntheticIdentity(poolId: string, siteId: string, skuId: string) {
  const store = createCloudflareSqliteInventoryStore({ storage: this.ctx.storage, poolId });
  return createRegisterManagedSku({ store, now: () => new Date(), createInventorySkuId: () => skuId })({
   schema: 'dinkuskit.inventory.command/v1', type: 'sku.register', commandId: 'cmd_identity_only',
   context: { poolId, siteId }, payload: { sku: 'SYNTHETIC-WIDGET', displayNameIfNew: 'Synthetic Widget', unit: 'each' }, references: [],
  }, { principal: { kind: 'system', id: 'synthetic-proof', surface: 'test-fixture' } });
 }
}
export default {
 async fetch(request: Request, env: HostedInventoryEnv & { PROOF_JWKS: string }) {
  const authenticate = createAccountAuthenticator({ issuer: 'https://accounts.dinkuskit.invalid', jwksUrl: 'https://accounts.dinkuskit.invalid/jwks', audience: 'inventory' }, createLocalJWKSet(JSON.parse(env.PROOF_JWKS) as JSONWebKeySet));
  return createHostedInventoryHandler(env, authenticate)(request);
 },
};
