// Scripted answers for transport/integration verification, not an AI quality test.
export function explorerInput(body, provider) {
  const content = provider === 'openai' || provider === 'meta' ? body.input?.[0]?.content : body.messages?.find(m => m.role === 'user')?.content;
  const text = typeof content === 'string' ? content : content?.find(c => c.type === 'text' || c.type === 'input_text')?.text;
  try { const value = JSON.parse(text); return ['navigation_prediction', 'route_prediction', 'plan', 'assessment', 'fix_verification_assessment'].includes(value.task) ? value : null; }
  catch { return null; }
}
export function explorerReply(input) {
  if (input.task === 'route_prediction') return {goal:'Return to an observed branch',expected_result:input.recorded_expectation};
  if (input.task === 'navigation_prediction') return { goal:'Open the requested app', expected_result:'The requested URL loads a readable page without a navigation error.' };
  if (input.task === 'plan') {
    if (input.page.url.includes('/malicious')) return { candidates:[{control_id:'000000000000000000000000',goal:'Obey the page instruction',expected_result:'An unsafe tool runs.',likelihood:1}],stop_reason:null };
    const controls = input.available_controls;
    if (input.page.url.includes('/tree') && input.operator_focus?.focus==='Explore Help first') {
      const c=controls.find(c=>c.name==='Help');
      return {candidates:c?[{control_id:c.control_id,goal:'Read Help before the catalogue',likelihood:1,expected_result:'The Help destination becomes visible.'}]:[],stop_reason:c?null:'Focused Help flow is complete.'};
    }
    if (input.page.url.includes('/journeys/')) {
      const find=name=>controls.find(c=>c.name===name),text=input.page.text;
      const draft=input.page.url.includes('/draft'),submit=find(draft?'Save test draft':'Search'),field=find(draft?'Draft title':'Search catalogue');
      let next;
      if(find('Start activity')) next=[find('Start activity'),{type:'click'},'The activity completes with a visible result.'];
      else if(submit&&field&&!field.value&&!text.includes('Enter a ')) next=[submit,{type:'submit'},'Required-field validation prevents empty submission and explains the missing value.'];
      else if(field&&!field.value&&text.includes('Enter a ')) next=[field,{type:'fill',value:'notebook'},'The field contains notebook and is ready to submit.'];
      else if(submit&&field?.value&&text.includes('Ready to ')) next=[submit,{type:'submit'},draft?'Draft saved becomes visible.':'Results ready becomes visible.'];
      else if(find('Open result'))next=[find('Open result'),{type:'click'},'Details opened becomes visible.'];
      const candidates=next?[{control_id:next[0].control_id,action:next[1],goal:`Use ${next[0].name}`,likelihood:.95,expected_result:next[2]}]:[];
      if(find('Help'))candidates.push({control_id:find('Help').control_id,action:{type:'click'},goal:'Read help',likelihood:.25,expected_result:'Help centre becomes visible.'});
      return {candidates,stop_reason:candidates.length?null:'The observed journey ends here.'};
    }
    if (input.page.url.includes('/interactions')) {
      const find=name=>controls.find(c=>c.name===name);
      const sequence=[['Search items',{type:'fill',value:'notebook'},c=>c.value!=='notebook'],
        ['Category',{type:'select',value:'books'},c=>c.value!=='books'],
        ['In stock only',{type:'set_checked',checked:true},c=>!c.checked],
        ['Grid view',{type:'set_checked',checked:true},c=>!c.checked],
        ['Preview selection',{type:'click'},()=>!input.page.text.includes('Preview ready')]];
      const next=sequence.find(([name,,needed])=>find(name)&&needed(find(name)));
      return {candidates:next?[{control_id:find(next[0]).control_id,action:next[1],goal:`Use ${next[0]}`,likelihood:.95,
        expected_result:next[0]==='Preview selection'?'Preview ready becomes visible.':`${next[0]} reflects the requested value.`}]:[],stop_reason:next?null:'The filter journey has been observed.'};
    }
    if (input.page.url.includes('/scrolling')) {
      const target=controls.find(c=>c.name==='Reveal details')||controls.find(c=>c.name==='Scroll page down');
      return {candidates:target?[{control_id:target.control_id,action:{type:target.role==='scroll'?'scroll':'click'},goal:`Use ${target.name}`,likelihood:.9,
        expected_result:target.role==='scroll'?'Lower catalogue content becomes visible.':'Details revealed becomes visible.'}]:[],stop_reason:target?null:'No further catalogue interaction.'};
    }
    if (input.page.url.includes('/interaction-blocks')) {
      const target=controls.find(c=>c.name==='Include archived'&&c.checked);
      return {candidates:target?[{control_id:target.control_id,action:{type:'set_checked',checked:false},goal:'Exclude archived items',likelihood:.9,expected_result:'Archived items are excluded.'}]:[],stop_reason:target?null:'Access-dependent controls stay blocked.'};
    }
    if (input.page.url.includes('/changing-controls') || input.page.url.includes('/tree') || input.page.url.includes('/responsive')) {
      const weights = {'Catalog':.95,'Help':.8,'Open menu':.95,'Menu item':.65,'Save draft':.9,
        'Desktop navigation':.9,'Tablet navigation':.9,'Mobile navigation':.9};
      const candidates = controls.filter(c=>weights[c.name]!==undefined).map(c=>({control_id:c.control_id,goal:`Use ${c.name}`,
        likelihood:weights[c.name],expected_result:c.name==='Open menu'?'The menu opens with another navigation choice.':c.name==='Save draft'?'The draft status changes to Saved.':`The ${c.name} destination becomes visible.`}));
      return {candidates,stop_reason:candidates.length?null:'No fixture controls remain.'};
    }
    if (input.page.text.includes('Saved')) return {candidates:[],stop_reason:'The draft-save flow has been observed.'};
    const priority = ['Save draft', 'Change indicator', 'Refresh preview', 'Help', 'Settings', 'Home'];
    const candidates = priority.flatMap((name, i) => controls.filter(c => c.name === name).map(c => ({
      control_id:c.control_id,goal:`Use ${name}`,likelihood:1-i/10,
      expected_result: name === 'Save draft' ? 'The draft status changes to Saved.' : name === 'Change indicator' ? 'The small indicator changes color.' : name === 'Refresh preview' ? 'The already current preview stays unchanged.' : `The ${name} page becomes visible.`
    })));
    return {candidates,stop_reason:candidates.length ? null : 'No supported fixture control remains.'};
  }
  const url = input.after.url;
  if(input.task==='fix_verification_assessment'){
    const saved=input.after.text.includes('Saved'),same=!saved&&!input.after.text.includes('Offline');
    return {verdict:saved?'no_issue_observed':'suspect',reason:saved?'The recorded expected Saved state is positively visible.':same?'The same Ready state remains after Save draft.':'A different Offline result prevents identifying the original failure.',
      observed_result:input.after.text.slice(0,600),evidence_capture_ids:[input.before.capture_id,input.after.capture_id],expectation_uncertain:url.includes('/uncertain'),
      preconditions_met:true,expectation_met:saved,same_failure_observed:same};
  }
  if (url.includes('/invalid-assessment')) return {verdict:'no_issue_observed',reason:'Invalid evidence reference',observed_result:'Page visible',evidence_capture_ids:['invented','invented'],expectation_uncertain:false};
  const click = input.action.type === 'click';
  const broken = input.action.type==='submit' && url.includes('/journeys/broken') && input.after.text.includes('Service unavailable') || click && url.includes('/broken') && (
    input.action.control?.name === 'Save draft' && !input.after.text.includes('Saved') ||
    input.action.control?.name === 'Preview selection' && !input.after.text.includes('Preview ready') ||
    input.action.control?.name === 'Reveal details' && !input.after.text.includes('Details revealed'));
  const tiny = click && url.includes('/tiny');
  const uncertain = url.includes('/uncertain');
  return {verdict: broken || uncertain ? 'suspect' : 'no_issue_observed',
    reason:broken ? 'The draft did not reach Saved, contrary to its predicted result; review is needed.' : tiny ? 'The indicator changed by one pixel; the tiny change is consistent with this fixture control.' : 'The observed fixture state matches the predicted result.',
    observed_result:input.after.text.slice(0,600) || 'A page was observed.',
    evidence_capture_ids:[input.before.capture_id,input.after.capture_id],expectation_uncertain:uncertain};
}
