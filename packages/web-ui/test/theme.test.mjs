import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {linkSource} from '../testing/link.mjs';

const UI = new URL('../src/', import.meta.url);
function theme({stored = null, storage = true} = {}) {
  const saved = new Map(stored ? [['scout.theme', stored]] : []), root = {dataset: {}};
  const localStorage = storage ? {getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)} : {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }};
  const sandbox = {localStorage, document: {documentElement: root}};
  vm.createContext(sandbox);
  vm.runInContext(linkSource(UI, 'theme.js') + '\nglobalThis.testing={themePreference,setTheme,themeSwitch,bindThemeSwitch};', sandbox);
  return {...sandbox.testing, saved, root};
}

test('the default follows the operating system and saved choices are validated', () => {
  assert.equal(theme().themePreference(), 'system');
  assert.equal(theme({stored: 'dark'}).themePreference(), 'dark');
  assert.equal(theme({stored: '<script>'}).themePreference(), 'system');
  assert.equal(theme({storage: false}).themePreference(), 'system');
});

test('choosing a theme stores it, sets data-theme and system removes both', () => {
  const ui = theme();
  ui.setTheme('light');assert.equal(ui.saved.get('scout.theme'), 'light');assert.equal(ui.root.dataset.theme, 'light');
  ui.setTheme('system');assert.equal(ui.saved.has('scout.theme'), false);assert.equal('theme' in ui.root.dataset, false);
  ui.setTheme('sepia');assert.equal('theme' in ui.root.dataset, false);
  const blocked = theme({storage: false});blocked.setTheme('dark');assert.equal(blocked.root.dataset.theme, 'dark');
});

test('the control marks exactly the current choice and labels icon-only buttons', () => {
  const ui = theme(), html = ui.themeSwitch('dark');
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /data-theme-choice="dark" aria-pressed="true"/);
  assert.match(html, /aria-label="Match system theme"/);
  assert.match(ui.themeSwitch('system', true), />Match system<\/button>/);
});

test('the clicked choice becomes the only pressed button', () => {
  const ui = theme(), nodes = ['system', 'light', 'dark'].map(value => ({dataset: {themeChoice: value}, attributes: {}, setAttribute(key, next) { this.attributes[key] = next; }}));
  let listener;ui.bindThemeSwitch({addEventListener(_, fn) { listener = fn; }, querySelectorAll: () => nodes});
  listener({target: {closest: () => nodes[2]}});
  assert.deepEqual(nodes.map(node => node.attributes['aria-pressed']), ['false', 'false', 'true']);
  assert.equal(ui.root.dataset.theme, 'dark');
});

test('the pre-paint script applies only light or dark and follows other tabs', () => {
  const root = {dataset: {}}, listeners = {}, saved = new Map([['scout.theme', 'dark']]);
  const sandbox = {document: {documentElement: root}, localStorage: {getItem: key => saved.get(key) ?? null}, addEventListener: (type, fn) => { listeners[type] = fn; }};
  vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('theme-init.js', UI), 'utf8'), sandbox);
  assert.equal(root.dataset.theme, 'dark');
  saved.set('scout.theme', 'system');listeners.storage({key: 'scout.theme'});assert.equal('theme' in root.dataset, false);
});
