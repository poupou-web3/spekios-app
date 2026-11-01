import test from 'node:test';
import assert from 'node:assert/strict';
import { controlEntry, mapState, pageTemplate, rankingEntries, restoreRanking, screenSignature, transitionKey } from '../src/app-map.js';
import type { Capture, ObservedControl } from '../src/contracts.js';

const control = (name: string, href: string | null = null, role = href ? 'link' : 'button'): ObservedControl =>
  ({ control_id: Math.random().toString(16).slice(2, 14).padEnd(24, '0'), role, name, href, disabled: false, occluded: false, ambiguous: false, in_viewport: true } as ObservedControl);
const capture = (url: string, controls: ObservedControl[], extra: Partial<Capture['observation']> = {}) =>
  ({ capture_id: 'c', observation: { url, title: 'Shop', text: 'Anything', controls, ...extra } } as unknown as Capture);

test('page templates replace identifiers and drop fragments', () => {
  assert.equal(pageTemplate('https://shop.test/orders/123?page=2#top'), 'https://shop.test/orders/:n?page=:n');
  assert.equal(pageTemplate('https://shop.test/u/0f8fad5b-d9cb-469f-a165-70867728950e/settings'), 'https://shop.test/u/:id/settings');
  assert.equal(pageTemplate('https://shop.test/p/a1b2c3d4e5f6a7b8c9d0'), 'https://shop.test/p/:id');
  assert.equal(pageTemplate('https://shop.test/search?tab=reviews&b=1&a=x'), 'https://shop.test/search?a=x&b=:n&tab=reviews');
  assert.equal(pageTemplate('https://shop.test/pricing'), 'https://shop.test/pricing');
  assert.equal(pageTemplate('about:blank'), 'about:');
});

test('a list of items in one templated route is one entry; other controls keep their names', () => {
  const card = controlEntry({ role: 'link', name: 'Red shoes', href: 'https://shop.test/products/12' });
  assert.equal(card.key, controlEntry({ role: 'link', name: 'Blue hat', href: 'https://shop.test/products/99' }).key);
  assert.equal(card.repeated, true);
  assert.notEqual(controlEntry({ role: 'button', name: 'Checkout', href: null }).key, controlEntry({ role: 'button', name: 'Cancel', href: null }).key);
  assert.equal(controlEntry({ role: 'button', name: 'Updated 10:42', href: null }).key, controlEntry({ role: 'button', name: 'Updated 11:05', href: null }).key, 'Volatile times are stabilized.');
});

test('the same screen with different data is one map state; a different screen is another', () => {
  const list = (items: string[]) => capture('https://shop.test/category/7', [control('Cart'), ...items.map((name, i) => control(name, `https://shop.test/products/${i + 10}`))]);
  const a = mapState(list(['Red shoes', 'Blue hat'])), b = mapState(list(['Green scarf', 'Socks', 'Belt']));
  assert.equal(a.key, b.key);
  assert.equal(a.page_template, 'https://shop.test/category/:n');
  assert.equal(a.controls.length, 2, 'Cart plus one collapsed product entry');
  const dialog = mapState(capture('https://shop.test/category/7', [control('Cart'), control('Close dialog')]));
  assert.notEqual(dialog.key, a.key);
  const signedIn = mapState({ ...list(['Red shoes']), observation: { ...list(['Red shoes']).observation, auth_context_id: 'ctx' } } as Capture);
  assert.notEqual(signedIn.key, a.key, 'Signed-in states are separate');
  const withScroll = mapState(capture('https://shop.test/category/7', [control('Cart'), control('Down', null, 'scroll'), control('Item', 'https://shop.test/products/1')]));
  assert.equal(withScroll.key, a.key, 'Scroll affordances are positional, not part of the state');
});

