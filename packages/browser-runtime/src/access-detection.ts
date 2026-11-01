import type { Page } from 'playwright';

export type AccessSignals={login_form:boolean;login_option:boolean;signed_in:boolean};
// Returns booleans only. No field values, page text, URLs or credentials are retained.
export async function accessSignals(page:Page):Promise<AccessSignals>{
  return page.evaluate(()=>{
    const auth=/\b(sign[ -]?in|log[ -]?in|authenticate|verification code|one.time.code)\b/i;
    // Inline callbacks avoid transpiler-only named-function helpers in the page.
    const controls=Array.from(document.querySelectorAll('button,a,input[type=submit],[role=button]')).flatMap(e=>{
      const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'?[e.getAttribute('aria-label')||e.textContent||(e as HTMLInputElement).value||'']:[];
    });
    const loginForm=Array.from(document.querySelectorAll('input')).some(e=>{
      const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&
        (e.type==='password'||e.autocomplete==='one-time-code'||(e.type==='email'&&auth.test(e.form?.textContent??'')));
    });
    return {login_form:loginForm,login_option:controls.some(label=>auth.test(label)),
      signed_in:controls.some(label=>/\b(sign[ -]?out|log[ -]?out)\b/i.test(label))};
  });
}
export class AccessStopped extends Error {constructor(readonly reason:string){super(reason);}}
export class PrivateLoginSurface extends Error {constructor(){super('Private login surface: observation omitted; human sign-in is required.');}}
export class AccessContextChanged extends Error {constructor(){super('App authentication changed the app context. Navigation assessment is omitted; exploration restarts from fresh authenticated evidence.');}}
