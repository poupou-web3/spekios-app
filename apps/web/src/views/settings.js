// Workspace settings, one section per page (#/settings/<section>): models, exploration, limits,
// memory and sessions, appearance. One draft spans the sections and the save bar follows it.
import {button,icon,toast} from '/assets/ui/components.js';
import {catalogEntry,catalogModels} from '/assets/ui/catalog.js';
import {MODEL_PROVIDERS,date,esc,number,providerName,short} from '/assets/ui/format.js';
import {knownPrice} from '/assets/ui/usage.js';
import {themePreference,themeSwitch} from '/assets/ui/theme.js';
import {api,get} from '../api.js';
import {render} from '../app.js';
import {state} from '../state.js';
// Server bounds. Exploration limits are optional: empty means no limit.
export const MAX_ACTIONS=10000,MAX_REPLAY_ACTIONS=100,MAX_SAVED_MODELS=30,MAX_MODEL_LABEL=60,MAX_USD_PER_MILLION=10000;
// A saved model's own prices, in USD per million tokens; empty uses the known price.
const PRICE_FIELDS=[['input_usd_per_million','inputUsdPerMillion','Input'],['output_usd_per_million','outputUsdPerMillion','Output']];
// A number input's value is canonical ("0") while a decimal is still being typed ("0.0"). Keep that text.
export function numericFieldValue(raw){
  if(raw==='')return null;const n=Number(raw);return Number.isFinite(n)&&String(n)===raw?n:raw;
}
const finite=v=>typeof v==='number'?v:typeof v==='string'&&v.trim()!==''&&Number.isFinite(Number(v))?Number(v):NaN;
const commitNumber=v=>v===null||v===''?null:Number.isFinite(finite(v))?finite(v):v;
export const LIMITS=[['max_actions','maxActions','Maximum actions',1,MAX_ACTIONS,1],['max_minutes','maxMinutes','Maximum minutes',1,10080,1],
  ['max_tokens','maxTokens','Maximum reported tokens',1000,1000000000,1],['max_cost_usd','maxCostUsd','Maximum reported cost (USD)',0.01,100000,0.01],
  ['stop_after_idle_actions','stopAfterIdleActions','Stop after actions with nothing new',5,1000,1]];
// How each run's actions are shared: new territory, deep journeys and re-walks of known paths.
export const STRATEGY=[['breadth','New territory'],['depth','Deep journeys'],['rewalk','Re-walk known paths']],DEFAULT_STRATEGY={breadth:50,depth:30,rewalk:20,adaptive:true};
// [key, title, icon, summary]. The first section opens on #/settings.
export const SETTINGS_SECTIONS=[['models','Models','bolt','Which models explore, and the list you pick them from'],['exploration','Exploration','flow','Screen size, strategy and automatic rechecks'],
  ['limits','Limits','clock','When explorations stop, per project or model'],['data','Memory & sessions','database','What runs remember and saved app sign-ins'],['appearance','Appearance','image','Light or dark theme in this browser']];
// The draft fields each form section edits, for its unsaved-changes mark and error links.
const SECTION_FIELDS={models:['provider','model','navigation_model','saved_models','project_models','free_only','reuse_rankings'],exploration:['viewport_profile','exploration_strategy','auto_reproduce','max_auto_reproductions','max_auto_replay_actions'],
  limits:[...LIMITS.map(([key])=>key),'limit_overrides'],data:['app_memory']};
export function settingsSection(){return SETTINGS_SECTIONS.some(([key])=>key===state.settingsSection)?state.settingsSection:SETTINGS_SECTIONS[0][0];}
export function settingsSectionTitle(){return SETTINGS_SECTIONS.find(([key])=>key===settingsSection())[1];}
const MAX_OVERRIDES=50,MAX_PROJECT_MODELS=50,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,MODEL_ID=/^[A-Za-z0-9/:._-]{1,200}$/,CONTROL=/[\x00-\x1f\x7f-\x9f]/;
// Model IDs never contain "|", so a provider and model ID make one option value.
const modelChoice=(provider,model)=>`${provider}|${model}`;
// A link to Settings → Models that opens at one model's prices (see focusPriceTarget).
export function priceLink(provider,model){return `#/settings/models/price/${encodeURIComponent(modelChoice(provider,model))}`;}
export const freeModel=model=>model==='openrouter/free'||String(model).endsWith(':free');
const splitChoice=value=>{const [provider,...rest]=String(value).split('|');return [provider,rest.join('|')];};
const paidOpenRouter=(provider,model)=>provider==='openrouter'&&!freeModel(String(model).trim());
// A project's model row. navigation is 'inherit' (the default navigation model), 'none' (the project's model does everything) or a listed model.
const projectRow=(p={})=>({project_id:p.projectId||'',label:p.label||'',choice:p.provider&&p.model?modelChoice(p.provider,p.model):'',
  navigation:!p||!Object.hasOwn(p,'navigationModel')?'inherit':p.navigationModel?modelChoice(p.navigationModel.provider,p.navigationModel.model):'none'});
