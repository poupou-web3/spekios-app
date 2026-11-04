// A standalone demo origin. It never reads the product's .env, database or keys.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export function configuration(env=process.env){
  const token=env.POSTHOG_DEMO_PROJECT_TOKEN||'',host=env.POSTHOG_DEMO_HOST||'';
  if(token&&!/^phc_[a-zA-Z0-9_-]{8,200}$/.test(token))throw new Error('Use the demo project’s public ingestion token.');
  let origin='';
  if(host){const url=new URL(host);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('POSTHOG_DEMO_HOST must be a clean origin.');origin=url.origin;}
  if(Boolean(token)!==Boolean(host))throw new Error('Set both POSTHOG_DEMO_PROJECT_TOKEN and POSTHOG_DEMO_HOST.');
  const enabled=Boolean(token&&origin);
  let uiHost=origin==='https://eu.i.posthog.com'?'https://eu.posthog.com':origin==='https://us.i.posthog.com'?'https://us.posthog.com':origin;
  if(env.POSTHOG_DEMO_UI_HOST){
    const ui=new URL(env.POSTHOG_DEMO_UI_HOST);
    if(!['http:','https:'].includes(ui.protocol)||ui.username||ui.password||ui.pathname!=='/'||ui.search||ui.hash)throw new Error('POSTHOG_DEMO_UI_HOST must be a clean origin.');
    uiHost=ui.origin;
  }
  if(!['true','false',''].includes(env.POSTHOG_DEMO_TOOLBAR||''))throw new Error('POSTHOG_DEMO_TOOLBAR must be true or false.');
  return {token,host:origin,uiHost,toolbarEnabled:enabled&&env.POSTHOG_DEMO_TOOLBAR==='true',enabled};
}
/** @param {{token:string,host:string,enabled:boolean,uiHost?:string,toolbarEnabled?:boolean}} config */
export function demoServer(config=configuration()){
  const files=new Map([['/app.js',['public/app.js','text/javascript']],['/style.css',['public/style.css','text/css']],['/monitoring.js',['public/monitoring.js','text/javascript']],['/vendor/posthog.js',[`node_modules/posthog-js/dist/array.full${config.toolbarEnabled?'':'.no-external'}.js`,'text/javascript']]]);
  const cloud=['https://eu.i.posthog.com','https://us.i.posthog.com'].includes(config.host);
  // Only this standalone demo permits PostHog's toolbar assets. The workspace
  // CSP and its SDK-free pages remain independent.
  const external=config.toolbarEnabled?' '+(cloud?'https://*.posthog.com':[...new Set([config.host,config.uiHost||config.host])].join(' ')):'';
  const connect=[...new Set([config.host,config.toolbarEnabled&&(config.uiHost||config.host),config.toolbarEnabled&&cloud&&'https://*.posthog.com'].filter(Boolean))].join(' ');
  const csp=`default-src 'self'; script-src 'self'${external}; style-src 'self'${external}; img-src 'self' data:${external}; connect-src 'self'${connect?' '+connect:''}; font-src 'self'${external}; media-src 'self'${external}; worker-src 'self' blob: data:; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
  return createServer(async(req,res)=>{
    res.setHeader('Content-Security-Policy',csp);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    const path=new URL(req.url,'http://demo.local').pathname;
    if(path==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"ok","service":"posthog-demo"}');return;}
    if(path==='/config.json'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(config));return;}
    const file=files.get(path)||(path==='/'||['/catalogue','/product','/bag','/complete'].includes(path)?['public/index.html','text/html']:null);
    if(!file){res.writeHead(404);res.end('Not found');return;}
    try{const bytes=await readFile(new URL(file[0],import.meta.url));res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8'});res.end(req.method==='HEAD'?undefined:bytes);}
    catch{res.writeHead(503,{'Content-Type':'text/plain'});res.end('Demo assets unavailable. Run npm ci in apps/posthog-demo.');}
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||18186),bind=process.env.BIND||'127.0.0.1';
  demoServer().listen(port,bind,()=>console.log(`PostHog demo: http://${bind}:${port}`));
}
