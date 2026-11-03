// Workspace frame (sidebar, top bar) and the sign-in screen. It links only to customer pages.
import {icon} from '/assets/ui/components.js';
import {date,esc,name,number} from '/assets/ui/format.js';
import {root,state} from './state.js';
import {activityButton} from './views/activity.js';
import {drawer} from './views/drawer.js';
import {accountMenuMarkup} from './account-menu.js';
import {settingsSectionTitle} from './views/settings.js';
import {selectedWebsite,websiteRuns,workspaceWebsites} from './website-state.js';
import {mobileNav,websiteHref,websiteLabel,websiteSidebar,workspaceHref,workspaceSidebar} from './websites.js';
// Signing in returns to the workspace page that asked for it (the server accepts only workspace paths).
function loginHref(){const path=globalThis.location?.pathname||'/';return /^\/(?:(?:workspace|settings)(?:\/[^?#]*)?|website\/[^?#]+)$/.test(path)&&!path.includes('//')&&!/\/$/.test(path)?'/login?next='+encodeURIComponent(path):'/login';}
export function login(){
  if(state.spekiosAuth){root.innerHTML=`<main class="login" id="main-content"><div class="login-card"><div class="brand">Spekios</div><h1>Welcome to Spekios</h1><p>Sign in to access your workspace, settings and test history.</p>${state.error?`<div class="login-error" role="alert">${esc(state.error)}</div>`:""}<a class="button primary" href="${loginHref()}">Sign in or create an account</a></div></main>`;return;}
  root.innerHTML=`<main class="login" id="main-content" tabindex="-1"><form id="login-form" class="login-card"><div class="brand"><span class="mark">${icon('scout')}</span>Spekios<small>QA WORKSPACE</small></div><h1>See what your agent sees.</h1><p>Explore user flows, review the evidence, and understand every step along the way.</p><label for="email">Email</label><input id="email" name="email" type="text" required maxlength="254" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="admin"><label for="password">Password</label><input id="password" name="password" type="password" required minlength="32" maxlength="256" autocomplete="current-password" placeholder="Password">${state.error?`<div class="login-error" role="alert">${esc(state.error)}</div>`:''}<button class="button primary" type="submit">Sign in ${icon('arrow')}</button><div class="small">For this local workspace, sign in with email admin. The password is SCOUT_API_TOKEN from this project's .env file. It stays in this browser tab and is never added to the URL.</div></form></main>`;
}
export function shell(content){
  const current=state.report?.run,settings=state.view==='settings',home=!settings&&!state.runId,worker=state.workers.some(w=>w.available);
  const page=settings?'settings':state.runId?'tests':state.websitePage||'overview';
  // Account, status and sign-out live in the account menu. The sidebar only warns when tests cannot run.
  const bottom=worker?'':`<div class="environment"><i class="dot amber"></i><div>Workspace<div class="small muted">Browser worker offline</div></div></div>`;
  // The project list and settings cover the whole workspace; every other page belongs to one project.
  const workspacePage=settings||page==='landing';
  const sidebar=workspacePage?workspaceSidebar({websites:workspaceWebsites(),page:settings?'settings':'projects',activity:activityButton(),bottom})
    :websiteSidebar({websites:workspaceWebsites(),origin:state.websiteOrigin,page,runId:state.runId,runs:websiteRuns(),newUrl:state.websiteUrl,error:state.websiteLaunchError,submitting:state.submitting,activity:activityButton(),bottom});
  const site=selectedWebsite(),heading=page==='tests'?'Tests':'Overview';
  const breadcrumb=settings?`<a href="/settings">Settings</a>${icon('chevron')}<span>${esc(settingsSectionTitle())}</span>`
    :page==='landing'?'<span>Projects</span>'
    :`<a href="${workspaceHref()}">Projects</a>${icon('chevron')}<a href="${websiteHref(state.websiteOrigin)}">${esc(site?websiteLabel(site.origin):'Project')}</a>${icon('chevron')}<span>${current?esc(name(current)):heading}</span>`;
  return `<div class="app website-app">${sidebar}<main class="main" id="main-content" tabindex="-1"><header class="topbar"><div class="breadcrumb">${icon('grid')}${breadcrumb}</div><div class="topbar-right"><span>${state.error?'Refresh interrupted':state.lastUpdatedAt?'Updated '+esc(date(state.lastUpdatedAt)):'Recorded evidence'}</span><button class="button icon" data-action="refresh" aria-label="Refresh workspace">${icon('refresh')}</button>${state.developmentAccess?'<span class="pill dev-access-badge">DEV</span>':''}${accountMenu(worker)}</div></header><div class="content${home&&page==='overview'?' content-landing website-overview':home&&page==='landing'?' content-landing website-overview workspace-landing-page':''}">${content}</div></main><footer class="website-mobile-nav">${mobileNav(activityButton(true))}</footer>${drawer()}</div>`;
}
// The account menu, with this workspace's live status.
export function accountMenu(worker=state.workers.some(w=>w.available)){
  return accountMenuMarkup({name:state.identity?.workspace_name,development:state.developmentAccess,browserAuth:state.browserAuth,worker,gateway:state.providers.gateway_ready===true});
}