// Free-only stays on unless the project deliberately uses a paid OpenRouter model.
export function projectPayload(row){
  const [provider,model]=splitChoice(row.choice),navigation=['inherit','none'].includes(row.navigation)?null:splitChoice(row.navigation);
  const item={project_id:row.project_id.trim(),...(row.label.trim()?{label:row.label.trim()}:{}),provider,model,free_only:!(paidOpenRouter(provider,model)||navigation&&paidOpenRouter(...navigation))};
  if(row.navigation!=='inherit')item.navigation_model=navigation?{provider:navigation[0],model:navigation[1]}:null;
  return item;
}
// The saved model list, plus the models in use so they stay available after switching away.
function modelList(saved,inUse){
  const list=[],seen=new Set();
  const add=(provider,model,label,prices={})=>{const id=String(model??'').trim();if(!MODEL_PROVIDERS.includes(provider)||!id||seen.has(modelChoice(provider,id)))return;seen.add(modelChoice(provider,id));list.push({provider,model:id,label:String(label??'').trim(),...Object.fromEntries(PRICE_FIELDS.map(([key])=>[key,prices[key]??null]))});};
  for(const m of Array.isArray(saved)?saved:[])add(m?.provider,m?.model,m?.label,m);
  for(const [provider,model] of inUse)add(provider,model,'');
  return list;
}
// Models project rows use: each project's model and any listed navigation model.
const projectChoices=rows=>rows.flatMap(row=>[row.choice,row.navigation]).filter(value=>value&&!['inherit','none'].includes(value)).map(splitChoice);
const inUseModels=values=>[[values.provider,values.model],[values.navigation_model.provider,values.navigation_model.model],...projectChoices(values.project_models)];
export function modelRoles(values,m){
  const nav=values.navigation_model;
  return [...(values.provider===m.provider&&values.model.trim()===m.model?['Exploration']:[]),...(nav.provider===m.provider&&nav.model.trim()===m.model?['Navigation']:[]),
    ...(projectChoices(values.project_models).some(([provider,model])=>provider===m.provider&&model===m.model)?['Project']:[])];
}
// True, false, or null while provider status is unknown.
function providerReady(provider){const p=(state.providers.providers||[]).find(x=>x.provider===provider);return p?p.configured===true:null;}
// An override row: what it matches and its limits. Empty limits inherit.
const overrideRow=(o={})=>({project_id:o.projectId||'',provider:o.provider||'',model:o.model||'',...Object.fromEntries(LIMITS.map(([key,camel])=>[key,o.limits?.[camel]??null]))});
export function overridePayload(row){
  const item={limits:{}};if(row.project_id.trim())item.project_id=row.project_id.trim();if(row.provider)item.provider=row.provider;if(row.model.trim())item.model=row.model.trim();
  for(const [key] of LIMITS){const n=commitNumber(row[key]);if(n!==null)item.limits[key]=n;}
  return item;
}
export function configurationValues(settings=state.settings){
  const provider=settings.provider||'openrouter',navigation_model={provider:settings.navigationModel?.provider||'',model:settings.navigationModel?.model||''},project_models=(Array.isArray(settings.projectModels)?settings.projectModels:[]).map(projectRow);
  return {provider,model:settings.model||'',...Object.fromEntries(LIMITS.map(([key,camel])=>[key,settings[camel]??null])),
    stop_after_idle_actions:settings.stopAfterIdleActions===undefined?50:settings.stopAfterIdleActions,limit_overrides:(settings.limitOverrides||[]).map(overrideRow),exploration_strategy:{...DEFAULT_STRATEGY,...settings.explorationStrategy},reuse_rankings:settings.reuseRankings!==false,navigation_model,
    saved_models:modelList((Array.isArray(settings.savedModels)?settings.savedModels:[]).map(m=>({...m,...Object.fromEntries(PRICE_FIELDS.map(([key,camel])=>[key,m?.[camel]??null]))})),[[provider,settings.model],[navigation_model.provider,navigation_model.model],...projectChoices(project_models)]),project_models,viewport_profile:settings.viewportProfile||'desktop',free_only:settings.provider==='openrouter'&&settings.freeOnly===true,auto_reproduce:settings.autoReproduce===true,max_auto_reproductions:settings.maxAutoReproductions??2,max_auto_replay_actions:settings.maxAutoReplayActions??12,app_memory:settings.appMemory!==false};
}
// The add-a-model fields start on the first provider this server can use.
const newModel=(provider=MODEL_PROVIDERS.find(p=>providerReady(p))||MODEL_PROVIDERS[0])=>({provider,model:'',label:'',input_usd_per_million:null,output_usd_per_million:null});
// Empty, or a number of US dollars per million tokens. Text stays while a decimal is typed.
const priceError=value=>value!==null&&value!==''&&!(Number.isFinite(finite(value))&&finite(value)>=0&&finite(value)<=MAX_USD_PER_MILLION);
export function configurationDraft(){
  const values=configurationValues(),fingerprint=JSON.stringify(values),old=state.configurationDraft;
  if(!old||!old.dirty&&!old.saving&&(old.revision!==state.settingsRevision||old.fingerprint!==fingerprint)){
    state.configurationDraft={values,revision:state.settingsRevision,fingerprint,dirty:false,saving:false,requestId:null,error:'',message:old?.message||'',adding:old?.adding||newModel(),addError:'',added:''};
  }
  return state.configurationDraft;
}
// The first problem as [section, message], or null. Sections are checked in the order the navigation lists them.
export function configurationIssue(values){
  const nav=values.navigation_model,free=values.provider==='openrouter'&&values.free_only;
  if(!MODEL_PROVIDERS.includes(values.provider))return ['models','Choose a supported provider.'];
  if(typeof values.model!=='string'||CONTROL.test(values.model)||!MODEL_ID.test(values.model.trim()))return ['models','Enter a model ID using letters, numbers, / : . _ or - (up to 200 characters).'];
  if(free&&!freeModel(values.model.trim()))return ['models','Free-only requires openrouter/free or a model ID ending in :free.'];
  if(nav.provider){
    if(!MODEL_PROVIDERS.includes(nav.provider))return ['models','Choose a supported navigation model provider.'];
    if(CONTROL.test(nav.model)||!MODEL_ID.test(nav.model.trim()))return ['models','Enter a navigation model ID using letters, numbers, / : . _ or - (up to 200 characters).'];
    if(nav.provider==='openrouter'&&values.free_only&&!freeModel(nav.model.trim()))return ['models','Free-only also applies to the navigation model: use openrouter/free or a model ID ending in :free.'];
  }
  if(values.saved_models.length>MAX_SAVED_MODELS)return ['models',`Keep at most ${MAX_SAVED_MODELS} models in your list.`];
  if(values.project_models.length>MAX_PROJECT_MODELS)return ['models',`Set models for at most ${MAX_PROJECT_MODELS} projects.`];
  const projects=new Set();
  for(const [index,row] of values.project_models.entries()){
    const label=`Project model ${index+1}: `,id=row.project_id.trim().toLowerCase();
    if(!UUID.test(id))return ['models',label+'the project ID must be a UUID.'];
    if(id==='00000000-0000-0000-0000-000000000000')return ['models',label+'the project ID cannot be all zeros.'];
    if(projects.has(id))return ['models',label+'another row already sets this project.'];projects.add(id);
    if(CONTROL.test(row.label)||[...row.label.trim()].length>MAX_MODEL_LABEL)return ['models',label+`keep the name to ${MAX_MODEL_LABEL} characters on one line.`];
    const [provider,model]=splitChoice(row.choice);
    if(!MODEL_PROVIDERS.includes(provider)||!MODEL_ID.test(model))return ['models',label+'choose a model from your list.'];
    const navigation=['inherit','none'].includes(row.navigation)?null:splitChoice(row.navigation);
    if(values.free_only&&(paidOpenRouter(provider,model)||navigation&&paidOpenRouter(...navigation)))return ['models',label+'free-only is on, so OpenRouter models must be openrouter/free or end in :free.'];
  }
  const listed=new Set();
  for(const m of values.saved_models){
    if(!MODEL_PROVIDERS.includes(m.provider)||CONTROL.test(m.model)||!MODEL_ID.test(m.model.trim())||CONTROL.test(m.label)||[...m.label.trim()].length>MAX_MODEL_LABEL)return ['models',`Your model list has an entry that cannot be saved: ${m.model}. Remove it.`];
    if(PRICE_FIELDS.some(([key])=>priceError(m[key])))return ['models',`${m.label||m.model}: prices are empty or from 0 to ${number(MAX_USD_PER_MILLION)} US dollars per million tokens.`];
    if(listed.has(modelChoice(m.provider,m.model.trim())))return ['models',`${m.model} is listed twice for ${providerName(m.provider)}.`];listed.add(modelChoice(m.provider,m.model.trim()));
  }
  if(!['desktop','tablet','mobile'].includes(values.viewport_profile))return ['exploration','Choose a supported viewport.'];
  const split=values.exploration_strategy,share=key=>finite(split[key]);
  if(STRATEGY.some(([key])=>!Number.isInteger(share(key))||share(key)<0||share(key)>100))return ['exploration','Strategy shares must be whole percentages from 0 to 100.'];
  if(STRATEGY.reduce((sum,[key])=>sum+share(key),0)!==100)return ['exploration','Strategy shares must add up to 100%.'];
  if(split.breadth+split.depth===0)return ['exploration','Give new territory or deep journeys a share.'];
  for(const [key,max,label] of [['max_auto_reproductions',3,'Maximum automatic cases'],['max_auto_replay_actions',MAX_REPLAY_ACTIONS,'Total replay actions']]){const n=finite(values[key]);if(!Number.isInteger(n)||n<1||n>max)return ['exploration',`${label} must be a whole number from 1 to ${max}.`];}
  const limitError=(row,prefix='')=>{for(const [key,,label,min,max,step] of LIMITS){const v=row[key];if(v===null||v==='')continue;const n=finite(v);if(!Number.isFinite(n)||n<min||n>max||step===1&&!Number.isInteger(n))return `${prefix}${label} must be empty (no limit) or ${step===1?'a whole number':'a number'} from ${min} to ${max}.`;}return '';};
  const own=limitError(values);if(own)return ['limits',own];
  if(values.limit_overrides.length>MAX_OVERRIDES)return ['limits',`Use at most ${MAX_OVERRIDES} limit overrides.`];
  const seen=new Set();
  for(const [index,row] of values.limit_overrides.entries()){
    const label=`Override ${index+1}: `;
    if(!row.project_id.trim()&&!row.provider&&!row.model.trim())return ['limits',label+'choose a project ID, a provider or a model.'];
    if(row.project_id.trim()&&!UUID.test(row.project_id.trim()))return ['limits',label+'the project ID must be a UUID.'];
    if(row.model.trim()&&!MODEL_ID.test(row.model.trim()))return ['limits',label+'enter a model ID using letters, numbers, / : . _ or -.'];
    const error=limitError(row,label);if(error)return ['limits',error];
    if(LIMITS.every(([key])=>row[key]===null))return ['limits',label+'set at least one limit.'];
    const match=JSON.stringify([row.project_id.trim(),row.provider,row.model.trim()]);if(seen.has(match))return ['limits',label+'another override matches the same project and model.'];seen.add(match);
  }
  return null;
}
export function configurationError(values){return configurationIssue(values)?.[1]||'';}
function touched(draft){draft.dirty=JSON.stringify(draft.values)!==draft.fingerprint;draft.requestId=null;draft.error='';draft.message='';return true;}
export function updateConfiguration(field,value){
  const draft=configurationDraft();if(draft.saving)return false;
  // The exploration and navigation models are picked from the saved list.
  if(field==='exploration_model'||field==='navigation_choice'){
    const chosen=draft.values.saved_models.find(m=>modelChoice(m.provider,m.model)===value);
    if(field==='exploration_model'){if(!chosen)return false;draft.values.provider=chosen.provider;draft.values.model=chosen.model;if(chosen.provider!=='openrouter')draft.values.free_only=false;}
    else{if(value&&!chosen)return false;draft.values.navigation_model=chosen?{provider:chosen.provider,model:chosen.model}:{provider:'',model:''};}
    return touched(draft);
  }
  // A saved model's prices are edited in its row.
  const saved=/^saved\.(\d+)\.(input_usd_per_million|output_usd_per_million)$/.exec(field);
  if(saved){const m=draft.values.saved_models[Number(saved[1])];if(!m)return false;m[saved[2]]=value;draft.added='';return touched(draft);}
  // A project row: its ID and name are typed; its models are picked from the saved list.
  const project=/^project\.(\d+)\.(project_id|label|choice|navigation)$/.exec(field);
  if(project){
    const row=draft.values.project_models[Number(project[1])],key=project[2];if(!row)return false;
    const listed=draft.values.saved_models.some(m=>modelChoice(m.provider,m.model)===value);
    if(key==='choice'&&!listed||key==='navigation'&&!['inherit','none'].includes(value)&&!listed)return false;
    row[key]=value;return touched(draft);
  }
  const override=/^override\.(\d+)\.(\w+)$/.exec(field);
  const nested=override?draft.values.limit_overrides[Number(override[1])]:/^strategy\.\w+$/.test(field)?draft.values.exploration_strategy:/^navigation\.\w+$/.test(field)?draft.values.navigation_model:null,key=override?override[2]:field.slice(field.indexOf('.')+1);
  if(override||nested){if(!nested||!Object.hasOwn(nested,key))return false;nested[key]=value;return touched(draft);}
  if(!Object.hasOwn(draft.values,field)||field==='saved_models')return false;
  if(field==='provider'&&value!=='openrouter')draft.values.free_only=false;
  draft.values[field]=value;return touched(draft);
}
// Typing a listed model fills its name and price. A name or price the user already set stays.
// Switching away from a listed model clears only the values that still match that listing.
function syncCatalogDefaults(adding,before){
  const previous=catalogEntry(before.provider,before.model),entry=catalogEntry(adding.provider,adding.model);
  const label=String(adding.label??''),labelWasCatalog=!label.trim()||!!previous&&label===previous.label;
  const pricesWereCatalog=adding.input_usd_per_million==null&&adding.output_usd_per_million==null||!!previous&&adding.input_usd_per_million===previous.input&&adding.output_usd_per_million===previous.output;
  let changed=false;
  if(entry){
    if(labelWasCatalog&&adding.label!==entry.label){adding.label=entry.label;changed=true;}
    if(pricesWereCatalog&&(adding.input_usd_per_million!==entry.input||adding.output_usd_per_million!==entry.output)){adding.input_usd_per_million=entry.input;adding.output_usd_per_million=entry.output;changed=true;}
  }else if(previous){
    if(label===previous.label){adding.label='';changed=true;}
    if(pricesWereCatalog&&(adding.input_usd_per_million!=null||adding.output_usd_per_million!=null)){adding.input_usd_per_million=null;adding.output_usd_per_million=null;changed=true;}
  }
  return changed;
}
export function updateNewModel(field,value){
  // A replaced field's late change event repeats the value it already sent; it must not clear messages.
  const draft=configurationDraft();if(draft.saving||!Object.hasOwn(draft.adding,field)||draft.adding[field]===value)return false;
  const redraw=field==='provider'||!!draft.addError||!!draft.added,before={provider:draft.adding.provider,model:draft.adding.model};
  draft.adding[field]=value;draft.addError='';draft.added='';
  const synced=(field==='provider'||field==='model')&&syncCatalogDefaults(draft.adding,before);
  return redraw||synced;
}
export function newModelError(values,adding){
  const model=adding.model.trim(),label=adding.label.trim();
  if(!MODEL_PROVIDERS.includes(adding.provider))return 'Choose a provider.';
  if(!model)return 'Enter the model ID your provider uses.';
  if(CONTROL.test(adding.model)||!MODEL_ID.test(model))return 'Enter a model ID using letters, numbers, / : . _ or - (up to 200 characters).';
  if(CONTROL.test(label)||[...label].length>MAX_MODEL_LABEL)return `Keep the name to ${MAX_MODEL_LABEL} characters on one line.`;
  if(values.saved_models.some(m=>m.provider===adding.provider&&m.model===model))return `${model} is already in your list for ${providerName(adding.provider)}.`;
  if(PRICE_FIELDS.some(([key])=>priceError(adding[key])))return `Prices are empty or from 0 to ${number(MAX_USD_PER_MILLION)} US dollars per million tokens.`;
  if(values.saved_models.length>=MAX_SAVED_MODELS)return `Your list holds up to ${MAX_SAVED_MODELS} models. Remove one first.`;
  return '';
}
export function addSavedModel(){
  const draft=configurationDraft();if(draft.saving)return false;
  draft.addError=newModelError(draft.values,draft.adding);if(draft.addError)return false;
  const {provider}=draft.adding,model=draft.adding.model.trim(),label=draft.adding.label.trim();
  draft.values.saved_models.push({provider,model,label,...Object.fromEntries(PRICE_FIELDS.map(([key])=>[key,commitNumber(draft.adding[key]??null)]))});draft.adding=newModel(provider);touched(draft);
  draft.added=`Added ${label||model}. Choose it as the exploration or navigation model above, then save.`;return true;
}
// One step from the listed-model buttons: name and standard price are already filled in.
export function addCatalogModel(provider,model){
  const entry=catalogEntry(provider,model),draft=configurationDraft();if(draft.saving||!entry)return false;
  draft.adding={provider:entry.provider,model:entry.model,label:entry.label,input_usd_per_million:entry.input,output_usd_per_million:entry.output};
  draft.addError='';draft.added='';return addSavedModel();
}
// Models in use stay listed: choose another model first.
export function removeSavedModel(index){
  const draft=configurationDraft(),m=draft.values.saved_models[index];
  if(draft.saving||!m||modelRoles(draft.values,m).length)return false;
  draft.values.saved_models.splice(index,1);draft.added='';return touched(draft);
}
// Moves to the input price of the model a price link named (state.priceTarget), or fills the add form
// with that model when it is not in the list yet. Returns the id of the field it moved to.
export function focusPriceTarget(){
  const target=state.priceTarget;state.priceTarget=null;if(!target)return '';
  const [provider,...rest]=target.split('|'),model=rest.join('|');
  if(!MODEL_PROVIDERS.includes(provider)||!MODEL_ID.test(model))return '';
  const draft=configurationDraft(),index=draft.values.saved_models.findIndex(m=>m.provider===provider&&m.model===model);
  if(index<0&&draft.saving)return '';
  if(index<0){draft.adding={...newModel(provider),model};syncCatalogDefaults(draft.adding,{provider,model:''});draft.addError='';draft.added='';render();}
  const id=index<0?'new-model-input_usd_per_million':`saved-${index}-input_usd_per_million`,field=document.getElementById?.(id);
  field?.scrollIntoView?.({block:'center'});field?.focus?.({preventScroll:true});
  return id;
}
export function editOverrides(add,index){
  const draft=configurationDraft();if(draft.saving)return;
  if(add){if(draft.values.limit_overrides.length<MAX_OVERRIDES)draft.values.limit_overrides.push(overrideRow());}else draft.values.limit_overrides.splice(index,1);
  touched(draft);
}
export function editProjectModels(add,index){
  const draft=configurationDraft();if(draft.saving)return;
  if(add){if(draft.values.project_models.length<MAX_PROJECT_MODELS)draft.values.project_models.push({...projectRow(),choice:draft.values.model.trim()?modelChoice(draft.values.provider,draft.values.model.trim()):''});}
  else draft.values.project_models.splice(index,1);
  touched(draft);
}
export function rebaseConfiguration(discard=false){
  const draft=configurationDraft();if(draft.saving)return;
  if(discard){state.configurationDraft=null;configurationDraft();return;}
  draft.revision=state.settingsRevision;draft.fingerprint=JSON.stringify(configurationValues());draft.dirty=JSON.stringify(draft.values)!==draft.fingerprint;draft.requestId=null;draft.error='';draft.message='Edits kept. Review the values, then save to create a new revision.';
}
export function applyConfiguration(snapshot){
  // A polling response started before a save may arrive after it.
  if(Number.isSafeInteger(snapshot.revision)&&snapshot.revision>=state.settingsRevision){state.settings=snapshot.settings;state.settingsRevision=snapshot.revision;}
}
export async function saveConfiguration(){
  const draft=configurationDraft();if(draft.saving||!draft.dirty)return;
  draft.error=configurationError(draft.values);
  if(!draft.requestId&&draft.revision!==state.settingsRevision)draft.error='Defaults changed elsewhere. Discard your edits or explicitly keep them on the latest revision before saving.';
  if(draft.error){render();return;}
  draft.requestId??=crypto.randomUUID();draft.saving=true;draft.message='';render();
  const token=state.token,developmentAccess=state.developmentAccess,sameSession=()=>token===state.token&&developmentAccess===state.developmentAccess;
  const numbers=Object.fromEntries([...LIMITS.map(([key])=>[key,commitNumber(draft.values[key])]),['max_auto_reproductions',commitNumber(draft.values.max_auto_reproductions)],['max_auto_replay_actions',commitNumber(draft.values.max_auto_replay_actions)]]);
  const exploration_strategy={...draft.values.exploration_strategy};for(const [key] of STRATEGY)exploration_strategy[key]=commitNumber(exploration_strategy[key]);
  const saved_models=modelList(draft.values.saved_models,inUseModels(draft.values)).map(m=>({provider:m.provider,model:m.model,...(m.label?{label:m.label}:{}),...Object.fromEntries(PRICE_FIELDS.map(([key])=>[key,commitNumber(m[key])]).filter(([,price])=>price!==null))}));
  const body={request_id:draft.requestId,expected_revision:draft.revision,...draft.values,...numbers,exploration_strategy,saved_models,model:draft.values.model.trim(),limit_overrides:draft.values.limit_overrides.map(overridePayload),project_models:draft.values.project_models.map(projectPayload),
    navigation_model:draft.values.navigation_model.provider?{provider:draft.values.navigation_model.provider,model:draft.values.navigation_model.model.trim()}:null};
  try{
    const saved=await (await api('/v1/exploration-settings',body)).json();if(!sameSession()||state.configurationDraft!==draft)return;
    applyConfiguration(saved);draft.saving=false;draft.dirty=false;state.configurationDraft=null;
    // The save bar's status line shows the new revision; the toast announces it.
    configurationDraft();toast(`Saved revision ${saved.revision}. These defaults apply to new explorations.`);
    // Read the latest state after an idempotent retry that returned an older revision.
    try{const latest=await get('/v1/exploration-settings');if(sameSession())applyConfiguration(latest);}catch{}
  }catch(error){
    if(!sameSession()||state.configurationDraft!==draft)return;
    draft.error=error.message;
    if(error.code==='revision_conflict'){
      draft.requestId=null;
      try{const latest=await get('/v1/exploration-settings');if(sameSession())applyConfiguration(latest);}catch{}
      draft.error='Defaults changed elsewhere. Your edits are preserved. Choose whether to discard them or keep them on the latest revision.';
    }else if(error.status&&error.status<500){draft.requestId=null;}
  }finally{draft.saving=false;if(sameSession())render();}
}
// Sections whose fields differ from the saved revision.
export function changedSections(draft=configurationDraft()){
  if(!draft.dirty)return [];const saved=JSON.parse(draft.fingerprint);
  return Object.keys(SECTION_FIELDS).filter(section=>SECTION_FIELDS[section].some(key=>JSON.stringify(draft.values[key])!==JSON.stringify(saved[key])));
}
const card=(id,title,intro,body,extra='')=>`<section class="panel settings-card" aria-labelledby="${id}"><div class="settings-card-head"><div><h3 id="${id}">${title}</h3>${intro?`<p>${intro}</p>`:''}</div>${extra}</div><div class="settings-card-body">${body}</div></section>`;
const toggle=(key,label,checked,disabled=false,field=key)=>`<label class="configuration-toggle" for="configuration-${key}"><input id="configuration-${key}" data-configuration-field="${field}" type="checkbox" ${checked?'checked':''} ${disabled?'disabled':''}><span>${label}</span></label>`;
const numberField=(v,key,label,min,max)=>`<label for="configuration-${key}"><span>${label}</span><input id="configuration-${key}" data-configuration-field="${key}" type="number" value="${esc(v[key]??'')}" min="${min}" max="${max}" step="1" required></label>`;
// A model option: its name, or its ID, grouped under its provider.
function modelOptions(list,selected){
  const items=[...list];
  if(selected&&!items.some(m=>modelChoice(m.provider,m.model)===selected)){const [provider,...rest]=selected.split('|');items.push({provider,model:rest.join('|'),label:''});}
  return [...MODEL_PROVIDERS,...new Set(items.map(m=>m.provider).filter(p=>!MODEL_PROVIDERS.includes(p)))].map(provider=>{
    const group=items.filter(m=>m.provider===provider);if(!group.length)return '';
    return `<optgroup label="${esc(providerName(provider))}${providerReady(provider)===false?' · not configured on this server':''}">${group.map(m=>{const value=modelChoice(m.provider,m.model);return `<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(m.label?`${m.label} (${m.model})`:m.model)}</option>`;}).join('')}</optgroup>`;
  }).join('');
}
const PLACEHOLDERS={openrouter:'openrouter/free or vendor/model',meta:'muse-spark-1.3',anthropic:'claude-sonnet-5-5',openai:'gpt-6.1-sol'};
const rate=n=>{const precise=Number(n).toFixed(4).replace(/0+$/,'').replace(/\.$/,'');const [whole,frac='']=precise.split('.');return `$${frac.length>=2?precise:`${whole}.${frac.padEnd(2,'0')}`}`;};
// Listed models for the provider in the form. One click adds the name and the standard price.
function catalogPicker(provider,saved,full){
  const items=catalogModels(provider).filter(entry=>!saved.some(m=>m.provider===entry.provider&&m.model===entry.model));if(!items.length)return '';
  const families=[...new Set(items.map(entry=>entry.family))];
  const button=entry=>`<button type="button" class="button catalog-model" data-action="add-catalog-model" data-provider="${esc(entry.provider)}" data-model="${esc(entry.model)}"${full?' disabled':''}${entry.note?` title="${esc(entry.note)}"`:''}><span>${esc(entry.label)}</span><small>${rate(entry.input)} in · ${rate(entry.output)} out</small>${entry.note?`<small class="catalog-note">${esc(entry.note)}</small>`:''}</button>`;
  const groups=families.map(family=>{const buttons=items.filter(entry=>entry.family===family).map(button).join('');return families.length>1?`<div class="catalog-family"><span class="catalog-family-name">${esc(family)}</span><div class="catalog-models">${buttons}</div></div>`:`<div class="catalog-models">${buttons}</div>`;}).join('');
  const where=provider==='openrouter'?' DeepSeek, Mistral and GLM are listed here, along with Meta, Claude and ChatGPT.':'';
  return `<div class="model-catalog"><h4 id="model-catalog-title">Listed models</h4><p class="small muted">For the provider selected above. The name and standard price are filled in; change a price on the row if you need to.${where}</p>${groups}</div>`;
}
function modelsSection(v){
  const nav=v.navigation_model,exploration=v.model.trim()?modelChoice(v.provider,v.model.trim()):'',navigation=nav.provider?modelChoice(nav.provider,nav.model.trim()):'';
  const unready=[...new Set([v.provider,...(nav.provider?[nav.provider]:[])])].filter(p=>providerReady(p)===false);
  const inUse=`<div class="configuration-grid"><label for="configuration-exploration_model"><span>Exploration model</span><select id="configuration-exploration_model" data-configuration-field="exploration_model" aria-describedby="exploration-model-help">${exploration?'':'<option value="" selected disabled>Choose a model</option>'}${modelOptions(v.saved_models,exploration)}</select><small id="exploration-model-help" class="small">Plans each action, clicks, fills forms and judges what happened.</small></label><label for="configuration-navigation_choice"><span>Navigation model</span><select id="configuration-navigation_choice" data-configuration-field="navigation_choice" aria-describedby="navigation-model-help"><option value="" ${navigation?'':'selected'}>Same as exploration model</option>${modelOptions(v.saved_models,navigation)}</select><small id="navigation-model-help" class="small">Optional cheaper model for opening pages, following links and scrolling.</small></label></div>${unready.length?`<p class="settings-feedback notice" role="status">${esc(unready.map(providerName).join(' and '))} ${unready.length>1?'are':'is'} not configured on this server, so new tests cannot start with ${unready.length>1?'these models':'this model'}. Choose a model from an available provider, or ask your Spekios administrator to add the key.</p>`:''}<p class="small muted settings-note">Clicks on buttons, form entry and submissions always use the exploration model. A navigation result that isn’t clean, or that comes with browser errors or failed requests, is assessed again by the exploration model.</p>`;
  // Price fields show the known price as a placeholder; typing a value overrides it for this model.
  const prices=(id,attr,prefix,values,known)=>PRICE_FIELDS.map(([key,,label],side)=>{const fallback=known?.[side?'output':'input'];return `<label for="${id}-${key}"><span>${label} <small>$ / 1M tokens</small></span><input id="${id}-${key}" ${attr}="${prefix}${key}" type="number" min="0" max="${MAX_USD_PER_MILLION}" step="any" inputmode="decimal" value="${values[key]==null?'':esc(values[key])}" placeholder="${fallback==null?'Not set':esc(fallback)}"></label>`;}).join('');
  const rows=v.saved_models.map((m,i)=>{const roles=modelRoles(v,m),ready=providerReady(m.provider),known=knownPrice(m.provider,m.model),set=key=>m[key]!==null&&m[key]!=='',own=PRICE_FIELDS.some(([key])=>set(key));
    // An estimate needs both prices: each one the model's own, or the known price.
    const complete=PRICE_FIELDS.every(([key],side)=>set(key)||known?.[side?'output':'input']!=null);
    const note=!complete?own?'Add the other price to estimate cost.':'No price yet. Estimates use the cost the provider reports, if any.':own?'Your price':'Known price';
    return `<li class="model-row"><div class="model-row-main"><span class="model-row-name">${esc(m.label||m.model)}</span><span class="model-row-id">${esc(providerName(m.provider))}${m.label?` · <code>${esc(m.model)}</code>`:''}</span><span class="model-row-tags">${roles.map(role=>`<span class="pill blue model-role">${role}</span>`).join('')}${m.provider==='openrouter'&&freeModel(m.model)?'<span class="tag">FREE</span>':''}${ready===false?'<span class="pill amber">Not configured</span>':''}</span></div><div class="model-row-prices" role="group" aria-label="Prices for ${esc(m.label||m.model)}">${prices(`saved-${i}`,'data-configuration-field',`saved.${i}.`,m,known)}<small class="model-price-note${complete?'':' missing'}">${esc(note)}</small></div><div class="model-row-actions">${roles.length?'<span class="small muted">In use</span>':`<button type="button" class="button quiet" data-action="remove-saved-model" data-index="${i}" aria-label="Remove ${esc(m.label||m.model)} from your models">${icon('close')}Remove</button>`}</div></li>`;}).join('');
  const draft=configurationDraft(),a=draft.adding;
  const add=`<div class="model-add" role="group" aria-labelledby="model-add-title"><h4 id="model-add-title">Add a model</h4><div class="model-add-fields"><label for="new-model-provider"><span>Provider</span><select id="new-model-provider" data-new-model-field="provider">${MODEL_PROVIDERS.map(p=>`<option value="${p}" ${a.provider===p?'selected':''}>${providerName(p)}${providerReady(p)===false?' (not configured)':''}</option>`).join('')}</select></label><label for="new-model-model"><span>Model ID</span><input id="new-model-model" data-new-model-field="model" value="${esc(a.model)}" maxlength="200" autocomplete="off" spellcheck="false" placeholder="${esc(PLACEHOLDERS[a.provider]||'The ID your provider uses')}" list="new-model-suggestions"${draft.addError?' aria-invalid="true" aria-describedby="new-model-error"':''}><datalist id="new-model-suggestions">${catalogModels(a.provider).filter(entry=>!v.saved_models.some(m=>m.provider===a.provider&&m.model===entry.model)).map(entry=>`<option value="${esc(entry.model)}">${esc(entry.label)}</option>`).join('')}</datalist></label><label for="new-model-label"><span>Name <small class="small">optional</small></span><input id="new-model-label" data-new-model-field="label" value="${esc(a.label)}" maxlength="${MAX_MODEL_LABEL}" autocomplete="off" placeholder="Shown in model menus"></label>${prices('new-model','data-new-model-field','',a,knownPrice(a.provider,String(a.model).trim()))}<button type="button" class="button" data-action="add-saved-model" ${v.saved_models.length>=MAX_SAVED_MODELS?'disabled':''}>${icon('plus')}Add model</button></div>${catalogPicker(a.provider,v.saved_models,v.saved_models.length>=MAX_SAVED_MODELS)}${draft.addError?`<p id="new-model-error" class="settings-feedback error" role="alert">${esc(draft.addError)}</p>`:draft.added?`<p class="small muted model-add-status" role="status">${esc(draft.added)}</p>`:''}</div>`;
  const providers=(state.providers.providers||[]).map(p=>`<li><span>${esc(providerName(p.provider))}</span><span class="pill ${p.configured?'green':''}">${p.configured?'Available':'Not configured'}</span></li>`).join('');
  return card('models-in-use','Models in use','New explorations use these unless their project or the run chooses another. Queued and running jobs keep the models they started with.',inUse)
    +projectModelsCard(v)
    +card('models-list','Your models',`Add the model IDs you want to switch between, up to ${MAX_SAVED_MODELS}. Listed models include a name and a standard price. Prices are US dollars per million input and output tokens; leave a price empty to use the known one. API keys stay in the server configuration.`,`${rows?`<ul class="model-list">${rows}</ul>`:'<p class="small muted">No models yet. Add one below.</p>'}${add}`,`<span class="small muted">${number(v.saved_models.length)} of ${MAX_SAVED_MODELS}</span>`)
    +card('models-cost','Cost controls','',`${toggle('free_only','Restrict OpenRouter to free model IDs',v.free_only,v.provider!=='openrouter')}<p class="small muted">${v.provider==='openrouter'?'Use openrouter/free or a model ending in :free, for exploration and navigation. Provider availability and rate limits still apply.':'Applies when the exploration model is on OpenRouter. Direct OpenAI, Anthropic and Meta AI calls use their own API billing.'}</p>${toggle('reuse_rankings','Reuse a screen’s ranking from earlier runs when it hasn’t changed',v.reuse_rankings)}<p class="small muted">Skips the planning request on a screen whose address pattern, text and controls match one an earlier run ranked with the same model. Needs app memory. A ranking is reused up to 10 times, then asked for again. Screens where the model chose to type text, and runs with a testing focus, always get a fresh ranking.</p>`)
    +card('models-providers','Provider access',`Your Spekios administrator manages provider credentials; they are never shown here.${state.providers.test_mode?' This server currently returns simulated model responses.':''}`,providers?`<ul class="provider-status">${providers}</ul>`:'<p class="small muted">No provider status is available yet. Refresh the workspace.</p>');
}
// One model per project. A run with that project ID uses it unless the run picks its own model.
function projectModelsCard(v){
  const rows=v.project_models.map((row,i)=>{const id=`project-${i}`,label=row.label.trim()||`Project ${i+1}`;
    return `<fieldset class="configuration-override"><legend>${esc(label)}</legend><div class="configuration-grid"><label for="${id}-project_id"><span>Project ID</span><input id="${id}-project_id" data-configuration-field="project.${i}.project_id" value="${esc(row.project_id)}" maxlength="36" placeholder="UUID your agent sends as project_id" autocomplete="off" spellcheck="false"></label><label for="${id}-label"><span>Name <small class="small">optional</small></span><input id="${id}-label" data-configuration-field="project.${i}.label" value="${esc(row.label)}" maxlength="${MAX_MODEL_LABEL}" autocomplete="off" placeholder="Shown in project menus"></label><label for="${id}-choice"><span>Exploration model</span><select id="${id}-choice" data-configuration-field="project.${i}.choice">${row.choice?'':'<option value="" selected disabled>Choose a model</option>'}${modelOptions(v.saved_models,row.choice)}</select></label><label for="${id}-navigation"><span>Navigation model</span><select id="${id}-navigation" data-configuration-field="project.${i}.navigation"><option value="inherit" ${row.navigation==='inherit'?'selected':''}>Default navigation model</option><option value="none" ${row.navigation==='none'?'selected':''}>Same as this project’s model</option>${modelOptions(v.saved_models,['inherit','none'].includes(row.navigation)?'':row.navigation)}</select></label></div><button type="button" class="button quiet" data-action="remove-project-model" data-index="${i}">${icon('close')}Remove project model</button></fieldset>`;}).join('');
  return card('models-projects','Project models',`Runs that carry a project ID use that project’s model instead of the exploration model above. Agents send the project ID with each run (they can list projects and the model each would use); a test started here can pick a project under its options. A single run can still choose its own model. Limit overrides follow whichever model a run ends up using.`,
    `${rows||'<p class="small muted">No project models. Every project uses the models above.</p>'}<button type="button" class="button" data-action="add-project-model" ${v.project_models.length>=MAX_PROJECT_MODELS?'disabled':''}>${icon('plus')}Add project model</button>`,v.project_models.length?`<span class="small muted">${number(v.project_models.length)} of ${MAX_PROJECT_MODELS}</span>`:'');
}
function explorationSection(v){
  const split=v.exploration_strategy,total=STRATEGY.reduce((sum,[key])=>sum+(Number.isInteger(split[key])?split[key]:0),0);
  return card('exploration-viewport','Default screen size','Each launch can pick another size under its options.',`<div class="configuration-grid"><label for="configuration-viewport_profile"><span>Default viewport</span><select id="configuration-viewport_profile" data-configuration-field="viewport_profile">${['desktop','tablet','mobile'].map(p=>`<option value="${p}" ${v.viewport_profile===p?'selected':''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}</select></label></div>`)
    // Shares are whole percentages; adaptive shares follow what each strategy finds.
    +card('exploration-strategy','Exploration strategy','How each run shares its actions. New territory spreads actions across the app’s areas. Deep journeys follow one path while it keeps reaching new screens. Re-walking repeats paths earlier runs recorded and compares where they lead now. Re-walks need app memory and an earlier run.',`<div class="configuration-grid three">${STRATEGY.map(([key,label])=>`<label for="configuration-strategy-${key}"><span>${label} (%)</span><input id="configuration-strategy-${key}" data-configuration-field="strategy.${key}" type="number" value="${split[key]===null?'':esc(split[key])}" min="0" max="100" step="1" required></label>`).join('')}</div><p class="small ${total===100?'muted':'strategy-total-off'}">Total ${esc(total)}% of 100%.</p>${toggle('strategy-adaptive','Adapt shares during a run',split.adaptive,false,'strategy.adaptive')}<p class="small muted">A strategy that keeps finding new screens, differences or suspected bugs gets more turns. One that finds nothing keeps at least a quarter of its share.</p>`)
    +card('exploration-rechecks','Automatic rechecks','After exploring, open fresh browsers to check whether suspected bugs happen again.',`${toggle('auto_reproduce','Automatically recheck suspected bugs by default',v.auto_reproduce)}<p class="small muted">Each launch can turn this on or off. Fresh-browser checks use additional model calls. Findings still require human review.</p><div class="configuration-grid">${numberField(v,'max_auto_reproductions','Maximum automatic cases',1,3)}${numberField(v,'max_auto_replay_actions','Total additional replay actions',1,MAX_REPLAY_ACTIONS)}</div>`);
}
// Empty means no limit. Overrides apply to a project, a model or both; the most specific one wins.
function limitsSection(v){
  const input=(id,field,value,[,,label,min,max,step],extra='')=>`<label for="${id}"><span>${label}</span><input id="${id}" data-configuration-field="${field}" type="number" value="${value===null?'':esc(value)}" min="${min}" max="${max}" step="${step}" placeholder="${extra||'No limit'}"></label>`;
  const rows=v.limit_overrides.map((row,i)=>`<fieldset class="configuration-override"><legend>Override ${i+1}</legend><div class="configuration-grid"><label for="override-${i}-project_id"><span>Project ID</span><input id="override-${i}-project_id" data-configuration-field="override.${i}.project_id" value="${esc(row.project_id)}" maxlength="36" placeholder="Any project" autocomplete="off" spellcheck="false"></label><label for="override-${i}-provider"><span>Provider</span><select id="override-${i}-provider" data-configuration-field="override.${i}.provider"><option value="">Any provider</option>${MODEL_PROVIDERS.map(p=>`<option value="${p}" ${row.provider===p?'selected':''}>${providerName(p)}</option>`).join('')}</select></label><label for="override-${i}-model"><span>Model ID</span><input id="override-${i}-model" data-configuration-field="override.${i}.model" value="${esc(row.model)}" maxlength="200" placeholder="Any model" list="saved-model-ids" autocomplete="off" spellcheck="false"></label>${LIMITS.map(limit=>input(`override-${i}-${limit[0]}`,`override.${i}.${limit[0]}`,row[limit[0]],limit,'Inherit')).join('')}</div><button type="button" class="button quiet" data-action="remove-limit-override" data-index="${i}">${icon('close')}Remove override</button></fieldset>`).join('');
  return card('limits-run','Run limits','Leave a limit empty for no limit. Explorations then run until nothing new is left to explore or you stop them. Token and cost limits count usage the provider has reported; an action already in progress can finish past the limit.',`<div class="configuration-grid">${LIMITS.map(limit=>input(`configuration-${limit[0]}`,limit[0],v[limit[0]],limit)).join('')}</div>`)
    +card('limits-overrides','Overrides','Different limits for a project, a model, or a model within a project. The most specific matching override wins; empty fields inherit. Jobs keep the limits they started with.',`<datalist id="saved-model-ids">${[...new Set(v.saved_models.map(m=>m.model))].map(m=>`<option value="${esc(m)}"></option>`).join('')}</datalist>${rows||'<p class="small muted">No overrides. Every exploration uses the run limits above.</p>'}<button type="button" class="button" data-action="add-limit-override" ${v.limit_overrides.length>=MAX_OVERRIDES?'disabled':''}>${icon('plus')}Add override</button>`,v.limit_overrides.length?`<span class="small muted">${number(v.limit_overrides.length)} of ${MAX_OVERRIDES}</span>`:'');
}
export function savedSessions(){
  const sessions=state.access.sessions||[];
  return sessions.map(s=>`<div class="key-value"><span>${esc(s.origin)}<small class="table-sub">${s.execution_mode==='protocol_fixture'?'Test session · ':''}${short(s.session_id)} · expires ${date(s.expires_at)}</small></span>${s.revoked_at?'<span class="muted">Removed</span>':new Date(s.expires_at)<=new Date()?'<span class="muted">Expired</span>':button('revoke-session','Remove session','close',`type="button" data-id="${s.session_id}"`)}</div>`).join('')||'<p class="small muted">No saved app sessions.</p>';
}
export function memoryPanel(){
  const scopes=state.memory?.scopes;
  const row=s=>`<div class="key-value"><span>${esc(s.origin)}<small class="table-sub">${s.execution_mode==='protocol_fixture'?'Test data · ':''}${esc(s.viewport_profile)}${s.viewport?` ${esc(s.viewport.width)} × ${esc(s.viewport.height)}`:''} · ${s.auth_scope==='signed_in'?'signed in':'public'} · ${number(s.runs)} run${s.runs===1?'':'s'} · ${number(s.pages)} pages · ${number(s.tried_controls)} tried / ${number(s.untried_controls)} untried controls · map: ${number(s.map_states??0)} states, ${number(s.map_transitions??0)} transitions${s.map_max_depth==null?'':`, ${number(s.map_max_depth)} deep`} · updated ${date(s.updated_at)}</small></span>${s.in_use?'<span class="muted">In use by a running test</span>':button('forget-memory','Forget','close',`type="button" data-id="${s.scope_id}"`)}</div>`;
  return `<h4 class="settings-list-title">Remembered apps</h4><p class="small muted">Kept separately for each app, screen size and sign-in state. Forgetting removes only this memory; recorded runs and evidence stay.</p>${scopes?scopes.map(row).join('')||'<p class="small muted">No app memory yet. It is recorded by explorations that use it.</p>':state.memoryError?`<p class="notice error" role="alert">${esc(state.memoryError)}</p>`:'<p class="small muted">Loading app memory…</p>'}`;
}
function dataSection(v){
  return card('data-memory','App memory','What earlier runs explored, so later runs can go further.',`${toggle('app_memory','Remember explored pages and controls across runs',v.app_memory)}<p class="small muted">Later runs of the same app, screen size and sign-in state skip controls already tried and can reopen pages earlier runs did not finish. Memory guides choices only; every action still records fresh evidence.</p>${memoryPanel()}`)
    +card('data-sessions','Saved app sessions','Encrypted on this machine for up to 24 hours. Select a session when starting a run for the same app. Removing it prevents future reuse; an already running browser keeps its current session.',savedSessions());
}
export function appearancePanel(){
  return card('appearance-theme','Theme','Follow your computer’s light or dark setting, or keep one theme in this browser. This is not saved with your defaults.',`<div class="appearance-row">${themeSwitch(themePreference(),true)}</div>`);
}
// Revision, unsaved sections, conflicts and errors, with links to the section that needs attention.
function saveBar(section){
  const draft=configurationDraft(),conflict=draft.dirty&&draft.revision!==state.settingsRevision,issue=configurationIssue(draft.values),changed=changedSections(draft);
  const title=key=>SETTINGS_SECTIONS.find(([k])=>k===key)[1],link=key=>key===section?esc(title(key)):`<a href="#/settings/${key}">${esc(title(key))}</a>`;
  const status=draft.saving?'Saving your defaults…':draft.dirty?`Unsaved changes in ${changed.map(link).join(', ')||'these settings'}.`:`Saved revision ${esc(state.settingsRevision)} · applies to new explorations.`;
  return `<div class="settings-savebar${draft.dirty?' dirty':''}" role="region" aria-label="Save defaults"><div class="settings-savebar-status"><p><strong>${status}</strong></p><p class="small muted">Queued and running jobs keep their original settings. Saving does not call a model or test a connection.</p>${conflict?`<div class="settings-feedback notice" role="status">Saved defaults are now revision ${esc(state.settingsRevision)}. Your edits still use revision ${esc(draft.revision)}. ${draft.requestId?'A previous save may have completed. Retry save to check its original receipt, or discard your edits.':'Review the current values before keeping your edits.'}</div>`:''}${draft.error?`<p class="settings-feedback notice error" role="alert">${esc(draft.error)}</p>`:''}${draft.message?`<p class="settings-feedback" role="status">${esc(draft.message)}</p>`:''}${draft.dirty&&issue?`<p class="settings-feedback notice error">${issue[0]===section?'':`${link(issue[0])}: `}${esc(issue[1])}</p>`:''}</div><div class="configuration-actions">${conflict?`<button type="button" class="button" data-action="rebase-configuration" ${draft.saving?'disabled':''}>Keep my edits on revision ${esc(state.settingsRevision)}</button>`:''}<button type="button" class="button" data-action="discard-configuration" ${!draft.dirty||draft.saving?'disabled':''}>Discard edits</button><button type="submit" class="button primary" ${draft.saving||!draft.dirty||conflict&&!draft.requestId||issue?'disabled':''}>${draft.saving?'Saving…':draft.requestId?'Retry save':'Save defaults'}</button></div></div>`;
}
// One settings section and its save bar. Fields freeze while a save is in flight.
export function configurationView(section=settingsSection()){
  const draft=configurationDraft(),v=draft.values,[,title,,summary]=SETTINGS_SECTIONS.find(([key])=>key===section);
  const body={models:modelsSection,exploration:explorationSection,limits:limitsSection,data:dataSection}[section];
  return `<div class="settings-section-head"><h2 id="settings-section-title">${esc(title)}</h2><p>${esc(summary)}.</p></div>${body?`<fieldset ${draft.saving?'disabled':''}><legend class="sr-only">${esc(title)} defaults</legend>${body(v)}</fieldset>`:appearancePanel()}${body||draft.dirty?saveBar(section):''}`;
}
export function settingsView(){
  const section=settingsSection(),draft=configurationDraft(),changed=changedSections(draft),issue=draft.dirty?configurationIssue(draft.values):null;
  const nav=SETTINGS_SECTIONS.map(([key,title,glyph,summary])=>{const mark=issue?.[0]===key?'<span class="settings-nav-mark error" title="Needs a fix before saving"></span><span class="sr-only">, needs a fix</span>':changed.includes(key)?'<span class="settings-nav-mark" title="Unsaved changes"></span><span class="sr-only">, unsaved changes</span>':'';
    return `<a class="settings-nav-item${key===section?' active':''}" href="#/settings/${key}" ${key===section?'aria-current="page"':''}>${icon(glyph)}<span>${esc(title)}${mark}</span><small>${esc(summary)}</small></a>`;}).join('');
  return `<div class="page-heading"><div><div class="eyebrow">Workspace</div><h1>Settings</h1><p>The models new explorations use, how far they go, what they remember and how Spekios looks in this browser.</p></div></div><div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections">${nav}</nav><form id="exploration-configuration-form" class="configuration-form settings-form" aria-labelledby="settings-section-title">${configurationView(section)}</form></div>`;
}
