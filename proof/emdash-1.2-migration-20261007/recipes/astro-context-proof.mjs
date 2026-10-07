import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ensureSyntheticAdmin, hashPrefixedToken } from '../../../tools/emdash-clean-install-seed.mjs';
if (!process.env.EMDASH_MIGRATION_PROOF_RUN_DIR) throw new Error('An owned synthetic proof run directory is required');
const run=resolve(process.env.EMDASH_MIGRATION_PROOF_RUN_DIR), site=resolve(run,'astro-install'), dbPath=resolve(run,'astro-state/data.db');
const origin='http://127.0.0.1:47631';
const token=`ec_pat_${randomBytes(32).toString('base64url')}`, editorToken=`ec_pat_${randomBytes(32).toString('base64url')}`;
const encryption=`emdash_enc_v1_${randomBytes(32).toString('base64url')}`;
const secret=JSON.stringify({phase:'token',token:randomBytes(32).toString('base64url'),expiresAt:Date.now()+86400000});
ensureSyntheticAdmin(dbPath,token);
const db=new DatabaseSync(dbPath);
db.prepare("INSERT INTO users(id,email,name,role,disabled,created_at,updated_at) VALUES('usr_synthetic_editor','editor@proof.invalid','Proof Editor',20,0,datetime('now'),datetime('now')) ON CONFLICT(id) DO NOTHING").run();
db.prepare("INSERT INTO _emdash_api_tokens(id,user_id,name,prefix,token_hash,scopes,created_at) VALUES('tok_synthetic_editor','usr_synthetic_editor','Proof editor','ec_pat_',?,'[\"admin\"]',datetime('now')) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash").run(hashPrefixedToken(editorToken));
db.prepare("INSERT INTO options(name,value,revision) VALUES('emdash:migration-proof',?,1) ON CONFLICT(name) DO NOTHING").run(JSON.stringify({synthetic:true,marker:'retained-cms-state'}));
db.prepare("INSERT INTO _plugin_storage(plugin_id,collection,id,data,revision,created_at,updated_at) VALUES('dinkus-inventory','__kv','state:migration-proof',?,'migration-proof',datetime('now'),datetime('now')) ON CONFLICT(plugin_id,collection,id) DO NOTHING").run(JSON.stringify({synthetic:true,marker:'retained-plugin-kv'}));
function stamp(){return {cms:db.prepare("SELECT value FROM options WHERE name='emdash:migration-proof'").get().value,kv:db.prepare("SELECT data,revision FROM _plugin_storage WHERE id='state:migration-proof' AND plugin_id='dinkus-inventory'").get(),settings:db.prepare("SELECT name,revision FROM options WHERE name LIKE 'plugin:dinkus-inventory:%'").all()};}
let child;
async function start(){
 child=spawn(process.execPath,['--input-type=module','-e',`import http from 'node:http';process.env.ASTRO_NODE_AUTOSTART='disabled';const {handler}=await import('./dist/server/entry.mjs');const server=http.createServer(handler);server.listen(47631,'127.0.0.1',()=>console.log('OWNED_HOST_READY'));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`],{cwd:site,env:{...process.env,EMDASH_DATABASE_PATH:dbPath,EMDASH_PROOF_ADMIN_TOKEN:token,EMDASH_ENCRYPTION_KEY:encryption},stdio:['ignore','pipe','pipe'],detached:true});
 await new Promise((ok,fail)=>{let out='';const timer=setTimeout(()=>fail(Error('Host readiness timeout')),30000);child.stdout.on('data',x=>{out+=x;if(out.includes('OWNED_HOST_READY')){clearTimeout(timer);ok();}});child.on('exit',code=>{clearTimeout(timer);fail(Error(`Host exited ${code}`));});child.on('error',fail);});
}
async function stop(){if(!child||child.exitCode!==null)return;await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('Owned host shutdown timeout')),10000);child.once('exit',()=>{clearTimeout(timer);ok();});process.kill(-child.pid,'SIGTERM');});}
async function request(path,{bearer=token,method='GET',body}={}){const response=await fetch(origin+path,{method,headers:{...(bearer?{Authorization:`Bearer ${bearer}`} :{}),'Content-Type':'application/json','X-EmDash-Request':'1'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
const adminPath='/_emdash/api/plugins/dinkus-inventory/admin', settingsPath='/_emdash/api/admin/plugins/dinkus-inventory/settings';
const load={type:'page_load',page:'/inventory'};
const proof={qualification:'actual_config_managed_unsigned_npm_install_astro_emdash_1_2',hostedIssuance:false,registryDelivery:false,productionPluginBytes:true};
try{
 await start();
 const resetSynthetic=await request(settingsPath,{method:'PUT',body:{values:{connectionSession:null}}});assert.equal(resetSynthetic.status,200);
 const health=await request('/_emdash/api/health');assert.equal(health.status,200);proof.health={status:health.status,version:health.body.data?.version};
 const anon=await request(adminPath,{bearer:null,method:'POST',body:load}), editor=await request(adminPath,{bearer:editorToken,method:'POST',body:load});assert.equal(anon.status,401);assert.equal(editor.status,403);proof.permissions={anonymous:anon.status,editor:editor.status};
 const admin=await request(adminPath,{method:'POST',body:load});if(admin.status!==200) console.log(JSON.stringify({adminStatus:admin.status,error:admin.body.error}));assert.equal(admin.status,200);assert.match(JSON.stringify(admin.body),/Connect Inventory/);proof.blockKit={status:admin.status,count:admin.body.data.blocks.length,connectInventory:true};
 const put=await request(settingsPath,{method:'PUT',body:{values:{connectionSession:secret}}});assert.equal(put.status,200);assert.equal(put.body.data.secretsSet.connectionSession,true);
 const get=await request(settingsPath);assert.equal(get.status,200);assert.ok(!JSON.stringify(get.body).includes(secret));proof.settings={put:put.status,get:get.status,secretReturned:false};
 const before=stamp();await stop();await start();
 const after=stamp();assert.deepEqual(after,before);
 const restarted=await request(settingsPath);assert.equal(restarted.status,200);assert.equal(restarted.body.data.secretsSet.connectionSession,true);assert.ok(!JSON.stringify(restarted.body).includes(secret));const restartedAdmin=await request(adminPath,{method:'POST',body:load});assert.equal(restartedAdmin.status,200);proof.restart={adminStatus:restartedAdmin.status,sameCms:true,samePluginKv:true,sameSettingsNamespace:true,reseed:false,sessionRewrite:false};
 writeFileSync(resolve(run,'ASTRO-CONTEXT-PROOF.json'),JSON.stringify(proof,null,2)+'\n');
 console.log(JSON.stringify(proof));
 const visibleReset=await request(settingsPath,{method:'PUT',body:{values:{connectionSession:null}}});assert.equal(visibleReset.status,200);
 console.log('VISIBLE_HOST_READY http://127.0.0.1:47631/_proof/login');
 await new Promise(ok=>process.once('SIGTERM',ok));
}finally{await stop();db.close();}
