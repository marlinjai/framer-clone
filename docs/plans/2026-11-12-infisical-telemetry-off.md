---
title: Turn off Infisical telemetry and remove its .lumitra.co cookie
description: Procedure to switch off the product telemetry of self-hosted Infisical, prove it is off, and remove the PostHog cookie it left on the whole lumitra.co domain, with rollback.
summary: Self-hosted Infisical (infisical.lumitra.co, v0.154.6) runs posthog-js in the browser and a PostHog client on the server while `TELEMETRY_ENABLED` is on, which is its default. The browser library writes `ph_phc_<key>_posthog` on `.lumitra.co`, holding the signed-in operator's email, so every page under lumitra.co, hosted sites included, can read it. One setting on the Coolify service turns both sides off; the old cookie then has to be removed by hand in each operator browser. Waits for Marlin's yes because it restarts the secrets manager.
type: plan
status: draft
date: 2026-11-12
tags: [framer-clone, infisical, privacy, cookies, posthog, security, plan]
projects: [framer-clone, infra]
---

# Turn off Infisical telemetry and remove its .lumitra.co cookie

**Status:** draft, waiting for Marlin's yes (coordinator inbox `20261112-213020-framer-clone-posthog-coo`). Nothing here has been applied. Roadmap home: the PostHog cookie line in this repository's `ROADMAP.md`.

## 1. What the deployed source says

Infisical on production is v0.154.6: the bundle files are named `*-v0-154-6-*`, and the minified initialisation matches the tag's source line for line. Read from tag `v0.154.6` of `Infisical/infisical`:

- **The switch.** `backend/src/lib/config/env.ts`: `TELEMETRY_ENABLED: zodStrBool.default("true")`, and `zodStrBool` is `val === "true"`. Unset means on; any value other than the exact string `true` means off.
- **The browser gets it at run time.** `backend/src/server/plugins/serve-ui.ts` writes `TELEMETRY_CAPTURING_ENABLED: appCfg.TELEMETRY_ENABLED` into `/runtime-ui-env.js`. The deployed bundle reads it as `__INFISICAL_RUNTIME_ENV__.TELEMETRY_CAPTURING_ENABLED || false`, so the build-time fallback is off and the run-time value decides.
- **Browser initialisation.** `frontend/src/components/analytics/posthog.ts` calls `posthog.init` only when `ENV === "production"` and `TELEMETRY_CAPTURING_ENABLED === true` and a key exists. The call passes only `api_host`, so posthog-js defaults apply: a cookie on the parent domain (`cross_subdomain_cookie: true`), `localStorage+cookie` persistence, autocapture and page views.
- **Browser sending.** `frontend/src/components/utilities/telemetry/Telemetry.ts`: `capture` and `identify` each check the same two conditions again before calling PostHog. These are the only two frontend files that import posthog-js. At sign-in the app calls `identify(email, email)`, so the email becomes the `distinct_id` in the cookie and a person property at PostHog.
- **Server sending.** `backend/src/services/telemetry/telemetry-service.ts` creates its PostHog client only when `TELEMETRY_ENABLED` is true, so nothing is sent while it is off. The aggregation queue (`telemetry-queue.ts`) is gated the same way. While it is on, a self-hosted instance sends only the `UserSignedUp` event, carrying the new user's username and email.
- **Result.** `TELEMETRY_ENABLED=false` stops browser initialisation, browser sending and server sending. With no `init`, posthog-js never creates its persistence, so no new cookie is written.

## 2. Impact so far

- **Who:** every person who has signed in to infisical.lumitra.co in a browser. Each of those browsers holds the cookie with that person's email until about a year after its last write. The automation profile's copy expires 2027-11-05. Site visitors are not affected unless they are also Infisical operators.
- **What left the estate:** the operator's email, the "User Logged In" event, page views, and autocaptured clicks (Infisical URLs, which carry organisation and project ids) went to Infisical Inc.'s PostHog project at app.posthog.com. The server also sent each sign-up's email there. Secret values are not part of this by design, because Infisical masks them on screen and autocapture does not record input values. That has not been tested.
- **Who could read the cookie:** script on any page under `lumitra.co`. Today that is only our own code, because published sites strip `<script>`.

## 3. Limits of what is known

