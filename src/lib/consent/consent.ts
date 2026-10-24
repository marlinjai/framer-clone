// src/lib/consent/consent.ts
//
// The published site's consent gate (plan
// docs/plans/2026-10-23-published-site-essentials.md, decision 6). PURE: no
// React, no server code, so the renderer, the tests and anything else share
// one definition of the stored choice, the copy and the runtime.
//
// Why it exists: the Lumitra Analytics tracker stores a session id and
// experiment variants in sessionStorage and a variants cookie on the visitor's
// device. Under section 25 of the German TDDDG (formerly TTDSG) storing
// non-essential data on a device needs consent. So on a published site with
// analytics enabled the tracker is NOT in the HTML: the page carries a small
// first-party banner and an inline runtime that loads the tracker only after
// the visitor accepts. Declining loads nothing at all (not even the config
// globals). A site where nothing needs consent gets no banner and no runtime.
//
// The choice itself is stored in localStorage under CONSENT_STORAGE_KEY as
// `{"v":1,"analytics":true|false,"at":"<ISO time>"}`. That entry is strictly
// necessary (it is how the site remembers the visitor said no) and needs no
// consent. Bumping CONSENT_VERSION (when what the site measures changes)
// makes every stored choice invalid, so visitors are asked again.
//
// The runtime is hand-written ES5 in a string, run inline right after the
// banner's server-rendered markup, before hydration: a stored "yes" loads the
// tracker as early as the old ungated snippet did, and a stored choice hides
// the banner before it paints. It only toggles the banner's `hidden`
// attribute (the element carries suppressHydrationWarning) and listens on the
// document, so it never fights React over the DOM.

import { safeJson, type TrackerPayload } from '@/lib/renderer/publish/trackerSnippet';
import { COOKIE_SETTINGS_HASH, legalLanguage, type LegalLanguage } from '@/lib/legal/legalPages';

/** The localStorage key holding the visitor's choice. */
export const CONSENT_STORAGE_KEY = 'lumitra-consent';

/** Bump when what needs consent changes: every stored choice is then asked again. */
export const CONSENT_VERSION = 1;

/** The DOM id of the banner. */
export const CONSENT_BANNER_ID = 'fc-consent';

/** The session storage prefix and cookie the tracker writes (removed on revoke). */
export const TRACKER_SESSION_PREFIX = 'ap_';
export const TRACKER_COOKIE = 'lumitra_variants_pub';

export type ConsentChoice = 'granted' | 'denied';

export interface StoredConsent {
  v: number;
  analytics: boolean;
  at: string;
}

/**
 * The stored choice from the raw localStorage value, or null when there is
 * none, it is unreadable or it was stored for another version.
 */
export function parseStoredConsent(raw: string | null, version: number = CONSENT_VERSION): ConsentChoice | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredConsent> | null;
    if (!value || value.v !== version || typeof value.analytics !== 'boolean') return null;
    return value.analytics ? 'granted' : 'denied';
  } catch {
    return null;
  }
}

export interface ConsentCopy {
  title: string;
  body: string;
  accept: string;
  decline: string;
  privacyLink: string;
  /** The accessible name of the dialog region. */
  label: string;
}

const COPY: Record<LegalLanguage, ConsentCopy> = {
  de: {
    title: 'Datenschutz-Einstellungen',
    body:
      'Mit Ihrer Einwilligung erfassen wir, wie diese Website genutzt wird (Lumitra Analytics), und speichern dafür Daten in Ihrem Browser. Ohne Einwilligung wird nichts erfasst. Sie können Ihre Wahl jederzeit unter „Cookie-Einstellungen“ im Seitenfuß ändern.',
    accept: 'Akzeptieren',
    decline: 'Ablehnen',
    privacyLink: 'Datenschutzerklärung',
    label: 'Datenschutz-Einstellungen',
  },
  en: {
    title: 'Privacy settings',
    body:
      'With your consent we measure how this website is used (Lumitra Analytics) and store data in your browser for it. Without consent nothing is measured. You can change your choice at any time under "Cookie settings" in the footer.',
    accept: 'Accept',
    decline: 'Decline',
    privacyLink: 'Privacy policy',
    label: 'Privacy settings',
  },
};

/** The banner copy for a BCP 47 tag: German for `de*`, English otherwise. */
export function consentCopy(language: string): ConsentCopy {
  return COPY[legalLanguage(language)];
}

/** What the runtime needs: the version, the storage key and the tracker to load. */
export interface ConsentRuntimeConfig {
  tracker: TrackerPayload;
  version?: number;
  storageKey?: string;
}

/**
 * The inline runtime. Defines `window.__lumitraConsent` with `open()`,
 * `accept()`, `decline()`, `get()` and `version`, then:
 *   - a stored "yes" for this version loads the tracker at once;
 *   - a stored "no" keeps the banner hidden and loads nothing;
 *   - no (valid) choice shows the banner, without moving focus (it is not
 *     modal and sits first in the reading order).
 * Any link to `#cookie-settings` (the footer's "Cookie settings") reopens it
 * and moves focus to it; Escape closes a reopened banner and gives focus back
 * to the link. Accepting loads the tracker (and calls the loader's
 * `enableTracking` when it exposes one); declining after an earlier "yes"
 * removes what the tracker stored and reloads the page so nothing keeps
 * running. Storage that throws (sandboxed frames, some private modes) keeps
 * the choice for this page view only.
 */
