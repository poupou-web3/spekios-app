---
{
  "title": "Sign in to a private app",
  "description": "Use Spekios’s human-only login handoff and optional encrypted saved sessions without recording passwords or private login frames as QA evidence.",
  "reviewed": "2026-11-04",
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
| Sign in before testing | Ask for a human handoff before automated exploration. Useful when detection is insufficient. |
| Public pages only | Continue without a saved session; a required login remains blocked. |

Choose the mode under **Sign-in** in the launch options (**Change** under the URL field). A saved session can be selected there for the matching app origin and execution mode. Public mode cannot use one.

## Complete the private handoff

1. Open **Activity** and choose **Open private login** on the sign-in request.
2. Use the displayed browser frame and human controls to click fields, enter text, navigate native fields or supply a verification code.
3. Finish signing in.
4. Choose **I’m signed in · continue testing**.
5. Optionally save the app session for reuse for up to 24 hours.

Spekios reloads the requested entry URL and checks the same-origin result, recognized login state and a sign-out control or changed app session state. This does not prove a particular account role or every protected permission.

Choose **Skip sign-in for this run** on any waiting prompt to continue with public pages and suppress further sign-in requests for that run. Spekios avoids the control that reached the login gate and reopens an observed public page to explore other branches. If the entry page requires login and no public page has been observed, the run reports blocked access.

## Let Spekios create a test account

Choose **Try creating an account** on a waiting sign-in prompt. When you signed in through the connected Lovable/Spekios account, its verified email is filled in automatically. Review that address or replace it with a dedicated test email, choose an account name, then start account creation. Local development and accounts without a verified linked email can supply a test email manually. Spekios generates a strong password, follows a same-origin signup link, fills supported native registration fields and submits each form once. Required terms checkboxes are accepted as part of that registration; optional marketing checkboxes are left alone.

The account is created on the target app. Spekios continues exploration only after reopening the entry page and observing authenticated access. Email or phone verification, CAPTCHA, external identity providers and unsupported forms return to private browser control so you can finish the step yourself. There is no connected mailbox service in this version.

Generated credentials stay outside recorded screenshots, run reports and model requests during signup. An encrypted local copy is retained in the auth vault; **Download account details** lets you save a private copy before closing the dialog. You can also choose to save the resulting app session for 24 hours. Account creation itself is not recorded as an automated product test.

## What stays private

Private display frames are transient, authenticated and uncached. Human text, passwords, codes, cookies and session tokens do not enter the evidence bucket or model prompts. Durable events retain IDs and input kinds rather than typed values.

Normal screenshots resume after login and can contain app-displayed personal data. Use a test account with synthetic data.

## Session reuse and expiry

Saved cookies, local storage and supported IndexedDB state are encrypted in a separate local vault. Session reuse ends after 24 hours, revocation or earlier app-side expiry.

Remove saved sessions from the workspace under **Settings → Memory & sessions → Saved app sessions**. Revocation prevents future loading; a browser that already loaded a session may remain signed in until it closes.

The worker pauses during the handoff. Requests expire after ten minutes, with at most three handoffs per run. Interruption does not replay private human inputs.

## Compatibility

Supported: same-origin native forms and manually entered verification codes. Not supported: Google/external OAuth redirects, passkeys, custom identity-provider popups or transfer of your normal browser’s cookies.

Agents can read that access is needed through **scout_access_requests**; they cannot retrieve private frames, passwords or saved-session contents.
