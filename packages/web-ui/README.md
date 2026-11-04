# web-ui: shared UI kit

Shared browser kit for the two Spekios frontends: the customer workspace (`apps/web`) and the operator back office (`apps/backoffice`). Plain ES modules and CSS with no build step and no `package.json`, so the pages keep a strict `script-src 'self'; style-src 'self'` policy.

```
src/
  format.js       escaping, numbers, dates, run names, provider labels
  components.js   icon, pill, stat, empty, json, button, kv, toast
  usage.js        input / output / total tokens, model prices and estimated cost
  http.js         authenticated same-origin requests (workspaceRequest, signIn, requireOk)
  catalog.js      model price list used by workspace settings
  theme.js        System / Light / Dark preference and its control
  theme-init.js   classic <head> script: applies a saved theme before first paint
  styles/
    tokens.css      every color once, as light-dark(); cobalt brand
    base.css        reset, typography, native form controls
    components.css  buttons, status, panels, tables, notices, tabs, drawers
    shell.css       sidebar, top bar and content frame
testing/
  link.mjs        links an app's modules into one script for the vm-based tests
test/             node --test suites, including deployment-boundary checks
```

Both deployments serve this `src/` directory at `/assets/ui/` and their own app code at `/assets/app/`: `scout-api` embeds it at compile time (`apps/api/build.rs`) and the back office image copies it (`infra/backoffice/Dockerfile`), so a kit change needs `just reload` to rebuild both. Apps import the kit by absolute URL (`/assets/ui/format.js`) and their own modules by relative path.

## Rules the tests enforce

- The kit imports only its own modules. Apps never import each other.
- Top-level names are unique within an app's module graph, every cross-module name is imported, and imported `let` bindings are never reassigned. `testing/link.mjs` rejects violations, because they would behave differently in a browser than in the linked test script.
- Pages that build DOM nodes directly (agent connection, issues) use `mountThemeSwitch`; they never assign `innerHTML`.

## Theme

`data-theme="light|dark"` on `<html>` forces a scheme; without it, `color-scheme: light dark` follows the operating system. Change kit colors only in `tokens.css`; the customer pages layer their own theme on top (`apps/web/src/styles/spekios.css`). Keep status green, amber, red and cyan distinct from the brand.

Run `just web-test` for all frontend suites (this package, `apps/web` and `apps/backoffice`).
