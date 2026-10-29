import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import path from 'node:path';
const args=process.argv.slice(2);
let selected=process.env.SCOUT_CREDENTIAL_FILE||path.join(process.env.XDG_CONFIG_HOME||path.join(homedir(),'.config'),'scout','credentials.json');
let operator=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--credential-file'&&args[i+1])selected=path.resolve(args[++i]);
  else if(args[i]==='--operator')operator=true;
  else throw new Error('Usage: node scripts/mcp-config.mjs [--credential-file PATH] [--operator]');
}
// No credential value is emitted. Normal clients use their browser-approved
// agent profile; the operator env file is an explicit administrative fallback.
console.log(JSON.stringify({mcpServers:{scout:{
  command:fileURLToPath(new URL('../apps/api/target/release/scout-mcp',import.meta.url)),
  args:operator?['--env-file',fileURLToPath(new URL('../.env',import.meta.url)),'--api-url','http://127.0.0.1:18080']:['--credential-file',path.resolve(selected)],
}}},null,2));