test('a transition keys what was done, not the typed text', () => {
  const search = control('Search', null, 'searchbox');
  assert.equal(transitionKey({ type: 'fill', value: 'shoes', control: search }).key, transitionKey({ type: 'fill', value: 'hats', control: { ...search, control_id: 'other' } }).key);
  const country = control('Country', null, 'combobox');
  assert.notEqual(transitionKey({ type: 'select', value: 'fr', control: country }).key, transitionKey({ type: 'select', value: 'de', control: country }).key);
  assert.notEqual(transitionKey({ type: 'click', control: country }).key, transitionKey({ type: 'submit', control: country }).key);
  const nav = transitionKey({ type: 'navigate', url: 'https://shop.test/orders/1' });
  assert.equal(nav.key, transitionKey({ type: 'navigate', url: 'https://shop.test/orders/2' }).key);
  assert.equal(nav.entry, null);
  assert.equal(transitionKey({ type: 'click', control: control('Red shoes', 'https://shop.test/products/12') }).entry,
    controlEntry({ role: 'link', name: 'x', href: 'https://shop.test/products/5' }).key, 'Clicking any item of a list acts on its entry');
});

test('a screen signature ignores identifiers and clock text but not what the screen says or its control states', () => {
  const field = (extra: Partial<ObservedControl> = {}) => ({ ...control('Search', null, 'searchbox'), input_type: 'search', ...extra } as ObservedControl);
  const screen = (url: string, text: string, controls: ObservedControl[]) => capture(url, controls, { text });
  const base = screenSignature(screen('https://shop.test/orders/12', 'Order 12 placed 10:42', [field(), control('Search now')]));
  assert.ok(base);
  assert.equal(screenSignature(screen('https://shop.test/orders/57', 'Order 57 placed 11:05', [field(), control('Search now')])), base, 'Same screen for another order.');
  assert.notEqual(screenSignature(screen('https://shop.test/orders/12', 'Enter a search term', [field(), control('Search now')])), base, 'A validation message is a different screen.');
  assert.notEqual(screenSignature(screen('https://shop.test/orders/12', 'Order 12 placed 10:42', [field({ value: 'shoes' }), control('Search now')])), base, 'A filled field is a different screen.');
  assert.notEqual(screenSignature(screen('https://shop.test/orders/12', 'Order 12 placed 10:42', [field(), { ...control('Search now'), disabled: true }])), base);
  assert.equal(screenSignature(capture('https://shop.test/', [], { controls_truncated: true })), null, 'A truncated control list is never reused.');
  assert.equal(screenSignature(capture('about:blank', [])), null);
});

test('a ranking is stored by control entry, never with typed text, and restored onto a later screen', () => {
  const cart = control('Cart'), item = control('Red shoes', 'https://shop.test/products/1'), search = { ...control('Search', null, 'searchbox'), input_type: 'search' } as ObservedControl;
  const proposals = [{ control_id: item.control_id, goal: 'Open a product', expected_result: 'Product page', likelihood: .9, action: { type: 'click' as const } },
    { control_id: cart.control_id, goal: 'Open cart', expected_result: 'Cart', likelihood: .5, action: { type: 'click' as const } }];
  const stored = rankingEntries(proposals, [cart, item, search])!;
  assert.deepEqual(stored.map(p => p.entry_key), [controlEntry(item).key, controlEntry(cart).key]);
  assert.equal(rankingEntries([...proposals, { control_id: search.control_id, goal: 'Search', expected_result: 'Results', likelihood: .7, action: { type: 'fill', value: 'shoes' } }], [cart, item, search]), null);
  assert.equal(rankingEntries([], [cart]), null);
  // A later run lists other products and new control IDs.
  const later = [{ ...cart, control_id: 'cart-later' }, control('Blue hat', 'https://shop.test/products/9')];
  const restored = restoreRanking(stored, later);
  assert.deepEqual(restored.map(p => [p.control_id, p.likelihood]), [[later[1].control_id, .9], ['cart-later', .5]], 'Any item of the list stands in for the ranked one.');
  assert.deepEqual(restoreRanking(stored, [{ ...cart, disabled: true }]), [], 'A control that no longer permits the action drops out.');
});
