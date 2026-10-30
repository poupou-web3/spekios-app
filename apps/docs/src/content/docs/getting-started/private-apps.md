---
{
  "title": "Sign in to a private app",
  "description": "Use Scout’s human-only login handoff and optional encrypted saved sessions without recording passwords or private login frames as QA evidence.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 4
  }
}
---
Use the workspace’s private login handoff when an app requires an account. A person operates the same test browser, then hands it back to the explorer.

## Choose an access mode

| Mode | Behavior |
| --- | --- |
| Ask when sign-in is detected | Offer private login when a recognized sign-in option or login gate appears. |
| Sign in before exploration | Ask for a human handoff before automated exploration. Useful when detection is insufficient. |
| Public pages only | Continue without a saved session; a required login remains blocked. |

A saved session can be explicitly selected for the matching app origin and execution mode. Public mode cannot use one.

## Complete the private handoff

1. Choose **Open private login**.
2. Use the displayed browser frame and human controls to click fields, enter text, navigate native fields or supply a verification code.
3. Finish signing in.
4. Choose **I’m signed in · continue testing**.
5. Optionally save the app session for reuse for up to 24 hours.

Scout reloads the requested entry URL and checks the same-origin result, recognized login state and a sign-out control or changed app session state. This does not prove a particular account role or every protected permission.

## What stays private

Private display frames are transient, authenticated and uncached. Human text, passwords, codes, cookies and session tokens do not enter the evidence bucket or model prompts. Durable events retain IDs and input kinds rather than typed values.

Normal screenshots resume after login and can contain app-displayed personal data. Use a test account with synthetic data.

## Session reuse and expiry

Saved cookies, local storage and supported IndexedDB state are encrypted in a separate local vault. Session reuse ends after 24 hours, revocation or earlier app-side expiry.

Remove saved sessions from the workspace under **Settings → Saved app sessions**. Revocation prevents future loading; a browser that already loaded a session may remain signed in until it closes.

The worker pauses during the handoff. Requests expire after ten minutes, with at most three handoffs per run. Interruption does not replay private human inputs.

## Compatibility

Supported: same-origin native forms and manually entered verification codes. Not supported: Google/external OAuth redirects, passkeys, custom identity-provider popups or transfer of your normal browser’s cookies.

Agents can read that access is needed through **scout_access_requests**; they cannot retrieve private frames, passwords or saved-session contents.
