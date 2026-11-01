// Score Scout runs against the Larchwood bug list. Pure functions: the
// command-line wrapper is scripts/score-bug-lab.mjs.
//
// For each bug, a run lands in one of these groups:
//   found         an action that triggers the bug was assessed as suspect
//   missed        Scout triggered the bug and at least once judged the result fine
//   inconclusive  Scout triggered it, and no assessment was conclusive
//   not-tried     no action in the run triggers the bug
//   not-applicable the bug needs another screen size than the run used
// For each odd-but-correct case: false-alarm (assessed as suspect), ok, or not-tried.
// Suspects that match no entry are listed for a person to check: they may be
// false alarms or real problems nobody planted.

const local = url => {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.pathname + parsed.search : null; } catch { return null; }
};

export function actionFacts(action, captures) {
  const command = action.spec?.command ?? {};
  const before = captures.get(action.before_capture_id)?.observation ?? null;
  const after = captures.get(action.after_capture_id)?.observation ?? null;
  return {
    action_id: action.action_id,
    ordinal: action.ordinal,
    type: command.type ?? null,
    role: command.control?.role ?? null,
    control: command.control?.name ?? null,
    value: command.value ?? (typeof command.checked === 'boolean' ? String(command.checked) : null),
    before: local(before?.url),
    after: local(after?.url ?? (command.type === 'navigate' ? command.url : undefined)),
    afterText: after?.text ?? '',
    verdict: action.assessment?.verdict ?? null,
    reason: action.assessment?.reason ?? action.tool_error ?? null,
  };
}

export function matches(rule, facts) {
  const test = (pattern, value) => value != null && new RegExp(pattern).test(value);
  if (rule.before && !test(rule.before, facts.before)) return false;
  if (rule.after && !test(rule.after, facts.after)) return false;
  if (rule.role && rule.role !== facts.role) return false;
  if (rule.control && !test(rule.control, facts.control)) return false;
  if (rule.command && rule.command !== facts.type) return false;
  if (rule.value && !test(rule.value, facts.value)) return false;
  if (rule.after_text && !test(rule.after_text, facts.afterText)) return false;
  return true;
}

// The actions that trigger an entry, in run order. With "every: n", only the
// nth, 2nth… matching action triggers it.
export function triggers(rule, facts) {
  const matching = facts.filter(f => matches(rule, f));
  return rule.every ? matching.filter((_, i) => (i + 1) % rule.every === 0) : matching;
}

function outcome(found) {
  if (!found.length) return 'not-tried';
  if (found.some(f => f.verdict === 'suspect')) return 'found';
  // One conclusive look that saw nothing wrong is a miss, even if others were inconclusive.
  if (found.some(f => f.verdict === 'no_issue_observed')) return 'missed';
  return 'inconclusive';
}

export function scoreRun(detail, manifest) {
  const captures = new Map((detail.captures ?? []).map(capture => [capture.capture_id, capture]));
  const facts = [...(detail.actions ?? [])].sort((a, b) => a.ordinal - b.ordinal).map(action => actionFacts(action, captures));
  const viewport = detail.run?.config?.viewport_profile ?? 'desktop';
  const explained = new Set();
  const brief = f => ({ ordinal: f.ordinal, verdict: f.verdict, page: f.before, control: f.control, reason: f.reason });

  const bugs = manifest.bugs.map(bug => {
    if (bug.viewport !== 'any' && bug.viewport !== viewport) return { id: bug.id, title: bug.title, type: bug.type, result: 'not-applicable', actions: [] };
    const found = triggers(bug.match, facts);
    found.forEach(f => explained.add(f.action_id));
    return { id: bug.id, title: bug.title, type: bug.type, result: outcome(found), actions: found.map(brief) };
  });
  const decoys = manifest.decoys.map(decoy => {
    const found = triggers(decoy.match, facts);
    found.forEach(f => explained.add(f.action_id));
    return { id: decoy.id, title: decoy.title, result: !found.length ? 'not-tried' : found.some(f => f.verdict === 'suspect') ? 'false-alarm' : 'ok', actions: found.map(brief) };
  });
  const unmatched = facts.filter(f => f.verdict === 'suspect' && !explained.has(f.action_id)).map(brief);

  const applicable = bugs.filter(b => b.result !== 'not-applicable');
  const count = result => bugs.filter(b => b.result === result).length;
  return {
    run: { run_id: detail.run?.run_id ?? null, target_url: detail.run?.target_url ?? null, viewport, lifecycle: detail.run?.lifecycle ?? null,
      actions: facts.length, suspects: facts.filter(f => f.verdict === 'suspect').length },
    totals: { applicable: applicable.length, found: count('found'), missed: count('missed'), inconclusive: count('inconclusive'), not_tried: count('not-tried'),
      false_alarms: decoys.filter(d => d.result === 'false-alarm').length, unmatched_suspects: unmatched.length },
    bugs, decoys, unmatched,
  };
}

