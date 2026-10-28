import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { isUuid, workspaceId, userId } from './contracts.js';
import type { Store } from './store.js';

export type SessionState = Awaited<ReturnType<BrowserContext['storageState']>>;
export type SessionScope = { session_id: string; origin: string; execution_mode: string };
const associatedData = (scope: SessionScope) => Buffer.from(JSON.stringify({ version:1, workspace_id:workspaceId,user_id:userId,...scope }));
export function sealSession(state: SessionState, scope: SessionScope, key: Buffer) {
  if (key.length !== 32) throw new Error('Authentication vault key is unavailable.');
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(associatedData(scope));
  const data=Buffer.concat([cipher.update(JSON.stringify(state)),cipher.final()]);
  return Buffer.concat([Buffer.from('SQA1'),iv,cipher.getAuthTag(),data]);
}
export function openSession(bytes: Buffer, scope: SessionScope, key: Buffer): SessionState {
  try {
    if(bytes.subarray(0,4).toString()!=='SQA1'||bytes.length>2_000_000)throw new Error();
    const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(4,16));
    cipher.setAAD(associatedData(scope));cipher.setAuthTag(bytes.subarray(16,32));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(32)),cipher.final()]).toString());
  } catch { throw new Error('Authentication session could not be decrypted for this app and workspace.'); }
}
export class AuthVault {
  readonly directory=process.env.SCOUT_AUTH_VAULT ?? '/data/auth';
  constructor(private store: Store) {}
  private async key() {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const path=join(this.directory,'key');
    // Separate from the evidence spool; never exported or returned by an API.
    try {const f=await open(path,'wx',0o600);try{await f.writeFile(randomBytes(32));await f.sync();}finally{await f.close();}}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const key=await readFile(path);if(key.length!==32)throw new Error('Authentication vault key is unavailable.');return key;
  }
  private file(id:string){if(!isUuid(id))throw new Error('Invalid session ID.');return join(this.directory,id+'.sealed');}
  async save(context:BrowserContext,scope:SessionScope,runId:string,verification:string){
    const state=await context.storageState({indexedDB:true});
    // The browser is restricted to one app origin. Do not persist identity-provider cookies.
    const hostname=new URL(scope.origin).hostname;
    if(state.origins.some(s=>s.origin!==scope.origin)||state.cookies.some(c=>{
      const domain=c.domain.replace(/^\./,'');return hostname!==domain&&!hostname.endsWith('.'+domain);
    }))throw new Error('Authentication state contains an unexpected origin.');
    const plaintextSize=Buffer.byteLength(JSON.stringify(state));
    if(plaintextSize>1_500_000)throw new Error('Authentication state exceeds the local vault limit.');
    const sealed=sealSession(state,scope,await this.key()),temporary=this.file(scope.session_id)+'.tmp';
    const f=await open(temporary,'wx',0o600);try{await f.writeFile(sealed);await f.sync();}finally{await f.close();}
    await rename(temporary,this.file(scope.session_id));
    try{await this.store.pool.query(`INSERT INTO browser_sessions(session_id,workspace_id,user_id,origin,execution_mode,created_by_run_id,expires_at,verification)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours',$7)`,[scope.session_id,workspaceId,userId,scope.origin,scope.execution_mode,runId,verification]);}
    catch {await rm(this.file(scope.session_id),{force:true});throw new Error('Authentication session could not be saved.');}
    return scope.session_id;
  }
  async load(id:string,origin:string,executionMode:string){
    const row=(await this.store.pool.query(`SELECT session_id FROM browser_sessions WHERE session_id=$1 AND workspace_id=$2 AND user_id=$3
      AND origin=$4 AND execution_mode=$5 AND revoked_at IS NULL AND expires_at>now()`,[id,workspaceId,userId,origin,executionMode])).rows[0];
    if(!row)throw new Error('Saved app session is unavailable, expired or belongs to another app.');
    try{return openSession(await readFile(this.file(id)),{session_id:id,origin,execution_mode:executionMode},await this.key());}
    catch{throw new Error('Saved app session could not be opened. Sign in again.');}
  }
  async revoke(id:string){
    if(!isUuid(id))throw new Error('Invalid session ID.');
    const result=await this.store.pool.query('UPDATE browser_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE session_id=$1 AND workspace_id=$2 AND user_id=$3 RETURNING session_id',[id,workspaceId,userId]);
    if(!result.rowCount)return false;
    await rm(this.file(id),{force:true});return true;
  }
  async purge(){
    const rows=(await this.store.pool.query('SELECT session_id FROM browser_sessions WHERE workspace_id=$1 AND user_id=$2 AND (revoked_at IS NOT NULL OR expires_at<=now())',[workspaceId,userId])).rows;
    for(const row of rows)await rm(this.file(row.session_id),{force:true});
  }
}
