import {state} from './state.js';
import {groupWebsites,rememberWebsiteShortcut,saveWebsite,websiteOrigin} from './websites.js';

export function workspaceWebsites(){
  const sites=groupWebsites(state.websites,state.runs);
  // Admission can be queued before its first run exists. Keep that website selectable too.
  for(const job of state.jobs){const origin=websiteOrigin(job.request?.target_url);if(origin&&!sites.some(site=>site.origin===origin))sites.push({origin,target_url:job.request.target_url,run_count:0});}
  return sites;
}
export function selectedWebsite(){return workspaceWebsites().find(site=>site.origin===state.websiteOrigin)||null;}
export function websiteRuns(){return state.websiteOrigin?state.runs.filter(run=>websiteOrigin(run.target_url)===state.websiteOrigin):state.runs;}
export function selectWebsite(origin,{prefill=false}={}){
  const normalized=websiteOrigin(origin);if(!normalized)return;
  if(state.websiteOrigin!==normalized){state.websiteOrigin=normalized;state.runOffset=0;state.runNextOffset=null;state.runTotal=0;state.search='';state.runFilter='all';state.runMode='all';state.sessionId='';state.launchError='';}
  saveWebsite(normalized);
  if(prefill){state.url=selectedWebsite()?.target_url||normalized+'/';state.launchError='';}
}
export function rememberWorkspacePage(){
  const run=state.report?.run;
  if(run){selectWebsite(run.target_url);rememberWebsiteShortcut(state.websiteOrigin,state.tab==='flow'?'flow':state.tab==='findings'?'findings':'run',run);}
  else if(state.view==='workspace'&&state.websiteOrigin)rememberWebsiteShortcut(state.websiteOrigin,state.websitePage||'overview');
}