const LABELS = { found: 'found', missed: 'tried, judged fine', inconclusive: 'inconclusive', 'not-tried': 'never tried', 'not-applicable': 'n/a (other screen size)', 'false-alarm': 'FALSE ALARM', ok: 'ok' };

export function formatReport(scores) {
  const lines = [];
  const pad = (text, width) => String(text).padEnd(width);
  const short = score => (score.run.run_id ?? '?').slice(0, 8);
  for (const score of scores) {
    const t = score.totals;
    lines.push(`Run ${short(score)} · ${score.run.target_url ?? 'unknown target'} · ${score.run.viewport} · ${score.run.actions} actions · ${score.run.suspects} suspect${score.run.suspects === 1 ? '' : 's'}${score.run.lifecycle && score.run.lifecycle !== 'completed' ? ` · ${score.run.lifecycle}` : ''}`);
    lines.push(`  Found ${t.found} of ${t.applicable} · tried but judged fine ${t.missed} · inconclusive ${t.inconclusive} · never tried ${t.not_tried} · false alarms ${t.false_alarms} · other suspects ${t.unmatched_suspects}`);
  }
  lines.push('');
  const titleWidth = Math.max(...scores[0].bugs.map(b => b.title.length), ...scores[0].decoys.map(d => d.title.length)) + 2;
  const columnWidth = Math.max(...Object.values(LABELS).map(label => label.length)) + 2;
  const header = pad('Bug', titleWidth) + scores.map(score => pad(short(score), columnWidth)).join('') + (scores.length > 1 ? 'found in' : '');
  lines.push(header, '-'.repeat(header.length));
  scores[0].bugs.forEach((bug, i) => {
    const results = scores.map(score => score.bugs[i]);
    const cells = results.map(r => pad(LABELS[r.result] + (scores.length === 1 && r.actions.length ? ` #${r.actions.map(a => a.ordinal).slice(0, 3).join(',#')}` : ''), columnWidth)).join('');
    const applicable = results.filter(r => r.result !== 'not-applicable');
    lines.push(pad(bug.title, titleWidth) + cells + (scores.length > 1 ? `${applicable.filter(r => r.result === 'found').length}/${applicable.length}` : ''));
  });
  lines.push('', pad('Correct but odd-looking', titleWidth) + scores.map(score => pad(short(score), columnWidth)).join(''), '-'.repeat(header.length));
  scores[0].decoys.forEach((decoy, i) => lines.push(pad(decoy.title, titleWidth) + scores.map(score => pad(LABELS[score.decoys[i].result], columnWidth)).join('')));
  for (const score of scores) {
    if (!score.unmatched.length) continue;
    lines.push('', `Other suspects in run ${short(score)}, to check by hand:`);
    for (const s of score.unmatched) lines.push(`  #${s.ordinal} ${s.page ?? '?'} · ${s.control ?? 'navigation'} · ${(s.reason ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return lines.join('\n');
}
