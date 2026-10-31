// Pure report projection. Fetching, byte verification and ZIP creation live in
// the bundle module; this module never follows data-supplied URLs or object keys.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/i;
const PNG_KINDS=new Set(['raw_mask','absolute_delta','geometry_mask','settling_frame','replanning_mask']);
const JSON_KINDS=new Set(['comparison','action_diagnostics','action_completion','run_manifest']);
const array=value=>Array.isArray(value)?value:[];
const uuid=value=>typeof value==='string'&&UUID.test(value)?value.toLowerCase():null;
const integer=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:typeof value==='string'&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
const own=(row,runId)=>!!runId&&uuid(row?.run_id)===runId;
const orderedActions=report=>array(report?.actions).filter(a=>own(a,uuid(report?.run?.run_id))).slice().sort((a,b)=>(integer(a.ordinal)??Number.MAX_SAFE_INTEGER)-(integer(b.ordinal)??Number.MAX_SAFE_INTEGER)||String(a.action_id).localeCompare(String(b.action_id),'en'));
const ownEvents=report=>array(report?.events).filter(e=>own(e,uuid(report?.run?.run_id))).slice().sort((a,b)=>(integer(a.seq)??Number.MAX_SAFE_INTEGER)-(integer(b.seq)??Number.MAX_SAFE_INTEGER)||String(a.event_id).localeCompare(String(b.event_id),'en'));
const hash=value=>typeof value==='string'&&HASH.test(value)?value.toLowerCase():null;
const key=entry=>entry.kind+':'+String(entry.id);

