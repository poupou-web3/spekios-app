// Workspace state shared by views and actions. Values that several modules change live on
// `state`; a module-level `let` is only ever assigned by the module that declares it.
export const root = document.querySelector('#app');
export const state = { token: sessionStorage.getItem('scout.workspace-token') || '', connected:false, runs:[], jobs:[], workers:[], settings:{}, providers:{providers:[]}, report:null, runId:null, actionId:null, view:'workspace', tab:'actions', image:'after', search:'', drawer:null, submitting:false, cancelling:new Set(), error:'', url:'', viewportProfile:null, access:{requests:[],sessions:[]}, authMode:'auto', sessionId:'' };
Object.assign(state,{runFilter:'all',runMode:'all',lastUpdatedAt:null,trackedJobId:null,developmentAccess:false,settingsRevision:0,configurationDraft:null,composing:false,launchError:'',memory:null,memoryError:''});
const storedTrackedJob=sessionStorage.getItem('scout.tracked-job');
if(/^[\da-f-]{36}$/.test(storedTrackedJob||''))state.trackedJobId=storedTrackedJob;
export const imageCache = new Map(), imagePending = new Set(), reviewDrafts = new Map();
export const steeringDrafts = new Map();
const savedAutomaticChoice=sessionStorage.getItem('scout.auto-reproduce');
state.autoReproduce=savedAutomaticChoice==='true'?true:savedAutomaticChoice==='false'?false:null;
