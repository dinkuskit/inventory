import { bootstrapCleanInstall } from '../../../tools/emdash-clean-install-bootstrap.mjs';
import { resolve } from 'node:path';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash,randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
if (!process.env.EMDASH_MIGRATION_PROOF_RUN_DIR) throw new Error('An owned synthetic proof run directory is required');
registerHooks({resolve(s,c,n){if(s==='virtual:emdash/config')return {url:'data:text/javascript,export default {}',shortCircuit:true};return n(s,c);},load(u,c,n){if(u.includes('/node_modules/emdash/dist/')&&u.endsWith('.mjs')){const source=readFileSync(new URL(u),'utf8');if(source.includes('import.meta.env'))return {format:'module',source:source.replaceAll('import.meta.env',"({DEV:false,PROD:true,SSR:true,BASE_URL:'/'})"),shortCircuit:true};}return n(u,c);}});
const run=resolve(process.env.EMDASH_MIGRATION_PROOF_RUN_DIR),root=resolve(import.meta.dirname,'../../..'),databasePath=resolve(run,'migration-state/data.db'),storageDir=resolve(run,'migration-state/storage');
for(const dir of ['migration-baseline-logs','migration-upgrade-logs'])mkdirSync(resolve(run,dir),{recursive:true});
const baseline=bootstrapCleanInstall({repoRoot:root,siteDir:resolve(run,'migration-baseline-host'),runDir:run,databasePath,storageDir,logDir:resolve(run,'migration-baseline-logs')});
assert.equal(baseline.appliedCount,88);
const {EmDashRuntime}=await import(new URL('file:'+resolve(run,'migration-baseline-host/node_modules/emdash/dist/plugin-test-runtime.mjs')));
const {createSettingsAccess,OptionsRepository}=await import(new URL('file:'+resolve(run,'migration-baseline-host/node_modules/emdash/dist/index.mjs')));
const {sqlite}=await import(new URL('file:'+resolve(run,'migration-baseline-host/node_modules/emdash/dist/db/index.mjs')));
const {createDialect}=await import(new URL('file:'+resolve(run,'migration-baseline-host/node_modules/emdash/dist/db/sqlite.mjs')));
process.env.EMDASH_ENCRYPTION_KEY='emdash_enc_v1_'+randomBytes(32).toString('base64url');
const runtime=await EmDashRuntime.create({config:{database:sqlite({url:`file:${databasePath}`})},plugins:[],createDialect,createStorage:null,sandboxEnabled:false,sandboxedPluginEntries:[],createSandboxRunner:null});
try{
 const options=new OptionsRepository(runtime.db);await options.set('emdash:site_title','Synthetic migration site');
 const settings=createSettingsAccess(options,'dinkus-inventory',{connectionSession:{type:'secret',label:'Synthetic migration secret'}});await settings.set('connectionSession','synthetic encrypted state marker');
 const stamp=new Date().toISOString();await runtime.db.insertInto('_plugin_storage').values({plugin_id:'dinkus-inventory',collection:'__kv',id:'state:migration-proof',data:JSON.stringify({synthetic:true,marker:'retained-from-1.0.1'}),revision:'baseline-state',created_at:stamp,updated_at:stamp}).execute();
}finally{await runtime.shutdown();await runtime.db.destroy();}
function snapshot(){const db=new DatabaseSync(databasePath,{readOnly:true});try{const rows={cms:db.prepare("SELECT value,revision FROM options WHERE name='emdash:site_title'").get(),settings:db.prepare("SELECT name,value,revision FROM options WHERE name LIKE 'plugin:dinkus-inventory:%'").all(),kv:db.prepare("SELECT plugin_id,collection,id,data,revision FROM _plugin_storage WHERE plugin_id='dinkus-inventory'").all()};return {sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),cmsRows:rows.cms?1:0,settingsRows:rows.settings.length,kvRows:rows.kv.length};}finally{db.close();}}
const before=snapshot();assert.equal(before.cmsRows,1);assert.equal(before.settingsRows,1);assert.equal(before.kvRows,1);
const upgraded=bootstrapCleanInstall({repoRoot:root,siteDir:resolve(run,'migration-upgrade-host'),runDir:run,databasePath,storageDir,logDir:resolve(run,'migration-upgrade-logs')});
assert.equal(upgraded.pendingBefore,2);assert.equal(upgraded.appliedCount,90);assert.equal(upgraded.pendingAfter,0);assert.equal(upgraded.fingerprint,baseline.fingerprint);const after=snapshot();assert.deepEqual(after,before);
const proof={qualification:'actual_1.0.1_to_1.2.0_config_migration_with_synthetic_state',baseline:{version:'1.0.1',applied:baseline.appliedCount},upgrade:{version:'1.2.0',pendingBefore:upgraded.pendingBefore,applied:upgraded.appliedCount,pendingAfter:upgraded.pendingAfter},sameDatabaseFingerprint:true,preservedState:after,reseed:false,oldProofDatabasesTouched:false};writeFileSync(resolve(run,'MIGRATION-STATE-PROOF.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