function printable(value){
  if(value==null)return 'Not recorded';
  if(typeof value==='string')return value;
  try{return JSON.stringify(value)??'Not recorded';}catch{return 'Unserializable value';}
}
function bounded(value,limit=4000){
  const valueText=printable(value).replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'�');
  return valueText.length>limit?valueText.slice(0,limit)+`… [truncated; ${valueText.length-limit} further characters in raw report]`:valueText;
}
// Escape link/image syntax, GFM table/list delimiters and autolink punctuation.
// HTML entities are applied last, so page content cannot become raw HTML.
function md(value,limit=4000){if(uuid(value))return '`'+uuid(value)+'`';if(hash(value))return '`'+hash(value)+'`';return bounded(value,limit).replace(/([\\`*_[\]{}()#+\-.!|~:@/])/g,'\\$1').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
const cell=value=>md(value,1500).replace(/\n/g,' ');
const field=(label,value)=>`- **${label}:** ${cell(value)}`;
const block=(label,value)=>`**${label}**\n\n${md(value).split('\n').map(line=>'> '+line).join('\n')}`;
const table=(head,rows)=>['| '+head.join(' | ')+' |','| '+head.map(()=>'---').join(' | ')+' |',...rows.map(row=>'| '+row.map(cell).join(' | ')+' |')].join('\n');

function media(row,kind){
  if(kind==='capture')return {mediaType:'image/png',extension:'png'};
  const candidates=[];
  for(const name of ['media_type','mediaType','content_type'])if(row?.[name]!=null){
    const value=typeof row[name]==='string'?row[name].split(';')[0].trim().toLowerCase():'';
    if(!['image/png','application/json'].includes(value))return {error:'Unsupported artifact media type.'};
    candidates.push(value);
  }
  if(row?.object_key!=null){
    if(typeof row.object_key!=='string'||!/^.*\.(png|json)$/.test(row.object_key))return {error:'Unsupported artifact object extension.'};
    candidates.push(row.object_key.endsWith('.png')?'image/png':'application/json');
  }
  if(PNG_KINDS.has(row?.kind))candidates.push('image/png');
  if(JSON_KINDS.has(row?.kind))candidates.push('application/json');
  if(!candidates.length)return {error:'Artifact media type is not recorded.'};
  if(new Set(candidates).size!==1)return {error:'Artifact media metadata conflicts.'};
  return {mediaType:candidates[0],extension:candidates[0]==='image/png'?'png':'json'};
}

/** Deterministic selected-run inventory. Invalid/missing entries are explicit
 * gaps with null paths/endpoints and must never be downloaded by the caller. */
export function reportEvidence(report){
  const runId=uuid(report?.run?.run_id),entries=new Map(),sources=new Map(),references=new Map();
  const ownedActionIds=new Set(orderedActions(report).map(action=>uuid(action.action_id)).filter(Boolean));
  const invalidate=(entry,error,status='invalid')=>{entry.status=status;entry.error=error;entry.path=null;entry.endpoint=null;};
  function add(kind,row){
    const id=uuid(kind==='capture'?row?.capture_id:row?.artifact_id),rawId=kind==='capture'?row?.capture_id:row?.artifact_id;
    const type=media(row,kind),entry={kind,id:id??(typeof rawId==='string'?rawId:null),runId:uuid(row?.run_id),actionId:uuid(row?.action_id),
      path:id?`${kind==='capture'?'captures':'artifacts'}/${id}.${type.extension||'json'}`:null,
      endpoint:id?`/v1/${kind==='capture'?'captures':'artifacts'}/${id}/${kind==='capture'?'image':'content'}`:null,
      status:typeof row?.status==='string'?row.status:'unknown',sha256:hash(row?.sha256),byteLength:integer(row?.byte_length),mediaType:type.mediaType??null,
      ...(kind==='capture'?{phase:row?.phase??null}:{artifactKind:typeof row?.kind==='string'?row.kind:null}),references:[]};
    if(typeof row?.error==='string'&&row.error)entry.error=bounded(row.error,800);
    if(!runId)invalidate(entry,'Selected run ID is invalid.');
    else if(!id)invalidate(entry,'Evidence ID is not a canonical UUID.');
    else if(!own(row,runId))invalidate(entry,'Evidence belongs to another or unrecorded run.');
    else if(kind==='capture'&&(!entry.actionId||!['before','after'].includes(row?.phase)))invalidate(entry,'Capture action or phase is invalid.');
    else if(kind==='capture'&&entry.status==='available'&&!ownedActionIds.has(entry.actionId))invalidate(entry,'Available capture has no recorded action in the selected run.');
    else if(type.error)invalidate(entry,type.error);
    else if(entry.status==='available'&&(!entry.sha256||entry.byteLength==null))invalidate(entry,'Available evidence has incomplete checksum or length metadata.');
    const identity=key(entry),prior=entries.get(identity);
    const signature=JSON.stringify([row?.run_id,row?.action_id,row?.phase,row?.status,row?.sha256,row?.byte_length,row?.kind,row?.object_key,row?.media_type,row?.mediaType,row?.content_type]);
    if(prior){if(sources.get(identity)?.signature!==signature)invalidate(prior,'Duplicate evidence IDs have conflicting metadata.');return;}
    entries.set(identity,entry);sources.set(identity,{row,signature});
  }
  for(const row of array(report?.captures))add('capture',row);
  for(const row of array(report?.artifacts))add('artifact',row);
  function refer(kind,idValue,context,metadata={}){
    const id=uuid(idValue),identity=kind+':'+String(id??idValue);
    const list=references.get(identity)||[];list.push({kind,idValue,context,metadata});references.set(identity,list);
  }
  function scan(value,context){
    const stack=[value],seen=new Set();
    while(stack.length){
      const item=stack.pop();if(!item||typeof item!=='object'||seen.has(item))continue;seen.add(item);
      if(!Array.isArray(item)&&Object.hasOwn(item,'artifact_id'))refer('artifact',item.artifact_id,context,item);
      for(const [name,value]of Object.entries(item)){
        if(name==='artifact_id'||name==='source_snapshot'||name==='evidence_snapshot')continue;
        if(name.endsWith('_artifact_id')&&value!=null)refer('artifact',value,context,{});
        else if(value&&typeof value==='object')stack.push(value);
      }
    }
  }
  for(const action of orderedActions(report)){
    const actionId=uuid(action.action_id);if(!actionId)continue;
    for(const phase of ['before','after'])if(action[phase+'_capture_id']!=null)refer('capture',action[phase+'_capture_id'],{actionId,phase});
    for(const value of [action.spec,action.comparison,action.outcome])scan(value,{actionId});
  }
  for(const event of ownEvents(report)){
    const context={actionId:uuid(event.action_id),eventId:uuid(event.event_id),...(event.event_type==='action.settling_frame'?{frameId:uuid(event.payload?.frame_id)}:{})};
    scan(event.payload,context);
    if(event.event_type==='capture.available'&&event.payload?.capture_id!=null)refer('capture',event.payload.capture_id,context,event.payload);
  }
  for(const [identity,refs]of references){
    let entry=entries.get(identity);
    if(!entry){
      const first=refs[0],id=uuid(first.idValue),type=first.kind==='capture'?{mediaType:'image/png'}:media(first.metadata,'artifact');
      entry={kind:first.kind,id:id??(typeof first.idValue==='string'?first.idValue:null),runId,actionId:first.context.actionId??null,path:null,endpoint:null,status:id&&runId?'missing':'invalid',sha256:null,byteLength:null,mediaType:type.mediaType??null,error:id&&runId?'Referenced evidence row is missing.':'Referenced evidence ID or selected run ID is invalid.',references:[]};
      entries.set(identity,entry);
    }
    entry.references=refs.map(ref=>ref.context).filter((ref,index,all)=>all.findIndex(other=>JSON.stringify(other)===JSON.stringify(ref))===index)
      .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
    if(!entry.actionId)entry.actionId=entry.references.map(r=>r.actionId).filter(Boolean).sort()[0]??null;
    const source=sources.get(identity)?.row;
    if(!source||entry.status==='invalid')continue;
    for(const ref of refs){
      if(ref.kind==='capture'&&(ref.context.actionId&&uuid(source.action_id)!==ref.context.actionId||ref.context.phase&&source.phase!==ref.context.phase)){
        invalidate(entry,'Capture reference does not match its action and phase.');break;
      }
      for(const name of ['sha256','byte_length','kind','object_key','run_id'])if(Object.hasOwn(ref.metadata,name)){
        const expected=name==='sha256'?hash(source[name]):name==='byte_length'?integer(source[name]):name==='run_id'?uuid(source[name]):source[name];
        const actual=name==='sha256'?hash(ref.metadata[name]):name==='byte_length'?integer(ref.metadata[name]):name==='run_id'?uuid(ref.metadata[name]):ref.metadata[name];
        if(actual==null||actual!==expected){invalidate(entry,'Referenced evidence metadata conflicts with the recorded row.');break;}
      }
      if(entry.status==='invalid')break;
    }
  }
  return [...entries.values()].sort((a,b)=>a.kind.localeCompare(b.kind,'en')||String(a.id??'').localeCompare(String(b.id??''),'en'));
}

function scopedReviews(report){
  const runId=uuid(report?.run?.run_id),actions=orderedActions(report),local=new Set(actions.map(a=>uuid(a.action_id)).filter(Boolean));
  const sourceRun=uuid(report?.run?.config?.replay_of?.source_run_id),sourceActions=new Set(actions.map(a=>uuid(a.spec?.replay_source_action_id)).filter(Boolean));
  return array(report?.finding_reviews).filter(r=>integer(r?.revision)>0&&uuid(r.action_id||r.source_action_id)&&
    (uuid(r.run_id)===runId&&local.has(uuid(r.action_id||r.source_action_id))||sourceRun&&uuid(r.run_id)===sourceRun&&sourceActions.has(uuid(r.action_id||r.source_action_id))))
    .slice().sort((a,b)=>String(a.action_id||a.source_action_id).localeCompare(String(b.action_id||b.source_action_id),'en')||Number(a.revision)-Number(b.revision)||String(a.review_id).localeCompare(String(b.review_id),'en'));
}
function frameOccurrences(report){
  return ownEvents(report).filter(e=>e.event_type==='action.settling_frame').map(e=>({frameId:uuid(e.payload?.frame_id),actionId:uuid(e.action_id),artifactId:uuid(e.payload?.artifact?.artifact_id),offsetMs:integer(e.payload?.offset_ms),observedAt:e.payload?.observed_at??null}));
}
function usageSummary(report){
  const source=report?.model_usage||{},calls=array(report?.model_calls),hasCalls=Array.isArray(report?.model_calls);
  const sum=field=>{const known=calls.map(c=>integer(c?.[field])).filter(v=>v!=null);if(!known.length)return null;const total=known.reduce((a,b)=>a+b,0);return Number.isSafeInteger(total)?total:null;};
  const attempts=integer(source.attempts)??(hasCalls?calls.length:null),inputTokens=integer(source.known_input_tokens)??sum('input_tokens'),outputTokens=integer(source.known_output_tokens)??sum('output_tokens');
  const partialCalls=calls.filter(c=>c.usage_status!=='reported'||integer(c.input_tokens)==null||integer(c.output_tokens)==null).length;
  const knownIncomplete=integer(source.incomplete_usage_attempts),incompleteUsageAttempts=knownIncomplete==null&&!hasCalls?null:Math.max(knownIncomplete??0,partialCalls),pendingRequests=integer(source.pending_requests);
  const costValue=source.provider_reported_cost_usd,costUsd=(typeof costValue==='string'||typeof costValue==='number')&&/^(?:\d+(?:\.\d+)?|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(String(costValue))&&Number.isFinite(Number(costValue))?String(costValue):null;
  const unpricedAttempts=integer(source.unpriced_attempts)??(hasCalls?calls.filter(c=>c.cost_usd==null).length:null);
  return {attempts,inputTokens,outputTokens,incompleteUsageAttempts,pendingRequests,costUsd,unpricedAttempts,
    tokensComplete:inputTokens!=null&&outputTokens!=null&&incompleteUsageAttempts===0&&pendingRequests===0,
    costComplete:costUsd!=null&&unpricedAttempts===0&&pendingRequests===0};
}

export function reportSummary(report){
  const actions=orderedActions(report),states=Object.create(null),verdicts=Object.create(null),reviews=scopedReviews(report),latest=new Map();
  for(const action of actions){states[action.state||'unknown']=(states[action.state||'unknown']||0)+1;verdicts[action.assessment?.verdict||'not_assessed']=(verdicts[action.assessment?.verdict||'not_assessed']||0)+1;}
  for(const review of reviews)latest.set(uuid(review.action_id||review.source_action_id),review);
  const isReplay=!!report?.run?.config?.replay_of,reviewable=report?.run?.config?.runtime_version==='explorer-v1'&&!isReplay;
  const candidates=reviewable?actions.filter(a=>a.assessment?.verdict==='suspect'):[],findings={candidates:candidates.length,needsReview:0,confirmed:0,dismissed:0,latestReviews:[...latest.values()].map(review=>Object.fromEntries(['review_id','action_id','source_action_id','run_id','revision','disposition','rationale','expectation_basis','severity','reviewer_id','created_at'].filter(name=>Object.hasOwn(review,name)).map(name=>[name,review[name]])))};
  findings.sourceReviewReferences=isReplay?findings.latestReviews:[];
  for(const action of candidates){const disposition=latest.get(uuid(action.spec?.replay_source_action_id)||uuid(action.action_id))?.disposition;
    if(disposition==='confirmed')findings.confirmed++;else if(disposition==='dismissed')findings.dismissed++;else findings.needsReview++;}
  const inventory=reportEvidence(report),frames=frameOccurrences(report),inventoryRecorded=Array.isArray(report?.captures)&&Array.isArray(report?.artifacts),evidence={total:inventoryRecorded||inventory.length?inventory.length:null,recorded:inventoryRecorded,available:0,pending:0,failed:0,missing:0,invalid:0,unknown:0,frameOccurrences:frames.length,uniqueFrameArtifacts:new Set(frames.map(f=>f.artifactId).filter(Boolean)).size};
  for(const item of inventory){if(item.status==='available')evidence.available++;else if(item.status==='invalid')evidence.invalid++;else if(item.status==='missing')evidence.missing++;else if(item.status==='failed')evidence.failed++;else if(['capturing','pending_upload'].includes(item.status))evidence.pending++;else evidence.unknown++;}
  return {runId:uuid(report?.run?.run_id),lifecycle:report?.run?.lifecycle??'unknown',isReplay,
    actions:{total:actions.length,invalidRecords:array(report?.actions).length-actions.length,states,verdicts},findings,usage:usageSummary(report),evidence,
    trainingStatus:report?.run?.config?.training_status??'Not recorded',fixture:report?.run?.config?.training_status==='excluded_fixture'||report?.run?.config?.execution_mode==='protocol_fixture'};
}

function commandFields(command={}){
  const rows=[field('Command',command.type??'Not recorded')];
  if(command.type==='navigate')rows.push(field('URL',command.url));
  if(command.control){rows.push(field('Control',command.control.name),field('Control role',command.control.role),field('Control ID',command.control.control_id));}
  else if(command.button!=null)rows.push(field('Button',command.button));
  if(['fill','select'].includes(command.type))rows.push(field('Value',command.value));
  if(command.type==='set_checked')rows.push(field('Checked',command.checked));
  if(command.type==='scroll')rows.push(field('Scroll target',{x:command.control?.scroll_target?.x,y:command.control?.scroll_target?.y,direction:command.control?.scroll_target?.direction}));
  if(command.type==='submit')rows.push(field('Form method',command.control?.form?.method),field('Form action',command.control?.form?.action));
  return rows.join('\n');
}
function amount(value,complete,kind){return value==null?'Unknown':`${complete?'':'At least '}${kind==='cost'?'USD ':''}${value}${complete?'':' (known subtotal; incomplete or pending usage)'}`;}
function relatedEvidence(ids){return array(ids).map(id=>printable(id)).join(', ')||'Not recorded';}

/** Human-readable, escaped GFM. Standalone output has no data-supplied links.
 * Bundle image links require matching inventory metadata and verified inclusion. */
export function reportMarkdown(report,{exportId,generatedAt,bundle=false,evidence=[]}={}){
  const run=report?.run||{},summary=reportSummary(report),actions=orderedActions(report),inventory=reportEvidence(report),byId=new Map(inventory.map(item=>[key(item),item]));
  const included=new Map();
  if(bundle)for(const item of array(evidence)){
    const source=byId.get(key(item));
    if(source&&source.status==='available'&&['included','verified'].includes(item.status)&&source.path&&item.path===source.path&&uuid(item.runId)===source.runId&&item.sha256===source.sha256&&item.byteLength===source.byteLength&&item.mediaType===source.mediaType&&item.verifiedSha256===source.sha256&&item.verifiedBytes===source.byteLength)included.set(key(item),source);
  }
  const receiptStatus=(source,receipt)=>included.has(key(source))?'included and verified':receipt&&['included','verified'].includes(receipt.status)?'not included (verification receipt is incomplete)':receipt?.status??source.status;
  const evidenceLabel=(kind,id)=>{
    const entry=byId.get(kind+':'+String(uuid(id)??id));if(!entry)return 'No recorded evidence reference';
    const receipt=array(evidence).find(item=>key(item)===key(entry));
    return `${entry.id??'Invalid ID'} — ${bundle?receiptStatus(entry,receipt):entry.status}${receipt?.error?'; '+bounded(receipt.error,500):entry.error?'; '+entry.error:''}`;
  };
  const image=(kind,id,label)=>{const item=included.get(kind+':'+String(uuid(id)??id));return item?.mediaType==='image/png'?`![${label}](${item.path})`:'';};
  const sections=['# Scout QA run report',
    [field('Export ID',exportId??'Not supplied'),field('Snapshot generated at',generatedAt??'Not supplied'),field('Run ID',run.run_id),field('Lifecycle',run.lifecycle),field('Application URL',run.target_url),field('Execution mode',run.config?.execution_mode),field('Viewport',run.config?.viewport_profile),field('Started at',run.created_at),field('Finished at',run.finished_at),field('Stop reason',run.config?.stop_reason),field('Training status',summary.trainingStatus),field('Fixture data',summary.fixture?'Yes':'No fixture flag recorded')].join('\n'),
    'This is a bounded execution snapshot, not a claim of complete application coverage or training approval. AI suspicion, reproduction and human review remain separate. Private login inputs are outside the recorded testing trajectory.',
    '## Execution summary',table(['Measure','Recorded value'],[['Actions',summary.actions.total],['Action states',summary.actions.states],['Automated verdicts',summary.actions.verdicts],['AI suspect actions',summary.actions.verdicts.suspect??0],['Reviewable original candidate actions',summary.findings.candidates],['Candidate actions needing human review',summary.findings.needsReview],['Candidate actions with human confirmation',summary.findings.confirmed],['Candidate actions dismissed by a human',summary.findings.dismissed],['Invalid/foreign action records omitted',summary.actions.invalidRecords],['Evidence records',summary.evidence.total??'Unknown'],['Available evidence',summary.evidence.available],['Pending evidence',summary.evidence.pending],['Unknown evidence states',summary.evidence.unknown],['Failed/missing/invalid evidence',summary.evidence.failed+summary.evidence.missing+summary.evidence.invalid],['Settling frame occurrences',summary.evidence.frameOccurrences],['Distinct settling image artifacts',summary.evidence.uniqueFrameArtifacts]]),
    '## Model usage',table(['Measure','Recorded value'],[['Provider attempts',summary.usage.attempts??'Unknown'],['Input tokens',amount(summary.usage.inputTokens,summary.usage.tokensComplete,'tokens')],['Output tokens',amount(summary.usage.outputTokens,summary.usage.tokensComplete,'tokens')],['Incomplete usage attempts',summary.usage.incompleteUsageAttempts??'Unknown'],['Pending requests',summary.usage.pendingRequests??'Unknown'],['Provider-reported cost',amount(summary.usage.costUsd,summary.usage.costComplete,'cost')],['Unpriced attempts',summary.usage.unpricedAttempts??'Unknown']])];
  if(summary.usage.attempts===0)sections.push('No provider attempts are recorded in this snapshot. Null token or cost fields are not invented as zero.');
  if(run.error)sections.push(block('Execution error',run.error));
  sections.push('## Coverage and exploration limits',[
    field('Allowed action budget',run.config?.limits&&run.config.limits.max_actions===null?'No limit':run.config?.limits?.max_actions),field('States recorded',Array.isArray(report?.graph?.states)?report.graph.states.length:'Unknown'),field('Transitions recorded',Array.isArray(report?.graph?.edges)?report.graph.edges.length:'Unknown'),field('Unexplored controls',Array.isArray(report?.graph?.frontier)?report.graph.frontier.filter(f=>f.status==='unexplored').length:'Unknown'),field('Blocked controls',Array.isArray(report?.graph?.frontier)?report.graph.frontier.filter(f=>f.status==='blocked').length:'Unknown'),
    'Unvisited flows, unsupported interactions and incomplete observations remain untested. Action-budget use is not coverage percentage. Intent/path scores are uncalibrated estimates.'].join('\n'));
  const blocked=array(report?.graph?.frontier).filter(f=>f.status==='blocked');
  if(blocked.length)sections.push(table(['Blocked control','Reason'],blocked.slice(0,50).map(f=>[f.control?.name??f.control_id,f.reason])),...(blocked.length>50?[`${blocked.length-50} additional blocked controls remain in the raw report.`]:[]));
  sections.push('## Recorded actions',actions.length?'Every recorded action below retains its execution state and automated assessment; a finished run does not imply that every action passed.':'No actions were recorded. This is not a passing test result.');
  const focusHistory=array(report?.steering?.messages);
  if(focusHistory.length)sections.splice(sections.indexOf('## Action timeline'),0,'## Testing focus',
    'Applied acknowledges input to a planning decision. Coverage and model compliance still require recorded evidence.',
    table(['Revision','Focus','Acknowledgement','Command ID','Planning decision'],focusHistory.map(item=>[item.revision,item.focus||'Restore normal exploration',item.status,item.steering_id,item.decision_id??'Not applied to a planning decision'])));
  for(const action of actions){
    sections.push(`### Action ${integer(action.ordinal)??'?'}: ${md(action.spec?.prediction?.goal??action.spec?.command?.control?.name??action.spec?.command?.type??'Recorded action',500)}`,
      [field('Action ID',action.action_id),field('Execution state',action.state),field('Automated verdict',action.assessment?.verdict),field('Expectation uncertain',action.assessment?.expectation_uncertain??'Not recorded'),commandFields(action.spec?.command)].join('\n'),
      block('Frozen expectation',action.spec?.prediction?.expected_result??action.spec?.prediction?.expected??action.assessment?.expected),
      block('Observed result',action.assessment?.observed_result??action.assessment?.actual??action.assessment?.reason),
      ...(action.assessment?.reason?[block('Assessment reasoning',action.assessment.reason)]:[]),
      ...(action.tool_error?[block('Tool error',action.tool_error)]:[]),
      [field('Before capture',action.before_capture_id?evidenceLabel('capture',action.before_capture_id):'Not recorded'),field('After capture',action.after_capture_id?evidenceLabel('capture',action.after_capture_id):'Not recorded'),field('Changed pixels',action.comparison?.counts?.changed_pixels)].join('\n'));
    for(const [phase,label]of [['before','Before action'],['after','After action']]){const rendered=image('capture',action[phase+'_capture_id'],label);if(rendered)sections.push(rendered);}
    const mask=action.comparison?.raw_mask_artifact?.artifact_id;
    if(mask){sections.push(field('Exact difference mask',evidenceLabel('artifact',mask)));const rendered=image('artifact',mask,'Exact difference mask');if(rendered)sections.push(rendered);}
    if(action.outcome){
      const blocks=action.outcome.diagnostics?.runtime_blocks;
      sections.push([field('Action completion',action.outcome.status),field('Completion reason',action.outcome.reason),field('Completion elapsed milliseconds',action.outcome.elapsed_ms),field('HTTP errors',action.outcome.diagnostics?.http_errors),field('Request failures',action.outcome.diagnostics?.request_failures),...(typeof blocks==='number'?[field('Runtime blocks',blocks)]:[]),field('Browser errors',action.outcome.diagnostics?.console_errors)].join('\n'));
    }
  }
  sections.push('## Human review — separate from AI assessment');
  const history=scopedReviews(report),latest=summary.findings.latestReviews;
  sections.push(latest.length?table(['Source action','Latest revision','Human decision','Severity','Reviewer','Saved at'],latest.map(r=>[r.action_id||r.source_action_id,r.revision,r.disposition,r.severity,r.reviewer_id,r.created_at])):'No scoped human decisions are recorded. AI suspects remain candidates; reproduction alone never confirms a product defect.');
  if(summary.isReplay)sections.push('Human decisions shown for source actions refer to the original finding. They do not label a replay action as a newly confirmed defect.');
  for(const review of history){sections.push(`### Review revision ${integer(review.revision)??'?'} for action ${md(review.action_id||review.source_action_id,100)}`,
    [field('Review ID',review.review_id),field('Human decision',review.disposition),field('Severity',review.severity),field('Source run',review.run_id)].join('\n'),block('Reviewer rationale',review.rationale),block('Human expectation basis',review.expectation_basis));}
  sections.push('Human review history does not rewrite the original automated verdict, evidence, reproduction result or recorded training status.');
  sections.push('## Reproduction lineage');
  if(run.config?.replay_of)sections.push(field('Replay of',run.config.replay_of));
  const reproductions=array(report?.reproductions);
  if(!reproductions.length)sections.push('No reproduction attempts are recorded in this snapshot.');
  for(const reproduction of reproductions)sections.push([
    field('Reproduction ID',reproduction.reproduction_id),field('Source run',reproduction.source_run_id),field('Source action',reproduction.source_action_id),field('Replay run',reproduction.replay_run_id),field('Attempt state',reproduction.status),field('Reproduction outcome',reproduction.result?.outcome),field('Result reason',reproduction.result?.reason),field('Related source capture IDs',relatedEvidence(reproduction.result?.source_capture_ids)),field('Related replay capture IDs',relatedEvidence(reproduction.result?.replay_capture_ids)),
    'Reproduction is not automatic confirmation. Related run evidence outside the selected run is referenced by ID and is not included in this export.'].join('\n'));
  sections.push('## Automatic checks');
  const automatic=array(report?.automatic_reproductions);
  sections.push(field('Frozen policy',run.config?.automatic_reproduction_policy));
  if(automatic.length)sections.push(table(['Task ID','Source action','Decision','Reason','Reserved actions','Child job state','Child run','Outcome'],automatic.map(t=>[t.task_id,t.source_action_id,t.status,t.reason,t.planned_actions,t.child_job?.status,t.child_job?.run_id,t.reproduction?.result?.outcome])));
  else sections.push('No automatic check records are present.');
  sections.push(field('Batch cancellation ID',run.auto_reproduction_cancel_id),'Reserved work, queue state and completed replay outcomes are distinct. Unfinished children may settle after this snapshot; their usage belongs to their own runs.');
  sections.push('## Evidence inventory',bundle?'Only verified files marked included below are embedded through fixed relative paths. Missing, invalid, unavailable or failed downloads remain explicit gaps.':'Evidence is listed by stable ID and recorded availability. This Markdown file has no embedded or external image links; use the evidence ZIP to carry verified selected-run images.',
    table(['Kind','ID','Recorded/export status','SHA-256','Bytes','Issue'],inventory.map(item=>{const receipt=array(evidence).find(e=>key(e)===key(item));return [item.kind,item.id,bundle?receiptStatus(item,receipt):item.status,item.sha256,item.byteLength,receipt?.error||item.error||'None recorded'];})));
  const frames=frameOccurrences(report);
  sections.push('## Settling frame occurrences',frames.length?table(['Action ID','Frame occurrence ID','Offset ms','Image artifact ID','Evidence status'],frames.map(f=>[f.actionId,f.frameId,f.offsetMs,f.artifactId,evidenceLabel('artifact',f.artifactId)])):'No settling frames are recorded.');
  sections.push('## Snapshot notes','The live API overlays later human reviews, automatic checks and model settlement on immutable original manifests. This exported snapshot does not alter either record. Local workspace authentication, private provider credentials, raw model payloads and private login inputs are not embedded in this Markdown. Raw run JSON, when bundled separately, retains the full authenticated source projection.');
  return sections.filter(section=>section!==undefined&&section!==null&&section!=='').join('\n\n')+'\n';
}
