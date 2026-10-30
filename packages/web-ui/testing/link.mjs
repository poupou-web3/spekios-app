// Links an app's native ES modules into one classic script for the vm-based UI tests.
// Browsers load the same files as modules. Linking mirrors a bundler's scope hoisting, so
// tests can still reach internal functions by name; the checks below keep the two forms equivalent.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const UI_ROOT = new URL('../src/', import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Served URL prefixes, identical in scout-api and the back office container.
function resolve(specifier, from, appRoot) {
  if (specifier.startsWith('/assets/ui/')) return new URL(specifier.slice('/assets/ui/'.length), UI_ROOT);
  if (specifier.startsWith('/assets/app/')) return new URL(specifier.slice('/assets/app/'.length), appRoot);
  if (specifier.startsWith('./') || specifier.startsWith('../')) return new URL(specifier, from);
  throw new Error(`Unsupported import ${specifier} in ${fileURLToPath(from)}`);
}

// Source with comments, string contents, template text and regex literals blanked out, keeping
// `${...}` expressions. Good enough for the identifier checks below; not a general JS parser.
function codeOnly(source) {
  let out = '', i = 0, previous = '';
  const templates = [];
  const regexAllowed = () => /[(,=:[!&|?{};+\-*%<>~^]$|^$|\b(?:return|typeof|case|in|of)$/.test(out.trimEnd());
  while (i < source.length) {
    const char = source[i], next = source[i + 1];
    if (templates.length && templates.at(-1) === 0 && char === '`') { templates.pop(); out += '``'; i++; continue; }
    if (templates.length && templates.at(-1) === 0) {
      if (char === '\\') { i += 2; continue; }
      if (char === '$' && next === '{') { templates[templates.length - 1] = 1; out += '${'; i += 2; continue; }
      i++; continue;
    }
    if (char === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (char === '/' && next === '*') { i = source.indexOf('*/', i + 2) + 2 || source.length; continue; }
    if (char === '`') { templates.push(0); out += '`'; i++; continue; }
    if (templates.length && char === '{') templates[templates.length - 1]++;
    if (templates.length && char === '}') { templates[templates.length - 1]--; if (templates.at(-1) === 0) { out += '}'; i++; continue; } }
    if (char === '"' || char === "'") {
      i++;
      while (i < source.length && source[i] !== char) i += source[i] === '\\' ? 2 : 1;
      out += char + char; i++; continue;
    }
    if (char === '/' && regexAllowed()) {
      let inClass = false; i++;
      while (i < source.length && (inClass || source[i] !== '/')) { if (source[i] === '\\') i++; else if (source[i] === '[') inClass = true; else if (source[i] === ']') inClass = false; i++; }
      i++; while (/[a-z]/.test(source[i] || '')) i++;
      out += '/x/'; continue;
    }
    out += char; previous = char; i++;
  }
  return out;
}

// Names a module binds itself anywhere: declarations, parameters and catch bindings.
function localNames(code) {
  const names = new Set();
  const add = list => { for (const part of list.replace(/[{}[\]]/g, ',').split(',')) { const name = part.split('=')[0].replace('...', '').trim().split(':').at(-1).trim(); if (/^[\w$]+$/.test(name)) names.add(name); } };
  for (const match of code.matchAll(/\b(?:class|function\*?)\s+([\w$]+)/g)) names.add(match[1]);
  // Every declarator in `let a=…, b=…;`, splitting only on commas outside brackets.
  for (const match of code.matchAll(/\b(?:let|const|var)\s+/g)) {
    let depth = 0, declarator = '', i = match.index + match[0].length;
    for (; i < code.length; i++) {
      const char = code[i];
      if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char)) { if (depth === 0) break; depth--; }
      if (depth === 0 && (char === ';' || char === ',')) { add(declarator); declarator = ''; if (char === ';') break; continue; }
      if (depth === 0 && char === '\n' && !/[=,]\s*$/.test(declarator)) break;
      declarator += char;
    }
    add(declarator);
  }
  for (const match of code.matchAll(/\b(?:let|const|var)\s*([{[][^=]*?[}\]])\s*=/g)) add(match[1]);
  for (const match of code.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g)) add(match[1]);
  for (const match of code.matchAll(/\(([^()]*)\)\s*=>/g)) add(match[1]);
  for (const match of code.matchAll(/([\w$]+)\s*=>/g)) names.add(match[1]);
  for (const match of code.matchAll(/\bcatch\s*\(([\w$]+)\)/g)) names.add(match[1]);
  return names;
}

export function linkSource(appRoot, entry) {
  const modules = [], seen = new Set(), owners = new Map(), mutable = new Set();
  const visit = url => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    let code = readFileSync(url, 'utf8');
    const imports = [];
    code = code.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';[^\S\n]*\n?/gm, (_, names, specifier) => {
      const list = names.split(',').map(name => name.trim()).filter(Boolean);
      if (list.some(name => /\s/.test(name))) throw new Error(`Aliased imports are not supported: ${fileURLToPath(url)}`);
      imports.push({list, url: resolve(specifier, url, appRoot)});
      return '';
    });
    if (/^\s*import[\s{*'"]/m.test(code)) throw new Error(`Unsupported import form in ${fileURLToPath(url)}`);
    for (const dependency of imports) visit(dependency.url);
    code = code.replace(/^export\s+(?=(?:async\s+)?function|const\s|let\s|class\s)/gm, '');
    if (/^export\s/m.test(code)) throw new Error(`Unsupported export form in ${fileURLToPath(url)}`);
    for (const match of code.matchAll(/^(?:async\s+)?function\s*\*?\s*([\w$]+)|^(?:const|let|class)\s+([\w$]+)/gm)) {
      const name = match[1] || match[2];
      if (owners.has(name) && owners.get(name) !== url.href) throw new Error(`Top-level ${name} is declared in ${owners.get(name)} and ${url.href}`);
      owners.set(name, url.href);
    }
    for (const match of code.matchAll(/^let\s+([^;]+);/gm)) for (const part of match[1].split(',')) mutable.add(part.split('=')[0].trim());
    modules.push({url, code, imports});
  };
  visit(new URL(entry, appRoot));
  // Linking shares one scope, so a missing import would still resolve here but fail in a browser.
  for (const module of modules) {
    const imported = new Set(module.imports.flatMap(({list}) => list)), code = codeOnly(module.code).replaceAll('...', ' '), local = localNames(code);
    for (const [name, owner] of owners) {
      if (owner === module.url.href || imported.has(name) || local.has(name)) continue;
      if (new RegExp(`(?<![\\w$.])${name.replace('$', '\\$')}\\b(?!\\s*:(?!:))`).test(code)) {
        throw new Error(`${fileURLToPath(module.url)} uses ${name} from ${fileURLToPath(owner)} without importing it`);
      }
    }
  }
  // Imported bindings are read-only in browsers. Reassigning one would only work after linking.
  for (const module of modules) for (const {list} of module.imports) for (const name of list) {
    if (mutable.has(name) && new RegExp(`(?<![\\w$.])${name.replace('$', '\\$')}\\s*(?:[-+*/%&|^?]{0,3}=(?!=)|\\+\\+|--)`).test(module.code)) {
      throw new Error(`${fileURLToPath(module.url)} assigns the imported binding ${name}`);
    }
  }
  return modules.map(module => `// ${path.relative(REPO_ROOT, fileURLToPath(module.url))}\n${module.code}`).join('\n');
}