export function consentRuntimeScript(input: ConsentRuntimeConfig): string {
  const config = {
    key: input.storageKey ?? CONSENT_STORAGE_KEY,
    v: input.version ?? CONSENT_VERSION,
    id: CONSENT_BANNER_ID,
    hash: COOKIE_SETTINGS_HASH,
    prefix: TRACKER_SESSION_PREFIX,
    cookie: TRACKER_COOKIE,
    tracker: input.tracker,
  };
  return (
    '(function(){' +
    `var C=${safeJson(config)};` +
    'var w=window,d=document,el=d.getElementById(C.id),mem=null,loaded=false,opener=null;' +
    // The stored choice for this version, or null.
    'function read(){try{var raw=w.localStorage.getItem(C.key);if(!raw)return null;var r=JSON.parse(raw);' +
    "if(!r||r.v!==C.v||typeof r.analytics!=='boolean')return null;return r.analytics?'granted':'denied';}catch(e){return null;}}" +
    'function current(){var r=read();return r!==null?r:mem;}' +
    "function write(yes){mem=yes?'granted':'denied';try{w.localStorage.setItem(C.key,JSON.stringify({v:C.v,analytics:yes,at:new Date().toISOString()}));}catch(e){}}" +
    // Load the tracker: the same globals and loader the ungated snippet used.
    'function enable(){var t=w.LumitraAnalytics;if(t&&typeof t.enableTracking===\'function\'){try{t.enableTracking();}catch(e){}}}' +
    'function load(){if(loaded||!C.tracker)return;loaded=true;var cfg={},k;' +
    'for(k in C.tracker.config){if(Object.prototype.hasOwnProperty.call(C.tracker.config,k))cfg[k]=C.tracker.config[k];}' +
    'cfg.consent={analytics:true};w.__AP_VARIANTS=C.tracker.variants;w.__AP_CONFIG=cfg;' +
    "try{w.dispatchEvent(new CustomEvent('lumitra:consent',{detail:{analytics:true}}));}catch(e){}" +
    "if(C.tracker.src){var s=d.createElement('script');s.async=true;s.src=C.tracker.src;s.setAttribute('data-fc-tracker','');" +
    's.onload=enable;(d.head||d.documentElement).appendChild(s);}else{enable();}}' +
    // Remove what the tracker stored (revoking an earlier yes).
    'function forget(){try{var ss=w.sessionStorage;for(var i=ss.length-1;i>=0;i--){var n=ss.key(i);if(n&&n.indexOf(C.prefix)===0)ss.removeItem(n);}}catch(e){}' +
    "try{d.cookie=C.cookie+'=; path=/; max-age=0';}catch(e){}}" +
    'function show(focus){if(!el)return;el.hidden=false;if(focus){try{el.focus();}catch(e){}}}' +
    'function hide(){if(!el)return;el.hidden=true;var o=opener;opener=null;if(o&&o.focus&&d.contains(o)){try{o.focus();}catch(e){}}}' +
    'function choose(yes){var before=current();write(yes);hide();if(yes){load();return;}' +
    "forget();if(before==='granted'||loaded){try{w.location.reload();}catch(e){}}}" +
    'function open(){var a=d.activeElement;opener=a&&a!==d.body&&!(el&&el.contains(a))?a:null;show(true);}' +
    'w.__lumitraConsent={open:open,accept:function(){choose(true);},decline:function(){choose(false);},get:function(){return current();},version:C.v};' +
    "d.addEventListener('click',function(ev){var t=ev.target;while(t&&t.nodeType===1){" +
    "if(t.hasAttribute('data-fc-consent-accept')){ev.preventDefault();choose(true);return;}" +
    "if(t.hasAttribute('data-fc-consent-decline')){ev.preventDefault();choose(false);return;}" +
    "var h=t.tagName==='A'?(t.getAttribute('href')||''):'';" +
    'if(h&&h.slice(-C.hash.length)===C.hash){ev.preventDefault();opener=t;show(true);return;}' +
    't=t.parentNode;}});' +
    "d.addEventListener('keydown',function(ev){if((ev.key==='Escape'||ev.key==='Esc')&&el&&!el.hidden&&current()!==null){hide();}});" +
    "var c=current();if(c==='granted')load();else if(c===null)show(false);" +
    'if(w.location&&w.location.hash===C.hash)show(true);' +
    '})();'
  );
}

/**
 * CSS for the banner that inline styles cannot express: `hidden` must win over
 * the inline `display`, a visible focus ring, and links to `#cookie-settings`
 * hidden where nothing needs consent (`hideCookieLinks`). Constant text only.
 */
export function consentCss(): string {
  return (
    `#${CONSENT_BANNER_ID}[hidden]{display:none!important}` +
    `#${CONSENT_BANNER_ID} button:focus-visible,#${CONSENT_BANNER_ID} a:focus-visible{outline:2px solid currentColor;outline-offset:2px}` +
    `#${CONSENT_BANNER_ID}:focus{outline:none}` +
    `#${CONSENT_BANNER_ID}:focus-visible{outline:2px solid currentColor;outline-offset:2px}`
  );
}

/** On a site where nothing needs consent, a "Cookie settings" link would do nothing: hide it. */
export const HIDE_COOKIE_LINKS_CSS = `a[href$="${COOKIE_SETTINGS_HASH}"]{display:none!important}`;
