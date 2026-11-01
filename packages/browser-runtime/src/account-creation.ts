import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import { accessSignals } from './access-detection.js';

export type TestAccount = { email:string; name:string; password:string };
export type AccountStep = 'progress'|'ready'|'signup_not_found'|'verification_required'|'unsupported_signup'|'signup_not_completed';
const registration=/\b(sign[ -]?up|register|registration|create (?:an? )?account|inscription|créer (?:un )?compte)\b/i;
export function testAccount(email:unknown,name:unknown):TestAccount {
  if(typeof email!=='string'||email.length>254||! /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    ||typeof name!=='string'||!name.trim()||name.length>80||/[\x00-\x1f\x7f]/.test(name))throw new Error('invalid_account_details');
  return {email:email.trim(),name:name.trim(),password:'Qa!7'+randomBytes(18).toString('base64url')};
}

// This narrow signup driver runs inside the private-login boundary. Field values,
// page text and credentials never go to evidence or model requests. Each call does
// at most one submission/navigation so cancellation can run between steps.
export class AccountCreation {
  private readonly submissions=new Set<string>();
  private readonly links=new Set<string>();
  constructor(readonly account:TestAccount,private origin:string){}
  async step(page:Page):Promise<AccountStep>{
    if(new URL(page.url()).origin!==this.origin)return 'unsupported_signup';
    const snapshot=await page.evaluate(()=>{
      const dom={visible(e:Element){const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}};
      const fields=Array.from(document.querySelectorAll('input,textarea,select'));
      return {
        challenge:Array.from(document.querySelectorAll('iframe,[data-sitekey]')).some(e=>dom.visible(e)&&
          (/captcha|challenge/i.test(e.getAttribute('title')??'')||e.hasAttribute('data-sitekey'))),
        verification:Array.from(document.querySelectorAll('input[autocomplete="one-time-code"]')).some(e=>dom.visible(e)),
        forms:Array.from(document.forms).map((f,index)=>({index,action:f.action,method:f.method,target:f.target,text:(f.textContent??'').slice(0,2000),
          fields:fields.flatMap((node,i)=>{
            if(!(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement||node instanceof HTMLSelectElement)||node.form!==f||!dom.visible(node)||node.disabled)return [];
            return [{index:i,type:node.type,required:node.required,filled:!!node.value,checked:node instanceof HTMLInputElement&&node.checked,
              hint:[node.name,node.id,node.getAttribute('autocomplete'),node.getAttribute('aria-label'),Array.from(node.labels??[]).map(l=>l.textContent).join(' ')].join(' ').toLowerCase()}];
          }),
          buttons:Array.from(f.querySelectorAll('button,input[type=submit]')).flatMap((b,i)=>dom.visible(b)&&!(b as HTMLButtonElement).disabled?
            [{index:i,type:(b as HTMLButtonElement).type,action:(b as HTMLButtonElement).formAction,target:(b as HTMLButtonElement).formTarget,method:b.getAttribute('formmethod')||f.method,
              label:b.textContent||(b as HTMLInputElement).value||''}]:[])})),
        links:Array.from(document.querySelectorAll('a[href]')).flatMap((a,i)=>dom.visible(a)?[{index:i,href:(a as HTMLAnchorElement).href,label:a.textContent??''}]:[]),
      };
    });
    if(snapshot.challenge)return 'verification_required';
    const signals=await accessSignals(page);
    if(signals.signed_in&&!signals.login_form)return 'ready';
    const form=snapshot.forms.find(f=>(registration.test(f.action)||f.buttons.some(b=>b.type==='submit'&&registration.test(b.label)))
      &&f.fields.some(c=>['email','password'].includes(c.type)||/email|e-mail/.test(c.hint)));
    if(!form){
      const link=snapshot.links.find(l=>(registration.test(l.label)||/^get started$/i.test(l.label.trim()))&&new URL(l.href).origin===this.origin&&!this.links.has(l.href));
      if(!link)return this.submissions.size||snapshot.verification?'verification_required':'signup_not_found';
      this.links.add(link.href);
      await page.locator('a[href]').nth(link.index).click({timeout:2500});
      await page.waitForLoadState('domcontentloaded',{timeout:2500}).catch(()=>{});
      return 'progress';
    }
    if(snapshot.verification)return 'verification_required';
    if(form.method!=='post'||new URL(form.action).origin!==this.origin||!['','_self'].includes(form.target)||form.fields.length>20)return 'unsupported_signup';
    const signature=JSON.stringify([page.url(),form.action,form.fields.map(f=>[f.type,f.hint])]);
    if(this.submissions.has(signature))return 'signup_not_completed';
    const fills:{index:number;type:string;value:string}[]=[],checks:number[]=[];
    for(const field of form.fields){
      if(['submit','button','hidden'].includes(field.type))continue;
      const hint=field.hint.replace(/[_-]/g,' ');
      if(field.type==='checkbox'){
        if(field.required&&!field.checked){if(!/terms|conditions|privacy|agree|accept|conditions générales/i.test(hint))return 'unsupported_signup';checks.push(field.index);}
        continue;
      }
      let value:string|undefined;
      if(field.type==='password')value=this.account.password;
      else if(field.type==='email'||/\b(e ?mail|emailaddress)\b/.test(hint))value=this.account.email;
      else if(/\b(first ?name|given name|prénom)\b/.test(hint))value=this.account.name.split(' ')[0];
      else if(/\b(last ?name|family name|surname|nom de famille)\b/.test(hint))value=this.account.name.split(' ').slice(1).join(' ')||'QA';
      else if(/\b(user ?name|login)\b/.test(hint))value=this.account.email.split('@')[0];
      else if(/\b(name|full name|display name|nom)\b/.test(hint))value=this.account.name;
      if(value&&['text','email','password'].includes(field.type))fills.push({index:field.index,type:field.type,value});
      else if(field.required&&!field.filled)return /phone|mobile|tel|code|otp/.test(hint+' '+field.type)?'verification_required':'unsupported_signup';
    }
    const submit=form.buttons.find(b=>b.type==='submit'&&registration.test(b.label))??form.buttons.find(b=>b.type==='submit'&&/^(continue|next|get started|suivant|continuer)$/i.test(b.label.trim()));
    if(!submit||submit.method!=='post'||new URL(submit.action||form.action).origin!==this.origin||!['','_self'].includes(submit.target))return 'unsupported_signup';
    const elements=page.locator('input,textarea,select');
    for(const fill of fills){
      const field=elements.nth(fill.index);
      if(await field.evaluate(e=>(e as HTMLInputElement).type)!==fill.type)return 'unsupported_signup';
      await field.fill(fill.value,{timeout:1500});
    }
    for(const check of checks)await elements.nth(check).check({timeout:1500});
    // Reserve before dispatch. A validation error or uncertain response must not
    // create a second account by automatically submitting the same form again.
    this.submissions.add(signature);
    await page.locator('form').nth(form.index).locator('button,input[type=submit]').nth(submit.index).click({timeout:2500});
    await page.waitForLoadState('domcontentloaded',{timeout:2500}).catch(()=>{});
    return 'progress';
  }
}
