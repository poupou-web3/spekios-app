#!/usr/bin/env node
// Prepare a private local auth credential. Only its hash goes to Lovable.
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
const args=process.argv.slice(2),allowed=new Set(['--auth-origin','--callback','--activate']);
const options={};
for(let i=0;i<args.length;i++){
  if(!allowed.has(args[i]))throw new Error('Usage: node scripts/setup-spekios-auth.mjs [--auth-origin HTTPS_ORIGIN] [--callback http://localhost:18080/auth/callback] [--activate]');
  const key=args[i];options[key]=key==='--activate'?true:args[++i];
  if(options[key]===undefined)throw new Error('Missing option value');
}
const privateFile=new URL('../.env.spekios.local',import.meta.url);
const registrationFile=new URL('../artifacts/spekios-local-registration.sql',import.meta.url);
let existing='';try{existing=await readFile(privateFile,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
const previous=Object.fromEntries(existing.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>{const p=l.indexOf('=');return[l.slice(0,p),l.slice(p+1)];}));
const callback=options['--callback']||previous.SPEKIOS_REDIRECT_URI||'http://localhost:18080/auth/callback';
const url=new URL(callback);
if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/auth/callback'||url.search||url.hash||url.username||url.password)throw new Error('This helper registers only a literal localhost HTTP callback');
let origin=options['--auth-origin']||previous.SPEKIOS_AUTH_ORIGIN||'';
if(origin){const u=new URL(origin);if(u.protocol!=='https:'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw new Error('Auth origin must be a clean HTTPS origin');origin=u.origin;}
const secret=previous.SPEKIOS_CLIENT_SECRET||randomBytes(48).toString('base64url');
if(!/^[A-Za-z0-9_-]{64}$/.test(secret))throw new Error('Unexpected existing local secret format');
const settings={SPEKIOS_AUTH_ORIGIN:origin,SPEKIOS_ISSUER:'https://ctgxazkkspnsukrpjesw.supabase.co/auth/v1',SPEKIOS_CLIENT_ID:'spekios-local',SPEKIOS_CLIENT_SECRET:secret,SPEKIOS_REDIRECT_URI:callback};
const lines=Object.entries(settings).map(([k,v])=>`${k}=${v}`);
await writeFile(privateFile,'# Backend-only Spekios local auth. Never commit or paste this file.\n'+lines.join('\n')+'\n',{mode:0o600});await chmod(privateFile,0o600);
const hash=createHash('sha256').update(secret).digest('hex');
await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
await writeFile(registrationFile,`-- Contains only a credential hash, never the client secret.\nINSERT INTO public.bridge_clients(client_id,display_name,redirect_uris,secret_sha256,launch_url,enabled)\nVALUES('spekios-local','Spekios local development',ARRAY['${url.href}'],'${hash}',NULL,true)\nON CONFLICT(client_id) DO UPDATE SET redirect_uris=EXCLUDED.redirect_uris,secret_sha256=EXCLUDED.secret_sha256,enabled=true,updated_at=now();\n`,{mode:0o600});
if(options['--activate']){
  if(!origin)throw new Error('Publish the Lovable wrapper first, then pass --auth-origin');
  const envFile=new URL('../.env',import.meta.url);let env;
  try{env=await readFile(envFile,'utf8');}catch{throw new Error('Create the normal local infrastructure .env first; this helper never replaces its credentials');}
  const keys=new Set([...Object.keys(settings),'SCOUT_DEV_AUTH_BYPASS']);
  env=env.split('\n').filter(l=>!keys.has(l.split('=')[0])).join('\n').trimEnd();
  await writeFile(envFile,env+'\nSCOUT_DEV_AUTH_BYPASS=false\n'+lines.join('\n')+'\n',{mode:0o600});await chmod(envFile,0o600);
}
console.log('Prepared .env.spekios.local (private) and artifacts/spekios-local-registration.sql (hash only).');
console.log(origin?'Auth origin configured.':'Auth origin pending: publish the Lovable wrapper before activation.');
if(options['--activate'])console.log('Updated .env. Rebuild/restart the API after applying the web-auth migration.');
