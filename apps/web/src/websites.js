// Website identity and navigation shared by the workspace, issues and agent pages.
// A website is one origin: entry paths share history; staging hosts and ports do not.
import {icon} from '/assets/ui/components.js';
import {date,esc,number} from '/assets/ui/format.js';

const WEBSITE_SELECTION_KEY='scout.website';
const WEBSITE_SHORTCUTS_KEY='scout.website-shortcuts';
const FAVICON_PATHS=['/favicon.ico','/favicon.png','/favicon.svg','/apple-touch-icon.png'];
const faviconChoices=new Map(),missingFavicons=new Set();
const WEBSITE_PAGES={overview:['Overview','home'],tests:['Tests','layers'],issues:['Issues & fixes','bug'],run:['Test report','report'],findings:['Findings','bug'],flow:['Flow map','flow']};

export function websiteOrigin(value){
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.origin:'';}catch{return '';}
}
export function normalizeTargetUrl(value){
  const text=String(value??'').trim();
  if(!text||/^[a-z][a-z\d+.-]*:\/\//i.test(text))return text;
  return (/^(?:localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(text)?'http://':'https://')+text;
}
export function launchUrlError(url){
  if(!url)return 'Paste the address of the app you want to test.';
  try{const parsed=new URL(url);if(url.length<=2048&&['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password&&!/\s/.test(url)&&/^(?:[a-z\d-]+\.)*[a-z\d-]+$|^\[[\da-f:.]+\]$/i.test(parsed.hostname))return '';}catch{}
  return 'That doesn\'t look like a web address. Try something like your-app.example.';
}
export function websiteLabel(origin){try{return new URL(origin).host;}catch{return 'Your websites';}}
export function websitePath(value){try{const url=new URL(value);return url.pathname+url.search+url.hash;}catch{return '/';}}
export function savedWebsite(){try{return websiteOrigin(sessionStorage.getItem(WEBSITE_SELECTION_KEY));}catch{return '';}}
export function saveWebsite(origin){try{if(websiteOrigin(origin))sessionStorage.setItem(WEBSITE_SELECTION_KEY,websiteOrigin(origin));else sessionStorage.removeItem(WEBSITE_SELECTION_KEY);}catch{}}
export function clearWebsiteNavigation(){try{sessionStorage.removeItem(WEBSITE_SELECTION_KEY);sessionStorage.removeItem(WEBSITE_SHORTCUTS_KEY);}catch{}}
export function websiteHref(origin,page='overview',external=false){
  const hash=origin?'#/website/'+encodeURIComponent(origin)+(page==='tests'?'/tests':''):'#/workspace';
  return (external?'/':'')+hash;
}
export function websiteIssuesHref(origin){return '/issues'+(origin?'?origin='+encodeURIComponent(origin):'');}
export function groupWebsites(catalog=[],runs=[]){
  const sites=new Map(),catalogOrigins=new Set();
  for(const site of catalog){const origin=websiteOrigin(site.origin);if(origin){catalogOrigins.add(origin);sites.set(origin,{...site,origin});}}
  for(const run of runs){
    const origin=websiteOrigin(run.target_url);if(!origin)continue;
    const site=sites.get(origin);
    if(!site)sites.set(origin,{origin,target_url:run.target_url,run_count:1,last_test_at:run.created_at});
    else if(!catalogOrigins.has(origin))site.run_count++;
  }
  return [...sites.values()];
}
export function websiteFavicon(origin){
  const clean=websiteOrigin(origin),path=faviconChoices.get(clean)||FAVICON_PATHS[0];
  return `<span class="website-favicon" aria-hidden="true">${icon('globe')}${clean&&!missingFavicons.has(clean)?`<img src="${esc(clean+path)}" alt="" width="20" height="20" referrerpolicy="no-referrer" loading="lazy" data-website-icon="${esc(clean)}" data-icon-path="${esc(path)}">`:''}</span>`;
}
export function bindWebsiteFavicons(container){
  container.addEventListener('error',event=>{
    const image=event.target,origin=image.dataset?.websiteIcon;if(!origin)return;
    const next=FAVICON_PATHS.indexOf(image.dataset.iconPath)+1;
    if(next>=FAVICON_PATHS.length){missingFavicons.add(origin);image.remove();return;}
    image.dataset.iconPath=FAVICON_PATHS[next];image.src=origin+FAVICON_PATHS[next];
  },true);
  container.addEventListener('load',event=>{const image=event.target;if(image.dataset?.websiteIcon)faviconChoices.set(image.dataset.websiteIcon,image.dataset.iconPath);},true);
}
function shortcutStore(){try{const value=JSON.parse(sessionStorage.getItem(WEBSITE_SHORTCUTS_KEY)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
export function rememberWebsiteShortcut(origin,kind,run=null){
  if(!websiteOrigin(origin)||!WEBSITE_PAGES[kind])return;
  const item={kind,...(run?{runId:run.run_id,path:websitePath(run.target_url),createdAt:run.created_at}:{})},all=shortcutStore();
  const prior=Array.isArray(all[origin])?all[origin]:[];
  all[origin]=[item,...prior.filter(s=>s.kind!==kind||s.runId!==item.runId)].slice(0,3);
  try{sessionStorage.setItem(WEBSITE_SHORTCUTS_KEY,JSON.stringify(Object.fromEntries(Object.entries(all).slice(-30))));}catch{}
}
export function websiteShortcuts(origin,runs=[]){
  const saved=shortcutStore()[origin];
  const items=Array.isArray(saved)&&saved.length?saved:runs.slice(0,2).map(run=>({kind:'run',runId:run.run_id,path:websitePath(run.target_url),createdAt:run.created_at}));
  return items.filter(item=>WEBSITE_PAGES[item.kind]&&(!['run','findings','flow'].includes(item.kind)||/^[\da-f-]{36}$/.test(item.runId||''))).slice(0,3);
}
function shortcutHref(origin,item,external){
  if(item.kind==='issues')return websiteIssuesHref(origin);
  if(['run','findings','flow'].includes(item.kind))return (external?'/':'')+'#/workspace/'+item.runId+(item.kind==='run'?'':'/'+item.kind);
  return websiteHref(origin,item.kind,external);
}
export function websiteSidebar({websites=[],origin='',page='overview',runId=null,runs=[],newUrl='',error='',submitting=false,external=false,bottom='',canLaunch=true}){
  const selected=websites.find(site=>site.origin===origin),count=selected?.run_count??runs.length;
  return `<aside class="sidebar project-sidebar"><a class="brand" href="${websiteHref(origin,'overview',external)}" aria-label="Spekios workspace"><span class="mark">${icon('scout')}</span>Spekios</a><div class="project-navigation"><details class="website-switcher" data-disclosure="website-switcher"><summary aria-label="Choose website or test a new URL">${websiteFavicon(origin)}<span class="website-choice"><strong>${esc(websiteLabel(origin))}</strong><small>${origin?'Website workspace':'Start exploring'}</small></span>${icon('switch')}</summary><div class="website-menu"><p class="eyebrow">Your websites</p><div class="website-options">${websites.map(site=>`<a class="website-option ${site.origin===origin?'selected':''}" href="${websiteHref(site.origin,'overview',external)}" ${site.origin===origin?'aria-current="true"':''}>${websiteFavicon(site.origin)}<span>${esc(websiteLabel(site.origin))}<small>${number(site.run_count)} ${Number(site.run_count)===1?'test':'tests'}</small></span>${site.origin===origin?icon('check'):''}</a>`).join('')||'<p class="small muted">Websites you test appear here.</p>'}</div><form id="website-launch-form" class="website-new" novalidate><label for="website-url">Test a new URL</label><div><input id="website-url" name="url" type="text" inputmode="url" maxlength="2048" required placeholder="https://your-website.com" autocomplete="url" autocapitalize="off" spellcheck="false" value="${esc(newUrl)}" aria-describedby="website-launch-error"${error?' aria-invalid="true"':''}><button class="button primary" type="submit" aria-label="Start test for new URL" ${submitting||!canLaunch?'disabled':''}>${icon('arrow')}</button></div><p id="website-launch-error" class="small ${error?'error':'muted'}" ${error?'role="alert"':''}>${esc(error||'Same website? Its tests stay together.')}</p></form></div></details><nav aria-label="Website navigation">${[['overview','Overview','home'],['tests','Tests','layers']].map(([key,label,glyph])=>`<a class="nav-item ${page===key?'active':''}" href="${websiteHref(origin,key,external)}" ${page===key?'aria-current="page"':''}>${icon(glyph)}${label}${key==='tests'?`<span class="nav-count">${number(count)}</span>`:''}</a>`).join('')}<a class="nav-item ${page==='issues'?'active':''}" href="${websiteIssuesHref(origin)}" ${page==='issues'?'aria-current="page"':''}>${icon('bug')}Issues & fixes</a></nav></div><div class="recent website-shortcuts"><div class="eyebrow">Recent shortcuts</div>${websiteShortcuts(origin,runs).map(item=>`<a class="recent-item ${runId&&item.runId===runId?'selected':''}" href="${shortcutHref(origin,item,external)}">${icon(WEBSITE_PAGES[item.kind][1])}<span>${esc(WEBSITE_PAGES[item.kind][0])}${item.runId?`<small>${esc(item.path||'/')} · ${esc(date(item.createdAt))}</small>`:''}</span></a>`).join('')||'<p class="small muted">Your recent pages appear here.</p>'}</div><div class="side-bottom"><nav aria-label="Workspace navigation"><a class="nav-item ${page==='connect'?'active':''}" href="/connect">${icon('code')}Connect your agent</a><a class="nav-item ${page==='settings'?'active':''}" href="${external?'/':''}#/settings">${icon('settings')}Settings</a></nav>${bottom}</div></aside>`;
}
