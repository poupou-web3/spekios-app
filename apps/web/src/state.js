// Workspace state shared by views and actions. Values that several modules change live on
// `state`; a module-level `let` is only ever assigned by the module that declares it.
export const root = document.querySelector('#app');
export const state = { token: sessionStorage.getItem('scout.workspace-token') || '', connected:false, browserAuth:false, spekiosAuth:false, runs:[], jobs:[], workers:[], settings:{}, providers:{providers:[]}, report:null, reportEtag:'', runId:null, actionId:null, view:'workspace', tab:'actions', image:'after', search:'', drawer:null, submitting:false, cancelling:new Set(), error:'', url:'', viewportProfile:null, access:{requests:[],sessions:[]}, authMode:'auto', sessionId:'' };
Object.assign(state,{settingsSection:'models',priceTarget:null,runFilter:'all',runMode:'all',lastUpdatedAt:null,trackedJobId:null,developmentAccess:false,settingsRevision:0,configurationDraft:null,composing:false,launchError:'',memory:null,memoryError:''});
// Per-launch choices: a project ID from settings and a model from the saved list ('provider|model'). Empty uses the defaults.
Object.assign(state,{launchProject:'',launchModel:''});
Object.assign(state,{websites:[],websiteOrigin:'',websitePage:'overview',websiteUrl:'',websiteLaunchError:'',runOffset:0,runNextOffset:null,runTotal:0,runListOrigin:''});
const storedTrackedJob=sessionStorage.getItem('scout.tracked-job');
if(/^[\da-f-]{36}$/.test(storedTrackedJob||''))state.trackedJobId=storedTrackedJob;
export const imageCache = new Map(), imagePending = new Set(), reviewDrafts = new Map();
export const steeringDrafts = new Map();
const savedAutomaticChoice=sessionStorage.getItem('scout.auto-reproduce');
state.autoReproduce=savedAutomaticChoice==='true'?true:savedAutomaticChoice==='false'?false:null;
