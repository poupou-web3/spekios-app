// Workspace addresses are plain paths: /workspace (the project list), /website/<origin>[/tests],
// /workspace/<run>[/findings|/flow|/<action>] and /settings[/<section>]. Inside the workspace a link
// to one of them changes the page without reloading; elsewhere (the Connect and Issues pages) it
// loads the workspace normally. Addresses from before paths (/#/settings) still open their page.
let navigationRoute=null;

const WORKSPACE_PATH=/^\/(?:$|(?:workspace|website|settings)(?:[/?]|$))/;
export function isWorkspacePath(href){return typeof href==='string'&&WORKSPACE_PATH.test(href);}

// The address being shown, as a path. An old `#/…` address is read the same way.
export function currentPath(){
  const location=globalThis.location||{},hash=location.hash||'';
  return /^#\/./.test(hash)?hash.slice(1):location.pathname||'/';
}
// Replaces an old `#/…` address with its path, keeping the page.
export function normalizeAddress(){
  const hash=globalThis.location?.hash||'';
  if(/^#\/./.test(hash))globalThis.history?.replaceState?.(null,'',hash.slice(1));
}

export function enableNavigation(route){navigationRoute=route;}
export function go(href){
  if(navigationRoute&&globalThis.history?.pushState&&isWorkspacePath(href)){
    const here=(globalThis.location.pathname||'')+(globalThis.location.search||'');
    if(href!==here){globalThis.history.pushState(null,'',href);globalThis.scrollTo?.(0,0);}
    return navigationRoute();
  }
  const location=globalThis.location;
  if(typeof location?.assign==='function')location.assign(href);else if(location)location.href=href;
}
// Same-tab, unmodified clicks on workspace links stay in the page.
export function followLink(event){
  if(!navigationRoute||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return false;
  const link=event.target?.closest?.('a[href]');
  if(!link||link.target||link.hasAttribute?.('download'))return false;
  const href=link.getAttribute('href');
  if(!isWorkspacePath(href))return false;
  event.preventDefault();
  // A link with its own action (open findings, focus the launch form…) is handled by that action.
  if(!link.dataset?.action)void go(href);
  return true;
}
