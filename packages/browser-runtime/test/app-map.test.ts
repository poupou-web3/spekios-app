import test from 'node:test';
import assert from 'node:assert/strict';
import { controlEntry, mapState, pageTemplate, transitionKey } from '../src/app-map.js';
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