- **Where the setting goes.** Coolify has no `TELEMETRY_ENABLED` variable on the service (a by-name lookup returned nothing). Whether a variable added in the Coolify interface reaches the container depends on the compose file referencing it, and the compose was deliberately not read because it holds the encryption key. The safe route is to add the line to the backend container's `environment` in the compose itself (section 4).
- **Remote settings.** Whether Infisical's PostHog project switched on session recording through its remote settings is not known. Section 4 stops it either way, because recording also needs `init`.
- **The data already sent** can only be removed by asking Infisical. That is Marlin's call, under GDPR Article 17 (the right to erasure).
- **When a write happens.** It was not proven exactly when the cookie is written. Loading Infisical while signed in neither refreshed it nor sent PostHog traffic in the automation browser on 2026-11-12, and sign-in is the likely moment. Step 5c covers it.

## 4. Procedure (only after Marlin's yes)

Order matters: switch telemetry off first. A cookie removed while telemetry is still on comes back at the next sign-in.

1. **Window.** Infisical restarts for about a minute. Secret fetches by deploys, the secrets proxy and continuous integration fail during it. Pick a moment with no deploy running and tell active sessions.
2. **Snapshot.** In the Coolify interface, copy the current compose of the service "Infisical" (`wzp79onfjkt2cqorgzdnos1m`) somewhere off the host. Read it there, never in an agent context.
3. **Change.** Add `TELEMETRY_ENABLED=false` to the `environment` of the Infisical backend container in that compose, save, and redeploy the service. There is no migration and no data change.
4. **Health.** Coolify shows the service `running:healthy`, `https://infisical.lumitra.co/api/status` answers 200, and a known `execute_with_secrets` call through the secrets proxy succeeds.
5. **Prove it is off.**
   a. `curl -s https://infisical.lumitra.co/runtime-ui-env.js | grep -o '"TELEMETRY_CAPTURING_ENABLED":[a-z]*'` prints `"TELEMETRY_CAPTURING_ENABLED":false`.
   b. On boot the backend logs Infisical's opt-in notice ("To opt into telemetry, you can set ..."). Check it by count only: grep the container log for `opt into telemetry` and print the count, never the log.
   c. In the automation browser, with network capture on, open Infisical pages under the existing session. The pass condition is zero requests to any `*posthog.com` host. The next real sign-in, made by Marlin, must also leave no new `ph_phc_*` cookie.
6. **Remove the old cookie** in each operator browser by name only. Never clear all `lumitra.co` site data, because that also deletes the suite session `lumitra_session` and signs the person out everywhere.
   - In Chrome: DevTools on any lumitra.co page, then Application, Cookies, delete the row named `ph_phc_…_posthog` with domain `.lumitra.co`. Then, on infisical.lumitra.co, Application, Local storage, delete the key of the same name (it is per host, so it was never readable by sites; it is cleared for completeness).
   - Automation profile: Chrome DevTools Protocol `Network.deleteCookies` with that name, domain `.lumitra.co`, path `/`, on the visible profile (port 9222). Afterwards run `dev-browser-auto --refresh` so the headless twin copies the cleaned profile.
   - Each other operator, Sharon among them, does the same in their own browser, or is told how to.
7. **Prove the removal.** On a `*.sites.lumitra.co` page in each cleaned browser, `document.cookie` names (names only) include no `ph_phc_*`. A day later, check again to confirm nothing wrote it back.

## 5. Rollback

- **Setting:** remove the `TELEMETRY_ENABLED=false` line from the compose (or restore the snapshot from step 2) and redeploy. Step 5a then shows `true` again. Nothing else changes, because the setting touches no data.
- **Cookie:** there is no rollback and none is needed. A deleted cookie only means PostHog would mint a new anonymous id if telemetry were ever switched on again.

## 6. Decisions

- **Decided, say so if you disagree:** remove the cookie by hand in the few operator browsers rather than have Sites send an expiring `Set-Cookie` for it. The second option would ship Infisical's key in our code and touch every visitor, and it is only worth it if more operators turn up than can be asked.
- **Marlin's:** the yes for steps 1 to 4 (a production change on the secrets manager); whether to ask Infisical to delete what was already sent; whether hosted sites should move off `lumitra.co`. That last one is the separate roadmap question, because code on a sites host could read or write any other script-readable `.lumitra.co` cookie.
