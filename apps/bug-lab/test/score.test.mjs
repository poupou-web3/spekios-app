import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { manifest } from '../shop.mjs';
import { formatReport, scoreRun } from '../score.mjs';

const origin = 'http://larchwood:8084';
// A run in the shape GET /v1/runs/:id returns, reduced to what scoring reads.
function run(steps, viewport = 'desktop') {
  const captures = [], actions = steps.map((step, i) => {
    const before = randomUUID(), after = randomUUID();
    captures.push({ capture_id: before, phase: 'before', observation: { url: step.before ? origin + step.before : 'about:blank', text: '' } });
    captures.push({ capture_id: after, phase: 'after', observation: { url: origin + step.after, text: step.text ?? '' } });
    const command = step.type === 'navigate' ? { type: 'navigate', url: origin + step.after }
      : { type: step.type ?? 'click', control: { role: step.role ?? 'button', name: step.control }, ...(step.value !== undefined ? { value: step.value } : {}), ...(step.checked !== undefined ? { checked: step.checked } : {}) };
    return { action_id: randomUUID(), ordinal: i + 1, before_capture_id: before, after_capture_id: after, spec: { command },
      assessment: step.verdict === null ? null : { verdict: step.verdict ?? 'no_issue_observed', reason: step.reason ?? 'Looks fine.' } };
  });
  return { run: { run_id: randomUUID(), target_url: origin + '/', lifecycle: 'completed', config: { viewport_profile: viewport } }, actions, captures };
}
const result = (score, id) => [...score.bugs, ...score.decoys].find(entry => entry.id === id).result;

test('bugs are found, missed, inconclusive or never tried', () => {
  const score = scoreRun(run([
    { type: 'navigate', after: '/' },
    { before: '/', role: 'link', control: 'Shop', after: '/shop' },
    { before: '/shop', type: 'submit', control: 'Search', after: '/shop?q=lamp', verdict: 'suspect', reason: 'All 24 products are shown for lamp.' },
    { before: '/shop?q=lamp', type: 'set_checked', role: 'checkbox', control: 'In stock only', checked: true, after: '/shop?q=lamp&stock=1' },
    { before: '/shop?q=lamp&stock=1', type: 'select', role: 'combobox', control: 'Sort by', value: 'price-asc', after: '/shop?q=lamp&stock=1&sort=price-asc', verdict: 'inconclusive' },
    { before: '/', role: 'link', control: 'Deals', after: '/deals', verdict: 'suspect', reason: 'The banner overlaps the title.' },
  ]), manifest);
  assert.equal(result(score, 'search-ignored'), 'found');
  // The checkbox action also lands on a search page, where the search bug still shows.
  assert.equal(score.bugs.find(b => b.id === 'search-ignored').actions.length, 3);
  // The checkbox was judged fine; the later sort, which still shows the filter, was inconclusive.
  assert.equal(result(score, 'stock-filter'), 'missed');
  assert.equal(result(score, 'price-sort'), 'inconclusive');
  assert.equal(result(score, 'banner-overlap'), 'found');
  assert.equal(result(score, 'wishlist-dead'), 'not-tried');
  assert.equal(result(score, 'mobile-menu'), 'not-applicable');
  assert.deepEqual(score.totals, { applicable: 13, found: 2, missed: 1, inconclusive: 1, not_tried: 9, false_alarms: 0, unmatched_suspects: 0 });
});

test('a trigger judged fine counts as missed', () => {
  const score = scoreRun(run([{ before: '/product/oak-side-table', control: 'Save to wishlist', after: '/product/oak-side-table' }]), manifest);
  assert.equal(result(score, 'wishlist-dead'), 'missed');
  assert.equal(score.totals.missed, 1);
});

test('only every second add triggers the intermittent failure', () => {
  const add = (verdict, slug = 'oak-side-table') => ({ before: `/product/${slug}`, control: 'Add to cart', after: `/product/${slug}`, verdict });
  assert.equal(result(scoreRun(run([add('no_issue_observed')]), manifest), 'flaky-add'), 'not-tried');
  const twice = scoreRun(run([add('no_issue_observed'), add('suspect', 'enamel-kettle')]), manifest);
  assert.equal(result(twice, 'flaky-add'), 'found');
  assert.deepEqual(twice.bugs.find(b => b.id === 'flaky-add').actions.map(a => a.ordinal), [2]);
  // A suspect on the first add, which works, is not explained by the bug.
  const wrongAdd = scoreRun(run([add('suspect'), add('no_issue_observed')]), manifest);
  assert.equal(result(wrongAdd, 'flaky-add'), 'missed');
  assert.deepEqual(wrongAdd.unmatched.map(s => s.ordinal), [1]);
});

test('mobile-only bugs count only in mobile runs', () => {
  const steps = [{ type: 'navigate', after: '/' }, { before: '/', control: 'Menu', after: '/', verdict: 'suspect' }];
  assert.equal(result(scoreRun(run(steps, 'mobile'), manifest), 'mobile-menu'), 'found');
  assert.equal(scoreRun(run(steps, 'mobile'), manifest).totals.applicable, 14);
  assert.equal(result(scoreRun(run(steps, 'desktop'), manifest), 'mobile-menu'), 'not-applicable');
});

test('suspects on correct behaviour are false alarms; others are listed', () => {
  const score = scoreRun(run([
    { before: '/cart', control: 'Apply code', after: '/cart', verdict: 'suspect', reason: 'Code TEST is refused.' },
    { before: '/', role: 'link', control: 'Cart (0)', after: '/cart', text: 'Your cart is empty. Continue shopping' },
    { before: '/shop', type: 'click', role: 'radio', control: 'List', after: '/shop?view=list', verdict: 'suspect', reason: 'Layout jumps.' },
    { before: '/product/oak-side-table', control: 'Dimensions', after: '/product/oak-side-table', verdict: null },
  ]), manifest);
  assert.equal(result(score, 'invalid-promo'), 'false-alarm');
  assert.equal(result(score, 'empty-cart'), 'ok');
  assert.equal(result(score, 'free-sample'), 'not-tried');
  assert.equal(score.totals.false_alarms, 1);
  assert.deepEqual(score.unmatched.map(s => [s.ordinal, s.control]), [[3, 'List']]);
});

test('the report compares several runs', () => {
  const found = run([{ before: '/help', control: 'Can I exchange an item?', after: '/help', verdict: 'suspect' }]);
  const missed = run([{ before: '/help', control: 'Can I exchange an item?', after: '/help' }, { before: '/shop', role: 'radio', control: 'List', after: '/shop?view=list', verdict: 'suspect', reason: 'Odd.' }]);
  const text = formatReport([scoreRun(found, manifest), scoreRun(missed, manifest)]);
  assert.match(text, /One help question never opens\s+found\s+tried, judged fine\s+1\/2/);
  assert.match(text, /The mobile menu opens off-screen\s+n\/a \(other screen size\)\s+n\/a \(other screen size\)\s+0\/0/);
  assert.match(text, /Other suspects in run [0-9a-f]{8}, to check by hand:\n {2}#2 \/shop · List · Odd\./);
  assert.match(formatReport([scoreRun(found, manifest)]), /One help question never opens\s+found #1/);
});
