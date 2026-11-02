import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const script=fileURLToPath(new URL('./resolve-release.sh',import.meta.url));
test('prod releases resolve only matching main code, including merges and older queued pushes',()=>{
  const cwd=mkdtempSync(join(tmpdir(),'spekios-release-'));
  const git=(...args)=>{
    const r=spawnSync('git',args,{cwd,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  const resolve=(event,ref='')=>spawnSync('bash',[script,event,ref],{cwd,encoding:'utf8'});
  const commit=(name)=>{writeFileSync(join(cwd,'content'),name);git('add','content');git('commit','-m',name);return git('rev-parse','HEAD');};
  try{
    git('init','-b','main');git('config','user.name','Release test');git('config','user.email','release@example.invalid');
    const base=commit('base');
    git('checkout','-b','feature');const feature=commit('feature');
    git('checkout','main');const main=commit('main');git('update-ref','refs/remotes/origin/main',main);
    git('checkout','-b','prod',base);git('merge','--no-ff','main','-m','release main');const release=git('rev-parse','HEAD');
    for(const ref of [main,release]){const r=resolve('push',ref);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),main);}
    for(const ref of ['',base,main.slice(0,12)]){const r=resolve('workflow_dispatch',ref);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),ref===base?base:main);}
    assert.notEqual(resolve('workflow_dispatch',feature).status,0);
    assert.notEqual(resolve('workflow_dispatch','--help').status,0);
    assert.notEqual(resolve('push',feature).status,0);
    const unmerged=commit('prod-only');assert.notEqual(resolve('push',unmerged).status,0);
    git('checkout','main');const newer=commit('newer main');git('update-ref','refs/remotes/origin/main',newer);
    const queued=resolve('push',release);assert.equal(queued.status,0,queued.stderr);assert.equal(queued.stdout.trim(),main);
    assert.notEqual(resolve('pull_request',main).status,0);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
