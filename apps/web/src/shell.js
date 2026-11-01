// Workspace frame (sidebar, top bar) and the sign-in screen. It links only to customer pages.
import {icon} from '/assets/ui/components.js';
import {date,esc,name,number} from '/assets/ui/format.js';
import {themeSwitch} from '/assets/ui/theme.js';
import {root,state} from './state.js';
import {activityButton} from './views/activity.js';
import {drawer} from './views/drawer.js';
import {settingsSectionTitle} from './views/settings.js';
import {selectedWebsite,websiteRuns,workspaceWebsites} from './website-state.js';
import {websiteHref,websiteLabel,websiteSidebar} from './websites.js';
export function login(){
  if(state.spekiosAuth){root.innerHTML=`<main class="login" id="main-content"><div class="login-card"><div class="brand">Spekios</div><h1>Welcome to Spekios</h1><p>Sign in to access your workspace, settings and test history.</p>${state.error?`<div class="login-error" role="alert">${esc(state.error)}</div>`:""}<a class="button primary" href="/login">Sign in or create an account</a></div></main>`;return;}
  root.innerHTML=`<main class="login" id="main-content" tabindex="-1"><form id="login-form" class="login-card"><div class="brand"><span class="mark">${icon('scout')}</span>Spekios<small>QA WORKSPACE</small></div><h1>See what your agent sees.</h1><p>Explore user flows, review the evidence, and understand every step along the way.</p><label for="email">Email</label><input id="email" name="email" type="text" required maxlength="254" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="admin"><label for="password">Password</label><input id="password" name="password" type="password" required minlength="32" maxlength="256" autocomplete="current-password" placeholder="Password">${state.error?`<div class="login-error" role="alert">${esc(state.error)}</div>`:''}<button class="button primary" type="submit">Sign in ${icon('arrow')}</button><div class="small">For this local workspace, sign in with email admin. The password is SCOUT_API_TOKEN from this project's .env file. It stays in this browser tab and is never added to the URL.</div></form></main>`;
}
export function shell(content){
  const current=state.report?.run,settings=state.view==='settings',home=!settings&&!state.runId,worker=state.workers.some(w=>w.available);
  const page=settings?'settings':state.runId?'tests':state.websitePage||'overview';
  const bottom=`<div class="environment"><i class="dot ${worker?'green':'amber'}"></i><div>Workspace<div class="small muted">${worker?'Browser worker online':'Browser worker offline'}</div></div></div>${state.developmentAccess?'<p class="small muted dev-access-note">Local development · sign-in disabled</p>':`<button data-action="logout">${icon('logout')}Sign out</button>`}`;
  const sidebar=websiteSidebar({websites:workspaceWebsites(),origin:state.websiteOrigin,page,runId:state.runId,runs:websiteRuns(),newUrl:state.websiteUrl,error:state.websiteLaunchError,submitting:state.submitting,activity:activityButton(),bottom});
  const site=selectedWebsite(),heading=page==='tests'?'Tests':'Overview';
  const breadcrumb=settings?`<a href="#/settings">Settings</a>${icon('chevron')}<span>${esc(settingsSectionTitle())}</span>`:`<a href="${websiteHref(state.websiteOrigin)}">${esc(site?websiteLabel(site.origin):'Workspace')}</a>${icon('chevron')}<span>${current?esc(name(current)):heading}</span>`;
  return `<div class="app website-app">${sidebar}<main class="main" id="main-content" tabindex="-1"><header class="topbar"><div class="breadcrumb">${icon('grid')}${breadcrumb}</div><div class="topbar-right"><span>${state.error?'Refresh interrupted':state.lastUpdatedAt?'Updated '+esc(date(state.lastUpdatedAt)):'Recorded evidence'}</span><button class="button icon" data-action="refresh" aria-label="Refresh workspace">${icon('refresh')}</button>${themeSwitch()}${state.developmentAccess?'<span class="pill dev-access-badge">DEV</span>':`<button class="button icon mobile-logout" data-action="logout" aria-label="Sign out">${icon('logout')}</button>`}<div class="avatar" aria-label="Your account">S</div></div></header><div class="content${home&&page==='overview'?' content-landing website-overview':''}">${content}</div></main><footer class="website-mobile-nav">${activityButton(true)}<a href="/connect">${icon('code')}Connect your agent</a><a href="#/settings">${icon('settings')}Settings</a></footer>${drawer()}</div>`;
}
