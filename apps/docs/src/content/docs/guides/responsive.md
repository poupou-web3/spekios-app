---
{
  "title": "Test responsive web behavior",
  "description": "Run independent desktop, tablet and mobile Chromium explorations and interpret viewport-specific evidence without claiming native-device coverage.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 4
  }
}
---
Spekios records each viewport exploration separately. Choose a **Screen size** under **Change** below the URL field, set a default under **Settings → Exploration**, or use the matrix command to run all three at once, one browser each.

| Profile | Viewport in CSS pixels |
| --- | --- |
| Desktop (default) | 1920 × 1080 |
| Tablet | 768 × 1024 |
| Mobile | 390 × 844 |

## Choose a profile

The queue freezes the selected profile when admitting the job. Reports and fresh reproduction retain it. Changing a default later does not alter historical runs or retries.

Each profile starts a separate graph, limits and usage record. App memory is also kept separately per screen size. A small-screen run can discover different controls or layouts, but it does not share a guaranteed coverage plan with the others.

## Run the matrix

With a configured provider and a target the Docker browser can reach:

~~~sh
just explore-matrix http://exploration-fixture:8082/interactions
~~~

Use a URL reachable from the Docker browser. For interactive sign-in, launch a queued run from the workspace; the direct CLI does not expose the private login dialog.

## Investigate viewport-specific outcomes

Check the recorded dimensions, visible controls, clipping and expected result. Compare separate report/evidence IDs rather than assuming two runs performed exactly the same actions.

Mobile here means a Chromium viewport. It does not emulate a physical phone’s complete hardware/browser behavior or test a native mobile application.
