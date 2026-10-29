import {readFileSync} from 'node:fs';

// Evaluate the actual shared transport in each DOM sandbox, using that
// sandbox's fetch and AbortSignal. Pages keep their ordinary browser imports.
export function uiSource(name) {
  const transport=readFileSync(new URL('../workspace-http.js',import.meta.url),'utf8').replace(/^export /gm,'');
  const page=readFileSync(new URL('../'+name,import.meta.url),'utf8')
    .replace(/^import \{workspaceRequest,requireOk\} from '\/assets\/workspace-http.js';\n/m,'');
  return transport+'\n'+page;
}
