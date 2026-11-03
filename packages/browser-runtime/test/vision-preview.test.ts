import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {digest,EVAL_VERSION} from '../evaluation/core.mjs';
const require=createRequire(new URL('../../image-diff/package.json',import.meta.url)),{PNG}=require('pngjs');
test('offline preview uses the live input projection, excludes labels/verdicts and needs no credentials',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'vision-eval-preview-'));
 try{
  const files:any={};await mkdir(join(temp,'images'));
  for(const phase of ['before','after']){const png=new PNG({width:1440,height:900});png.data.fill(255);if(phase==='after')png.data[(350*1440+400)*4]=0;const bytes=PNG.sync.write(png),path='images/'+phase+'.png';await writeFile(join(temp,path),bytes);files[phase]={path,sha256:digest(bytes),byte_length:bytes.length,observation:{url:'https://larchwood.example/product/desk',title:'Example shop',text:'Ready',controls:[]}};}
  const source={id:'test-case',source:{run_id:randomUUID(),action_id:randomUUID(),original_verdict:'ORIGINAL_VERDICT_MUST_STAY_HIDDEN'},label:{expected:'bug',rubrics:[{id:'GOLD_LABEL_MUST_STAY_HIDDEN',actual:'SECRET_REFERENCE_DESCRIPTION'}]},command:{type:'click',control:{role:'button',name:'Save',rect:{x:380,y:320,width:100,height:40}}},prediction:{source:'model',goal:'Save',expected_result:'Saved'},outcome:{status:'settled'},entry_url:'https://larchwood.example',recent_history:[],images:files};
  const body={version:EVAL_VERSION,source_origin:'https://larchwood.example',cases:[source],excluded:[],manifest_sha256:'fixture'},dataset={...body,sha256:digest(body),created_at:new Date().toISOString()};await writeFile(join(temp,'dataset.json'),JSON.stringify(dataset));
  const out=join(temp,'review'),root=resolve(new URL('..',import.meta.url).pathname),child=spawn(join(root,'node_modules/.bin/tsx'),[join(root,'evaluation/larchwood.ts'),'preview','--dataset',join(temp,'dataset.json'),'--out',out,'--limit','1'],{env:{...process.env,POSTGRES_PASSWORD:'',SCOUT_API_TOKEN:'',SCOUT_API_URL:'http://127.0.0.1:1'}});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});assert.equal(code,0,stderr);assert.equal(JSON.parse(stdout).live_calls,0);
  const full=await readFile(join(out,'test-case','full-prompt.json'),'utf8'),optimized=await readFile(join(out,'test-case','optimized-prompt.json'),'utf8');
  for(const prompt of [full,optimized])for(const hidden of ['GOLD_LABEL_MUST_STAY_HIDDEN','SECRET_REFERENCE_DESCRIPTION','ORIGINAL_VERDICT_MUST_STAY_HIDDEN'])assert(!prompt.includes(hidden));
  assert.equal(JSON.parse(full).input.visual_input.mode,'full');assert.equal(JSON.parse(optimized).input.visual_input.mode,'overview_and_crops');
  assert.equal(JSON.parse(await readFile(join(out,'preview.json'),'utf8')).status,'pending_live_approval');
  // Tampered bytes fail before an experiment can use them.
  await writeFile(join(temp,'images/after.png'),'corrupt');const bad=spawn(join(root,'node_modules/.bin/tsx'),[join(root,'evaluation/larchwood.ts'),'preview','--dataset',join(temp,'dataset.json'),'--out',join(temp,'bad')],{env:{...process.env,POSTGRES_PASSWORD:'',SCOUT_API_TOKEN:''},stdio:'ignore'});assert.notEqual(await new Promise(r=>bad.once('exit',r)),0);
 }finally{await rm(temp,{recursive:true,force:true});}
});
