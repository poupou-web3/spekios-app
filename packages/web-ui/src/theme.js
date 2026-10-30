// Color theme preference: follow the operating system (default), or keep light or dark in this browser.
// theme-init.js applies a saved choice before first paint; this module renders and updates the control.
const THEME_KEY = 'scout.theme';
const THEMES = [
  ['system', 'Match system', [['rect', {x: 3, y: 4, width: 18, height: 12, rx: 2}], ['path', {d: 'M8 20h8m-4-4v4'}]]],
  ['light', 'Light', [['circle', {cx: 12, cy: 12, r: 4}], ['path', {d: 'M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4'}]]],
  ['dark', 'Dark', [['path', {d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z'}]]],
];
const SVG = 'http://www.w3.org/2000/svg';
const shapeMarkup = shapes => shapes.map(([tag, attributes]) => `<${tag} ${Object.entries(attributes).map(([key, value]) => `${key}="${value}"`).join(' ')}/>`).join('');

export function themePreference() {
  try {
    const value = globalThis.localStorage?.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(value) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (value === 'light' || value === 'dark') root.dataset.theme = value;
  else delete root.dataset.theme;
}

export function setTheme(value) {
  if (!THEMES.some(([key]) => key === value)) return;
  try {
    if (value === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
  } catch {
    // Storage can be unavailable; the choice still applies to this page.
  }
  applyTheme(value);
}

export function themeSwitch(current = themePreference(), labelled = false) {
  return `<div class="theme-switch${labelled ? ' labelled' : ''}" role="group" aria-label="Color theme">${THEMES.map(([value, label, shapes]) =>
    `<button type="button" data-theme-choice="${value}" aria-pressed="${current === value}"${labelled ? '' : ` aria-label="${label} theme" title="${label}"`}><svg aria-hidden="true" viewBox="0 0 24 24">${shapeMarkup(shapes)}</svg>${labelled ? label : ''}</button>`).join('')}</div>`;
}

// DOM-built variant for pages that never assign innerHTML (agent connection, issues).
export function mountThemeSwitch(slot, current = themePreference()) {
  const group = document.createElement('div');
  group.className = 'theme-switch';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Color theme');
  for (const [value, label, shapes] of THEMES) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.setAttribute('data-theme-choice', value);
    choice.title = label;
    choice.setAttribute('aria-label', `${label} theme`);
    choice.setAttribute('aria-pressed', String(current === value));
    if (document.createElementNS) {
      const icon = document.createElementNS(SVG, 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      for (const [tag, attributes] of shapes) {
        const shape = document.createElementNS(SVG, tag);
        for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, String(value));
        icon.append(shape);
      }
      choice.append(icon);
    }
    group.append(choice);
  }
  slot.replaceChildren(group);
  bindThemeSwitch(slot);
}

// One delegated listener per container, so re-rendered markup keeps working.
export function bindThemeSwitch(container) {
  container.addEventListener('click', event => {
    const choice = event.target.closest?.('[data-theme-choice]');
    if (!choice) return;
    setTheme(choice.dataset.themeChoice);
    for (const node of container.querySelectorAll('[data-theme-choice]')) node.setAttribute('aria-pressed', String(node.dataset.themeChoice === choice.dataset.themeChoice));
  });
}
