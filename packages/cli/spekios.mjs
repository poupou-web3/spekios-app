#!/usr/bin/env node
// Standalone, dependency-free client. The server owns authorization; project
// context contains references only. Credentials and retry receipts stay private.
import {parseArgs} from 'node:util';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,mkdir,lstat,rename,unlink,realpath} from 'node:fs/promises';
import {resolve,join,dirname,parse as parsePath,isAbsolute} from 'node:path';
import {homedir,hostname} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

export const VERSION='0.2.0';
const DEFAULT_SERVER='https://app.spekios.com', PROJECT_FILE='.spekios.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES=['runs:read','runs:write','usage:read'];
const secrets=new Set();
export class CliError extends Error {
  constructor(code,message,exit=2,extra={}){super(message);this.code=code;this.exit=exit;this.extra=extra;}
}
const fail=(code,message,exit=2,extra)=>{throw new CliError(code,message,exit,extra);};
const remember=s=>{if(typeof s==='string'&&s.length>=8)secrets.add(s);return s;};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const uuid=(s,label='ID')=>{if(typeof s!=='string'||!UUID.test(s)||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s))fail('invalid_id',`${label} must be a non-nil UUID.`);return s.toLowerCase();};
const safeCode=x=>typeof x==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(x)?x:'api_error';
function emit(data,stream=process.stdout,pretty=false){
  let value=JSON.stringify(data,null,pretty?2:undefined);
  for(const secret of secrets)value=value.replaceAll(secret,'[REDACTED]');
  stream.write(value+'\n');
}
export function serverOrigin(raw){
  let u;try{u=new URL(raw);}catch{fail('invalid_server','Server must be an HTTPS origin, or literal loopback HTTP.');}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/'
    ||(u.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))||u.port==='0'){
    fail('invalid_server','Server must be an HTTPS origin, or literal loopback HTTP; paths, credentials and queries are forbidden.');
  }
  return u.origin;
}
function owned(info){return typeof process.getuid!=='function'||info.uid===process.getuid();}
const privateMode=info=>process.platform==='win32'||(info.mode&0o077)===0;
async function readJson(path,{privateFile=false,optional=false,max=65536}={}){
  let file;
  try{
    file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const info=await file.stat();
    if(!info.isFile()||info.size>max||(privateFile&&(!owned(info)||!privateMode(info))))fail('unsafe_file','Expected a small regular file; private state must be owned by you with mode 0600.');
    const value=JSON.parse(await file.readFile('utf8'));
    if(!object(value))fail('invalid_state','Expected a JSON object.');return value;
  }catch(e){
    if(e.code==='ENOENT'&&optional)return null;
    if(e instanceof CliError)throw e;
    fail('invalid_state','Cannot read a JSON file safely. Check its permissions and contents.');
  }finally{await file?.close();}
}
async function privateDir(path){
  await mkdir(path,{recursive:true,mode:0o700});
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||!owned(info)||!privateMode(info))fail('unsafe_config','Credential directories must be owned by you, real directories, with mode 0700.');
}
async function writeJson(path,value,{exclusive=false}={}){
  const temp=exclusive?path:join(dirname(path),`.${randomUUID()}.tmp`);
  let file;
  try{
    file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    await file.writeFile(JSON.stringify(value)+'\n');await file.sync();await file.close();file=null;
    if(!exclusive){
      const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(info&&(!info.isFile()||info.isSymbolicLink()))fail('unsafe_file','Refusing to replace a non-regular state file.');
      await rename(temp,path);
    }
  }finally{await file?.close();if(!exclusive)await unlink(temp).catch(()=>{});}
}
const remove=path=>unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
function configRoot(env){
  const path=env.SPEKIOS_CONFIG_DIR||(env.XDG_CONFIG_HOME?join(env.XDG_CONFIG_HOME,'spekios'):join(homedir(),'.config','spekios'));
  if(!isAbsolute(path))fail('invalid_config','SPEKIOS_CONFIG_DIR and XDG_CONFIG_HOME must be absolute paths.');return path;
}
async function projectContext(cwd){
  let dir=resolve(cwd);
  while(true){
    const path=join(dir,PROJECT_FILE),value=await readJson(path,{optional:true,max:16384});
    if(value){
      if(value.version!==1)fail('invalid_project_context','Unsupported project context version.');
      return {...value,server:serverOrigin(value.server),workspace_id:uuid(value.workspace_id,'Workspace ID'),project_id:uuid(value.project_id,'Project ID'),path};
    }
    if(dir===parsePath(dir).root||await lstat(join(dir,'.git')).then(()=>true,()=>false))return null;
    dir=dirname(dir);
  }
}
async function request(server,path,{token,body,timeout=15}={}){
  if(token)remember(token);
  let response;
  try{
    response=await fetch(server+path,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(timeout*1000)});
  }catch{fail('network_error','Request failed or timed out. A submitted command may already be accepted; retry its saved request ID.',5,{retryable:true});}
  const reader=response.body?.getReader();let size=0;const chunks=[];
  try{
    if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16*1024*1024){await reader.cancel();fail('response_too_large','Response exceeded 16 MiB; request a smaller page.',5);}chunks.push(value);}
  }catch(e){if(e instanceof CliError)throw e;fail('network_error','Response was interrupted; retry a saved request with the same ID.',5,{retryable:true});}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_response','The API returned a non-JSON response.',5,{http_status:response.status});}
  const details=data?.structuredContent;
  if(!response.ok||data?.isError===true){
    const code=safeCode(details?.error||data?.error),status=response.status;
    fail(code,status===401?'Agent authentication is expired or revoked. Connect again.':`The API rejected the request (${code}).`,status===401?3:status===403?4:status===409?6:status>=500||status===429?5:2,{http_status:status,retryable:status>=500||status===429});
  }
  return {status:response.status,data};
}
async function identity(server,token,timeout){
  const {data}=await request(server,'/v1/identity',{token,timeout});
  if(!data.agent_id||data.principal_kind!=='agent')fail('agent_credential_required','Use a browser-approved agent credential. Manager and operator credentials are not CLI credentials.',4);
  uuid(data.agent_id,'Agent ID');uuid(data.workspace_id,'Workspace ID');return data;
}
const valueOf=r=>object(r?.structuredContent)?r.structuredContent:r;
function checkedArgs(input){
  if(!object(input))fail('invalid_input','Tool input must be a JSON object.');
  function scan(v){if(Array.isArray(v))return v.forEach(scan);if(!object(v))return;for(const [key,val]of Object.entries(v)){
    if(/^(access_token|refresh_token|api_key|password|secret|authorization|code_verifier|device_code)$/i.test(key))fail('secret_in_tool_input','Tool inputs must contain references, not credentials.');scan(val);
  }}scan(input);return input;
}
async function inputJson(raw){
  if(!raw)return {};
  let text=raw;
  if(raw==='-'){
    const buffers=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)fail('input_too_large','Input exceeds 1 MiB.');buffers.push(chunk);}text=Buffer.concat(buffers).toString('utf8');
  }else if(raw.startsWith('@'))return checkedArgs(await readJson(resolve(raw.slice(1)),{max:1024*1024}));
  if(Buffer.byteLength(text)>1024*1024)fail('input_too_large','Input exceeds 1 MiB.');
  try{return checkedArgs(JSON.parse(text));}catch(e){if(e instanceof CliError)throw e;fail('invalid_input','Input must be JSON, @file.json, or - for standard input.');}
}
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const GLOBAL=['server','profile','timeout','pretty','help','version'];
const COMMANDS={
  'auth login':{args:0,options:['name','scopes','open','wait','wait-timeout'],description:'Request browser approval. Default: return immediately with a link; resume with auth complete.'},
  'auth complete':{args:0,options:['wait','wait-timeout'],description:'Exchange an approved connection for a private 30-day agent credential. No token is printed.'},
  'auth status':{args:0,options:[],description:'Verify the saved agent identity or show pending approval.'},
  'auth logout':{args:0,options:['local'],description:'Revoke this agent connection and remove the credential. --local only removes local state.'},
  'project list':{args:0,options:[],description:'List projects accessible to the authenticated account.'},
  'project use':{args:1,options:[],description:'Select a project UUID; write non-secret .spekios.json in the current directory.'},
  'project init':{args:0,options:[],description:'Allocate a new project context. It appears on the server after its first submitted job.'},
  'project show':{args:0,options:['project'],description:'Show the selected project, resolved model and limits.'},
  'run':{args:1,options:['project','job-id','task-id','viewport','auth-mode','provider','model','key','free-only'],description:'Queue a URL test, returning immediately. A private retry receipt is saved before submission.'},
  'status':{args:1,options:[],description:'Read progress for a job UUID; respect poll_after_ms and continue other work.'},
  'report':{args:1,options:['run'],description:'Read a report by job UUID (or --run for a run UUID). Follow pagination.next using tools call.'},
  'history':{args:0,options:['project','domain','url','offset','limit'],description:'Find prior runs in the selected project. Follow pagination.next_offset.'},
  'issue show':{args:1,options:['offset','limit','revision'],description:'Read one persistent finding, its agent description, evidence, occurrences and candidate history.'},
  'issue verify':{args:2,options:['verification-id','deployment-ref','project'],description:'Verify a candidate URL against this finding; a durable receipt preserves the verification ID.'},
  'verification show':{args:1,options:[],description:'Read the outcome and evidence of a candidate fix verification.'},
  'usage':{args:0,options:[],description:'Read the account’s agent-attributed usage.'},
  'tools list':{args:0,options:[],description:'Discover the live tool catalog and JSON input schemas.'},
  'tools call':{args:1,options:['input'],description:'Call a live agent tool with exact JSON arguments. --input accepts JSON, @file, or - for stdin.'},
  'retry':{args:1,options:[],description:'Resubmit a saved receipt with its original server, workspace and arguments.'},
  'id':{args:0,options:[],description:'Generate a UUID offline for durable command IDs.'},
};
const OPTION_SCHEMA={
  name:{type:'string',maxLength:80,description:'Agent name shown to the account owner.'},
  scopes:{type:'string',description:'Comma-separated permissions; default runs:read,runs:write,usage:read. Use runs:read for read-only access.'},
  open:{type:'boolean',description:'Open the approval link in a local browser.'},
  wait:{type:'boolean',description:'Poll for approval; otherwise return immediately.'},
  'wait-timeout':{type:'integer',minimum:1,maximum:600,default:120},
  local:{type:'boolean',description:'Remove local credentials without revoking the connection.'},
  project:{type:'string',format:'uuid',description:'Override project context for this command.'},
  'job-id':{type:'string',format:'uuid',description:'Stable job ID; retry with identical inputs.'},
  'task-id':{type:'string',format:'uuid'},
  'verification-id':{type:'string',format:'uuid',description:'Stable verification/job UUID for safe retries.'},
  'deployment-ref':{type:'string',maxLength:200,description:'Candidate release or commit label.'},
  revision:{type:'integer',minimum:1,description:'Expected issue revision when paging history.'},
  viewport:{type:'string',enum:['desktop','tablet','mobile']},
  'auth-mode':{type:'string',enum:['auto','public','sign_in']},
  provider:{type:'string',enum:['meta','openrouter','openai','anthropic']},
  model:{type:'string',description:'Model ID; requires --provider.'},
  key:{type:'string',description:'Owned saved provider-key UUID or demo; never an API secret.'},
  'free-only':{type:'string',enum:['true','false'],description:'OpenRouter restriction for an explicit model override.'},
  run:{type:'boolean',description:'Treat the report positional ID as a run ID instead of a job ID.'},
  domain:{type:'string',description:'Exact hostname filter.'},url:{type:'string',description:'Exact URL filter.'},
  offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:50},
  input:{type:'string',description:'JSON object, @path/to/file.json, or - for stdin. Exact live tool schema applies.'},
};
const POSITIONALS={'issue show':['issue_id'],'issue verify':['issue_id','candidate_url'],'verification show':['verification_id'],'project use':['project_id'],run:['url'],status:['job_id'],report:['job_id_or_run_id'],'tools call':['tool_name'],retry:['request_id']};
function help(command){return {name:'spekios',version:VERSION,output:'One JSON object per command on stdout; approval notices on stderr only when --wait is used.',commands:Object.fromEntries(Object.entries(command&&COMMANDS[command]?{[command]:COMMANDS[command]}:COMMANDS).map(([name,spec])=>[name,{...spec,positionals:POSITIONALS[name]||[],options:Object.fromEntries(spec.options.map(key=>[key,name==='issue show'&&key==='limit'?{...OPTION_SCHEMA[key],maximum:10}:OPTION_SCHEMA[key]]))}])) ,global_options:{server:'HTTPS API origin; default https://app.spekios.com',profile:'Named private credential profile; default default',timeout:'HTTP timeout in seconds, 1–120; default 15',pretty:'Indent JSON output'},exit_codes:{0:'success',2:'invalid input or API validation error',3:'approval, authentication or sign-in required',4:'access denied',5:'network, server or rate limit error',6:'conflict; reconcile before retry'},workflow:['auth login --name "Coding agent"','auth complete','project list','project use <project-uuid>','run https://your-app.example','status <job-uuid>','report <job-uuid>'],security:{credential_scope:'workspace permissions, enforced by server',project_selection:'working context, not a project-only authorization grant',approval:'a signed-in human approves the agent in the browser',credential_lifetime_days:30,provider_keys:'managed by the account in the web app; never included in CLI credentials'}};}
function parse(argv){
  const boolean=['help','version','pretty','open','wait','local','run'];
  const string=[...new Set([...GLOBAL,...Object.values(COMMANDS).flatMap(c=>c.options)])].filter(k=>!boolean.includes(k));
  let args;try{args=parseArgs({args:argv,allowPositionals:true,options:Object.fromEntries([...boolean.map(k=>[k,{type:'boolean'}]),...string.map(k=>[k,{type:'string'}])])});}catch{fail('invalid_arguments','Unknown or incomplete option. Run spekios --help for the command schema.');}
  const positions=args.positionals,group=['auth','project','tools','issue','verification'].includes(positions[0]);
  const command=positions.slice(0,group?2:1).join(' '),rest=positions.slice(group?2:1);
  if(args.values.version)return {command:'version',options:args.values};
  if(args.values.help||!command)return {command:'help',options:args.values,target:command};
  const spec=COMMANDS[command];if(!spec||rest.length!==spec.args)fail('invalid_arguments','Unknown command or incorrect positional arguments. Run spekios --help.');
  for(const key of Object.keys(args.values))if(!GLOBAL.includes(key)&&!spec.options.includes(key))fail('invalid_arguments',`Option --${key} is not valid for ${command}.`);
  return {command,rest,options:args.values};
}
class Client {
  constructor(options,env,cwd){
    this.options=options;this.env=env;this.cwd=cwd;this.profile=options.profile??'default';
    if(options.server!==undefined)serverOrigin(options.server);
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(this.profile))fail('invalid_profile','Profile must be 1–48 letters, digits, underscores or hyphens.');
    this.root=configRoot(env);this.dir=join(this.root,this.profile);this.credentials=join(this.dir,'credential.json');this.pending=join(this.dir,'pending.json');
    this.timeout=options.timeout===undefined?15:Number(options.timeout);if(!Number.isInteger(this.timeout)||this.timeout<1||this.timeout>120)fail('invalid_timeout','Timeout must be an integer between 1 and 120 seconds.');
  }
  async prepare(){await privateDir(this.root);await privateDir(this.dir);}
  async lock(action){
    await this.prepare();const path=join(this.dir,'auth.lock');
    try{await writeJson(path,{pid:process.pid,host:hostname()},{exclusive:true});}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      const owner=await readJson(path,{privateFile:true});let live=true;
      if(owner.host===hostname()&&Number.isInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')live=false;}}
      if(live)fail('auth_busy','Another authentication command is running for this profile.',6,{retryable:true});
      await remove(path);return this.lock(action);
    }
    try{return await action();}finally{await remove(path);}
  }
  async stored(){
    for(const path of [this.root,this.dir]){
      const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(info&&(!info.isDirectory()||info.isSymbolicLink()||!owned(info)||!privateMode(info)))fail('unsafe_config','Credential directories must be real, owned by you, with mode 0700.');
    }
    const c=await readJson(this.credentials,{privateFile:true,optional:true});
    if(!c)return null;
    if(c.version!==1||typeof c.access_token!=='string'||!/^scout_agent_[a-zA-Z0-9_-]{32,}$/.test(c.access_token)||!Number.isSafeInteger(c.expires_at))fail('invalid_credential','Saved agent credential is invalid. Reconnect with a new profile.');
    remember(c.access_token);return {...c,server:serverOrigin(c.server),agent_id:uuid(c.agent_id),workspace_id:uuid(c.workspace_id)};
  }
  async endpoint(){
    const c=await this.stored();return serverOrigin(this.options.server||this.env.SPEKIOS_SERVER||c?.server||DEFAULT_SERVER);
  }
  async authenticated({context=false,server}={}){
    const c=await this.stored(),external=this.env.SPEKIOS_TOKEN;
    if(external){
      if(!this.options.server&&!this.env.SPEKIOS_SERVER)fail('server_required','Set SPEKIOS_SERVER or --server explicitly when using SPEKIOS_TOKEN.');
      if(!/^scout_agent_[a-zA-Z0-9_-]{32,}$/.test(external))fail('agent_credential_required','SPEKIOS_TOKEN must be a browser-approved native agent credential.',4);
    }else if(!c)fail('authentication_required','Run spekios auth login, have the account owner approve, then run spekios auth complete.',3);
    const origin=serverOrigin(server||this.options.server||this.env.SPEKIOS_SERVER||c.server);
    if(!external&&origin!==c.server)fail('server_mismatch','This credential belongs to another server. Choose its profile or connect a new profile.',4);
    if(!external&&c.expires_at<=Date.now())fail('authentication_expired','Agent credential expired. Log out locally and connect again.',3);
    const token=remember(external||c.access_token),who=await identity(origin,token,this.timeout);
    if(!external&&(who.workspace_id!==c.workspace_id||who.agent_id!==c.agent_id))fail('identity_mismatch','Stored credential identity does not match this server.',4);
    let selected=null;
    if(context){
      if(this.options.project!==undefined)selected={server:origin,workspace_id:who.workspace_id,project_id:uuid(this.options.project,'Project ID')};
      else selected=await projectContext(this.cwd);
      if(selected&&(selected.server!==origin||selected.workspace_id!==who.workspace_id))fail('project_account_mismatch','This directory belongs to a different server or workspace. Select a project explicitly with project use.',4);
    }
    return {server:origin,token,who,project:selected};
  }
  async tool(auth,name,input){
    if(!/^scout_[a-z_]{1,90}$/.test(name))fail('invalid_tool','Tool names must be scout_ followed by lowercase letters or underscores.');
    const {data}=await request(auth.server,`/v1/agent/tools/${name}`,{token:auth.token,body:checkedArgs(input),timeout:this.timeout});return data;
  }
  result(auth,data,extra={}){return {ok:true,server:auth.server,workspace_id:auth.who.workspace_id,agent_id:auth.who.agent_id,...(auth.project?{project_id:auth.project.project_id}:{}),data,...extra};}
  async receipt(auth,tool,args,id=randomUUID()){
    await this.prepare();const dir=join(this.dir,'requests');await privateDir(dir);
    id=uuid(id,'Request ID');const path=join(dir,`${id}.json`),value={version:1,request_id:id,server:auth.server,workspace_id:auth.who.workspace_id,tool,arguments:checkedArgs(args)};
    try{await writeJson(path,value,{exclusive:true});}catch(e){if(e.code!=='EEXIST')throw e;const old=await readJson(path,{privateFile:true,max:2*1024*1024});if(!same(old,value))fail('request_id_conflict','This request ID already has different saved arguments. Retry it, or use a new ID.',6,{request_id:id});}
    return value;
  }
  async submit(auth,receipt){
    try{return this.result(auth,valueOf(await this.tool(auth,receipt.tool,receipt.arguments)),{request_id:receipt.request_id,retry_command:`spekios --profile ${this.profile} retry ${receipt.request_id}`,...(receipt.tool==='scout_start_exploration'?{job_id:receipt.arguments.job_id,next_commands:{status:`spekios --profile ${this.profile} status ${receipt.arguments.job_id}`,report:`spekios --profile ${this.profile} report ${receipt.arguments.job_id}`}}:{})});}
    catch(e){if(e instanceof CliError)e.extra={...e.extra,request_id:receipt.request_id,retry_command:`spekios --profile ${this.profile} retry ${receipt.request_id}`};throw e;}
  }
  async completeOnce(){return this.lock(async()=>{
    const saved=await this.stored();
    if(saved){
      const auth=await this.authenticated();await remove(this.pending);
      return this.result(auth,auth.who,{status:'connected',credential_scope:'workspace'});
    }
    const p=await readJson(this.pending,{privateFile:true,optional:true});if(!p)fail('no_pending_approval','Start a connection with spekios auth login.',3);
    remember(p.device_code);remember(p.code_verifier);const server=serverOrigin(p.server);
    if(this.options.server&&serverOrigin(this.options.server)!==server)fail('server_mismatch','Pending approval belongs to a different server.',4);
    if(!Array.isArray(p.scopes)||!p.scopes.length||p.scopes.some(s=>!SCOPES.includes(s)))fail('invalid_state','Pending approval scopes are invalid. Start a new auth login.');
    if(p.expires_at<=Date.now())fail('connection_expired','Approval expired. Start a new connection with auth login.',3);
    let result;
    try{result=await request(server,'/v1/agent-connections/token',{body:{device_code:p.device_code,code_verifier:p.code_verifier},timeout:this.timeout});}
    catch(e){
      if(e.code==='slow_down')return {ok:false,status:'authorization_pending',interval:5};
      if(e.code==='connection_already_consumed')fail('connection_already_consumed','The one-use approval was exchanged but no credential is saved. Run auth login and request a fresh approval.',3,{next_command:`spekios --profile ${this.profile} auth login --server ${server} --scopes ${p.scopes.filter(s=>SCOPES.includes(s)).join(',')}`});
      throw e;
    }
    const {data,status}=result;
    if(status===202&&data.status==='authorization_pending')return {ok:false,status:'authorization_pending',interval:Math.max(5,Number(data.interval)||5)};
    const token=remember(data.access_token);
    if(typeof token!=='string'||!/^scout_agent_[a-zA-Z0-9_-]{32,}$/.test(token)||!Number.isInteger(data.expires_in)||data.expires_in<1||data.expires_in>2592000)fail('invalid_credential','The server returned an invalid agent credential.',5);
    const workspace=uuid(data.workspace_id,'Workspace ID'),agent=uuid(data.agent_id,'Agent ID');
    // Persist the one-use exchange before any further request. If identity
    // verification is interrupted, auth complete/status can safely resume.
    await writeJson(this.credentials,{version:1,server,workspace_id:workspace,agent_id:agent,access_token:token,expires_at:Date.now()+data.expires_in*1000});
    const who=await identity(server,token,this.timeout);
    if(who.workspace_id!==workspace||who.agent_id!==agent){await remove(this.credentials);fail('identity_mismatch','The approved credential identity does not match its response.',4);}
    await remove(this.pending);
    return {ok:true,status:'connected',server,workspace_id:who.workspace_id,agent_id:who.agent_id,scopes:who.scopes,credential_scope:'workspace',expires_in:data.expires_in,next_command:'spekios project list'};
  });}
  async complete(){
    const seconds=this.options['wait-timeout']===undefined?120:Number(this.options['wait-timeout']);
    if(!Number.isInteger(seconds)||seconds<1||seconds>600)fail('invalid_timeout','Wait timeout must be between 1 and 600 seconds.');
    const deadline=Date.now()+seconds*1000;
    while(true){const result=await this.completeOnce();if(result.ok)return result;if(!this.options.wait||Date.now()+result.interval*1000>deadline)return {...result,next_command:`spekios --profile ${this.profile} auth complete`};await delay(result.interval*1000);}
  }
  async execute(command,args){
    if(command==='auth login'){
      const result=await this.lock(async()=>{
        if(await this.stored())fail('already_connected','This profile already has an agent credential. Log out first or choose a new --profile.',6);
        const scopes=this.options.scopes!==undefined?this.options.scopes.split(/[\s,]+/).filter(Boolean):SCOPES;
        if(!scopes.length||scopes.some(s=>!SCOPES.includes(s)))fail('invalid_scopes','Scopes may contain runs:read, runs:write, usage:read.');
        const name=this.options.name??'Spekios CLI agent';if(name.trim().length<1||name.length>80||/[\u0000-\u001f\u007f]/.test(name))fail('invalid_agent_name','Agent name must contain 1–80 printable characters.');
        const server=await this.endpoint(),verifier=remember(randomBytes(32).toString('hex'));
        const {data}=await request(server,'/v1/agent-connections',{body:{agent_name:name,scopes:[...new Set(scopes)],code_challenge:createHash('sha256').update(verifier).digest('hex')},timeout:this.timeout});
        if(typeof data.device_code!=='string'||!/^[a-f0-9]{64}$/.test(data.device_code)||typeof data.user_code!=='string'||!/^[A-F0-9]{12}$/.test(data.user_code)||!Number.isInteger(data.expires_in)||data.expires_in<1||data.expires_in>600)fail('invalid_response','The server returned an invalid approval request.',5);
        remember(data.device_code);
        const url=new URL('/connect',server);url.hash=new URLSearchParams({code:data.user_code}).toString();
        await writeJson(this.pending,{version:1,server,scopes:[...new Set(scopes)],device_code:data.device_code,code_verifier:verifier,expires_at:Date.now()+data.expires_in*1000});
        return {ok:false,status:'authorization_pending',verification_url:url.href,user_code:data.user_code,expires_in:data.expires_in,requested_scopes:scopes,next_command:`spekios --profile ${this.profile} auth complete`};
      });
      if(this.options.open){
        const cmd=process.platform==='darwin'?'open':process.platform==='win32'?'explorer.exe':'xdg-open';
        const child=spawn(cmd,[result.verification_url],{stdio:'ignore',detached:true});child.on('error',()=>{});child.unref();
      }
      if(!this.options.wait)return result;emit(result,process.stderr);return this.complete();
    }
    if(command==='auth complete')return this.complete();
    if(command==='auth status'){
      const c=await this.stored();
      if(!c&&!this.env.SPEKIOS_TOKEN){const p=await readJson(this.pending,{privateFile:true,optional:true});return {ok:false,status:p?'authorization_pending':'not_connected',next_command:p?'spekios auth complete':'spekios auth login'};}
      const auth=await this.authenticated();return this.result(auth,auth.who,{status:'connected',credential_scope:'workspace',...(c?{expires_at:new Date(c.expires_at).toISOString()}:{}),credential_source:this.env.SPEKIOS_TOKEN?'environment':'private_profile'});
    }
    if(command==='auth logout')return this.lock(async()=>{
      if(this.env.SPEKIOS_TOKEN)fail('environment_credential','Unset SPEKIOS_TOKEN before logging out a saved profile. Revoke environment credentials through the web app.',2);
      const c=await this.stored();if(c&&!this.options.local){const auth=await this.authenticated();await request(auth.server,`/v1/agents/${auth.who.agent_id}/revoke`,{token:auth.token,body:{},timeout:this.timeout});}
      await remove(this.credentials);await remove(this.pending);return {ok:true,status:'disconnected',revoked:!!c&&!this.options.local,existing_work_cancelled:false};
    });
    if(command==='retry'){
      const id=uuid(args[0],'Request ID'),r=await readJson(join(this.dir,'requests',`${id}.json`),{privateFile:true,max:2*1024*1024});
      if(r.version!==1||r.request_id!==id||!object(r.arguments))fail('invalid_receipt','Saved request receipt is invalid.');
      const auth=await this.authenticated({server:serverOrigin(r.server)});
      if(auth.who.workspace_id!==r.workspace_id)fail('request_account_mismatch','Saved request belongs to a different workspace.',4);
      return this.submit(auth,r);
    }
    const scoped=['run','history','project show'].includes(command),auth=await this.authenticated({context:scoped});
    if(command==='project list')return this.result(auth,valueOf(await this.tool(auth,'scout_list_projects',{})));
    if(command==='project show'){
      if(!auth.project)fail('project_required','Select a project with project use <uuid>, or pass --project.');
      return this.result(auth,valueOf(await this.tool(auth,'scout_get_project',{project_id:auth.project.project_id})));
    }
    if(command==='project use'||command==='project init'){
      const existing=await projectContext(this.cwd);if(command==='project init'&&existing)fail('project_exists','This directory already has a project context. Use project show or project use.',6);
      const id=command==='project init'?randomUUID():uuid(args[0],'Project ID');
      const project=valueOf(await this.tool(auth,'scout_get_project',{project_id:id}));
      const context={version:1,server:auth.server,workspace_id:auth.who.workspace_id,project_id:id};
      const path=join(this.cwd,PROJECT_FILE);await writeJson(path,context);
      return this.result({...auth,project:context},project,{context_file:path,contains_credentials:false,...(command==='project init'?{registration:'on_first_job'}:{})});
    }
    if(command==='issue show'){
      const input={issue_id:uuid(args[0],'Issue ID')};
      for(const key of ['offset','limit','revision'])if(this.options[key]!==undefined){
        const n=Number(this.options[key]),min=key==='offset'?0:1,max=key==='limit'?10:Number.MAX_SAFE_INTEGER;
        if(!Number.isSafeInteger(n)||n<min||n>max||(key==='offset'&&n>100000))fail('invalid_pagination','Issue history requires offset 0–100000, limit 1–10, and a positive revision.');
        input[key==='revision'?'expected_revision':key]=n;
      }
      return this.result(auth,valueOf(await this.tool(auth,'scout_get_issue',input)));
    }
    if(command==='issue verify'){
      let candidate;try{candidate=new URL(args[1]);}catch{fail('invalid_url','Candidate requires an HTTP(S) URL.');}
      if(!['http:','https:'].includes(candidate.protocol)||candidate.username||candidate.password)fail('invalid_url','Candidate must be an HTTP(S) URL without embedded credentials.');
      const id=this.options['verification-id']===undefined?randomUUID():uuid(this.options['verification-id'],'Verification ID');
      const input={issue_id:uuid(args[0],'Issue ID'),verification_id:id,candidate_url:args[1]};
      if(this.options['deployment-ref']!==undefined){const label=this.options['deployment-ref'].trim();if(!label||label.length>200)fail('invalid_deployment_ref','Deployment label must contain 1–200 characters.');input.deployment_ref=label;}
      if(this.options.project!==undefined)input.project_id=uuid(this.options.project,'Project ID');
      const response=await this.submit(auth,await this.receipt(auth,'scout_verify_fix',input,id));
      return {...response,verification_id:id,next_command:`spekios --profile ${this.profile} verification show ${id}`};
    }
    if(command==='verification show')return this.result(auth,valueOf(await this.tool(auth,'scout_get_verification',{verification_id:uuid(args[0],'Verification ID')})));
    if(command==='tools list'){const {data}=await request(auth.server,'/v1/agent/tools',{token:auth.token,timeout:this.timeout});return this.result(auth,data);}
    if(command==='tools call'){
      const name=args[0],input=await inputJson(this.options.input);
      const {data:catalog}=await request(auth.server,'/v1/agent/tools',{token:auth.token,timeout:this.timeout});
      const spec=catalog.tools?.find(t=>t.name===name);if(!spec)fail('unknown_tool','Tool is not in the live server catalog.');
      if(spec.annotations?.readOnlyHint===true){const result=await this.tool(auth,name,input);return this.result(auth,valueOf(result),result.content?.some(c=>c.type!=='text')?{content:result.content}:{});}
      return this.submit(auth,await this.receipt(auth,name,input));
    }
    if(command==='run'){
      const id=this.options['job-id']?uuid(this.options['job-id'],'Job ID'):randomUUID();
      const input={job_id:id,url:args[0]};
      let target;try{target=new URL(args[0]);}catch{fail('invalid_url','Run requires an HTTP(S) target URL.');}
      if(!['http:','https:'].includes(target.protocol)||target.username||target.password)fail('invalid_url','Use an HTTP(S) target URL without embedded credentials.');
      if(!auth.project)fail('project_required','Select a project with project use <uuid> or project init, or pass --project.');
      input.project_id=auth.project.project_id;
      if(this.options['task-id']!==undefined)input.task_id=uuid(this.options['task-id'],'Task ID');
      if(this.options.viewport!==undefined){if(!['desktop','tablet','mobile'].includes(this.options.viewport))fail('invalid_viewport','Viewport must be desktop, tablet or mobile.');input.viewport_profile=this.options.viewport;}
      if(this.options['auth-mode']!==undefined){if(!['auto','public','sign_in'].includes(this.options['auth-mode']))fail('invalid_auth_mode','Auth mode must be auto, public or sign_in.');input.auth_mode=this.options['auth-mode'];}
      if(['provider','model','key','free-only'].some(key=>this.options[key]!==undefined)){
        if(!['meta','openrouter','openai','anthropic'].includes(this.options.provider)||!this.options.model)fail('invalid_model','Provide both --provider and --model for a model override.');
        input.model={provider:this.options.provider,model:this.options.model};
        if(this.options['free-only']!==undefined){if(!['true','false'].includes(this.options['free-only']))fail('invalid_model','--free-only must be true or false.');input.model.free_only=this.options['free-only']==='true';}
        if(this.options.key!==undefined)input.model.provider_key_id=this.options.key==='demo'?'demo':uuid(this.options.key,'Key reference');
      }
      return this.submit(auth,await this.receipt(auth,'scout_start_exploration',input,id));
    }
    if(command==='status')return this.result(auth,valueOf(await this.tool(auth,'scout_get_progress',{job_id:uuid(args[0],'Job ID')})));
    if(command==='report')return this.result(auth,valueOf(await this.tool(auth,'scout_get_report',{[this.options.run?'run_id':'job_id']:uuid(args[0])})));
    if(command==='usage')return this.result(auth,valueOf(await this.tool(auth,'scout_usage',{})));
    if(command==='history'){
      const input={};if(auth.project)input.project_id=auth.project.project_id;
      for(const key of ['domain','url'])if(this.options[key])input[key]=this.options[key];
      for(const key of ['offset','limit'])if(this.options[key]!==undefined){const n=Number(this.options[key]);if(!Number.isInteger(n)||n<(key==='limit'?1:0)||n>(key==='limit'?50:100000))fail('invalid_pagination','Offset must be 0–100000 and limit 1–50.');input[key]=n;}
      return this.result(auth,valueOf(await this.tool(auth,'scout_list_sessions',input)));
    }
    fail('invalid_arguments','Unknown command. Run spekios --help.');
  }
}
export async function main(argv=process.argv.slice(2),env=process.env,cwd=process.cwd()){
  let pretty=false;
  try{
    const {command,options,rest,target}=parse(argv);pretty=!!options.pretty;
    if(command==='help'){emit(help(target),process.stdout,pretty);return 0;}
    if(command==='version'){emit({name:'spekios',version:VERSION});return 0;}
    if(command==='id'){emit({ok:true,id:randomUUID()},process.stdout,pretty);return 0;}
    const result=await new Client(options,env,cwd).execute(command,rest);emit(result,process.stdout,pretty);return result.ok===false?3:0;
  }catch(e){
    const known=e instanceof CliError;
    emit({ok:false,error:{code:known?e.code:'local_io_error',message:known?e.message:'A local operation failed. Check file permissions and retry.',...(known?e.extra:{})}},process.stdout,pretty);return known?e.exit:5;
  }
}
if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
  process.on('SIGINT',()=>{emit({ok:false,error:{code:'interrupted',message:'Command interrupted. Pending approval and saved receipts can be resumed.'}});process.exit(130);});
  process.exitCode=await main();
}
