import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {appSource} from './support.mjs';

function privateView(identity=null){
  const handlers={},calls=[],saved=new Map(),nodes=new Map(),buttons=['cancel','key','complete','download-account'].map(value=>({dataset:{private:value},disabled:false,hidden:true}));
  const node=()=>({innerHTML:'',textContent:'',value:'',focus(){},replaceChildren(){this.innerHTML='';},addEventListener(){},querySelectorAll(){return[];}});
  const appNode=node();appNode.addEventListener=(type,fn)=>(handlers[type]??=[]).push(fn);
  const box=node();box.querySelectorAll=()=>buttons;box.querySelector=()=>({focus(){},insertAdjacentHTML(_position,html){box.accountForm=html;}});
  for(const id of ['private-title','private-status','private-screen','private-account-email','private-account-name','private-remember'])nodes.set(id,node());
  nodes.set('private-login',box);nodes.get('private-account-email').value='agent@example.test';nodes.get('private-account-name').value='Spekios QA';
  const form={id:'private-account-form',querySelectorAll:()=>[nodes.get('private-account-email'),nodes.get('private-account-name')],querySelector:selector=>selector==='[type="submit"]'?buttons[2]:buttons[3]};
  const account={email:'agent@example.test',name:'Spekios QA',password:'PRIVATE_GENERATED_PASSWORD'};
  const sandbox={document:{querySelector:selector=>selector==='#app'?appNode:node(),getElementById:id=>nodes.get(id),addEventListener(){}},window:{addEventListener(){}},
    sessionStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},setInterval(){},setTimeout(){return 0;},clearTimeout(){},URL,Blob,AbortSignal,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'},console,
    fetch:async(path,options)=>{
      calls.push({path,options});
      if(path.endsWith('/screen'))return new Promise(()=>{});
      const value=path.endsWith('/account-identity')?identity:path.endsWith('/start')?{lease:'private-lease'}:path.endsWith('/create-account')?{status:'creating',account}:{requests:[{access_id:'id',status:'active',verification:'account_creation_in_progress'}]};
      return {ok:true,status:200,json:async()=>value};
    }};
  vm.createContext(sandbox);vm.runInContext(appSource('main.js')+'\nglobalThis.ui={state,openPrivateLogin,syncPrivateAccess,closePrivateLogin,getLogin:()=>privateLogin};',sandbox);
  Object.assign(sandbox.ui.state,{token:'test-token',connected:true,access:{requests:[{access_id:'id',run_id:'run'}],sessions:[]}});
  return {...sandbox.ui,box,nodes,buttons,form,calls,saved,account,handlers};
}

test('creating an account is explicit, leased, single-attempt and separate from ordinary UI state',async()=>{
  const ui=privateView();await ui.openPrivateLogin('id',true);
  assert.match(ui.box.accountForm,/Test email/);assert.equal(ui.calls.filter(c=>c.path.endsWith('/create-account')).length,0);
  await ui.box.onsubmit({target:ui.form,preventDefault(){}});
  await ui.box.onsubmit({target:ui.form,preventDefault(){}});
  const requests=ui.calls.filter(c=>c.path.endsWith('/create-account'));assert.equal(requests.length,1);
  assert.equal(requests[0].options.headers['X-Spekios-Access-Lease'],'private-lease');
  assert.equal(JSON.parse(requests[0].options.body).email,ui.account.email);
  assert.ok(!requests[0].options.body.includes(ui.account.password));assert.ok(!JSON.stringify(ui.state).includes(ui.account.password));
  assert.ok(!JSON.stringify([...ui.saved]).includes(ui.account.password));assert.equal(ui.buttons[2].disabled,true);
  await ui.syncPrivateAccess([{access_id:'id',status:'active',verification:'account_creation_help_verification_required'}]);
  assert.match(ui.nodes.get('private-status').textContent,/CAPTCHA needs your help/);assert.equal(ui.buttons[2].disabled,false);
  await ui.closePrivateLogin(false);assert.equal(ui.getLogin(),null);
});

test('signup uses the connected Lovable identity without persisting it in ordinary app state',async()=>{
  const identity={source:'lovable',email:'linked@example.test'},ui=privateView(identity);ui.state.browserAuth=true;
  await ui.openPrivateLogin('id',true);
  assert.equal(ui.nodes.get('private-account-email').value,identity.email);
  assert.match(ui.box.accountForm,/connected Spekios account/);
  assert.ok(!JSON.stringify(ui.state).includes(identity.email));
  assert.equal(ui.calls.filter(c=>c.path.endsWith('/create-account')).length,0,'Connecting an identity must not submit a signup automatically.');
  ui.nodes.get('private-account-email').value='dedicated@example.test';
  await ui.box.onsubmit({target:ui.form,preventDefault(){}});
  const request=ui.calls.find(c=>c.path.endsWith('/create-account'));assert.equal(JSON.parse(request.options.body).email,'dedicated@example.test');
  await ui.closePrivateLogin(false);
});

test('successful signup resumes the run and offers a private download without rendering the password',async()=>{
  const ui=privateView();await ui.openPrivateLogin('id',true);await ui.box.onsubmit({target:ui.form,preventDefault(){}});
  await ui.syncPrivateAccess([{access_id:'id',status:'completed',verification:'account_created_entry_page_sign_out_control'}]);
  assert.equal(ui.getLogin(),null);assert.match(ui.box.innerHTML,/Test account ready/);assert.match(ui.box.innerHTML,/Download account details/);
  assert.ok(!ui.box.innerHTML.includes(ui.account.password));assert.ok(!JSON.stringify(ui.state).includes(ui.account.password));
  ui.box.onclick({target:{closest:()=>({dataset:{account:'close'}})}});assert.equal(ui.box.innerHTML,'');
});


test('Activity hands private account setup to its own dialog without starting signup automatically',async()=>{
  const ui=privateView();ui.state.drawer={activity:true,title:'Activity'};
  const element={dataset:{action:'create-account',id:'id'},tagName:'BUTTON'};
  await ui.handlers.click[0]({target:{closest:selector=>selector==='[data-action]'?element:null}});
  assert.equal(ui.state.drawer,null,'Activity closes before the private dialog opens.');
  assert.ok(ui.getLogin());assert.match(ui.box.accountForm,/Test email/);assert.equal(ui.calls.filter(c=>c.path.endsWith('/create-account')).length,0);
  assert.ok(!JSON.stringify(ui.state).includes(ui.account.password));await ui.closePrivateLogin(false);
});
