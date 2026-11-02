// Back office state. Values that several modules change live on `state`.
export const root = document.querySelector('#app');
export const state = { token: sessionStorage.getItem('scout.backoffice-token') || '', connected:false, developmentAccess:false, error:'', lastUpdatedAt:null, runs:[], jobs:[], workers:[], settings:{}, providers:{providers:[]}, operations:{}, usage:{}, report:null, reportEtag:'', runId:null, opsTab:'overview', drawer:null, cancelling:new Set(), expanded:new Set(), composing:false };
Object.assign(state,{jobSearch:'',jobFilter:'all',jobMode:'all',modelSearch:'',modelProvider:'all',modelStatus:'all',modelPurpose:'all',eventSearch:''});
Object.assign(state,{demo:null,demoDraft:null,demoError:'',demoMessage:'',submitting:false});
export const TABS = ['overview','jobs','models','events','connections','credits'];
