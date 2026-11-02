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
// Consent is asked per category (CONSENT_CATEGORIES): `analytics` for the tracker,
// `maps` for Google Maps embeds (src/lib/mapEmbed/mapEmbed.ts), which load Google
// content and so need consent before anything contacts Google. A page asks only
// for the categories it uses. The banner's Accept and Decline answer all of them;
// a map's own "Load map" answers `maps` alone.
//
// The choice itself is stored in localStorage under CONSENT_STORAGE_KEY as
// `{"v":1,"analytics":true|false,"maps":true|false,"at":"<ISO time>"}`, where a
// category not yet answered is absent. That entry is strictly necessary (it is
// how the site remembers the visitor said no) and needs no consent. A new
// category is a new field, not a new version: an existing answer stays valid for
// what it answered, and only the new question is asked. Bumping CONSENT_VERSION
// (when what a category covers changes) makes every stored choice invalid, so
// visitors are asked again. The `maps` answer is mirrored in the first-party
// cookie CONSENT_MAPS_COOKIE, also strictly necessary, so the edge middleware can
// measure a Google frame without that consent (src/lib/site/cspReportOnly.ts).
//
// The runtime is hand-written ES5 in a string, run inline right after the
// banner's server-rendered markup, before hydration: a stored "yes" loads the
// tracker as early as the old ungated snippet did, and a stored choice hides
// the banner before it paints. It only toggles the banner's `hidden`
// attribute (the element carries suppressHydrationWarning) and listens on the
// document, so it never fights React over the DOM.

import { safeJson, type TrackerPayload } from '@/lib/renderer/publish/trackerSnippet';
import { COOKIE_SETTINGS_HASH, legalLanguage, type LegalLanguage } from '@/lib/legal/legalPages';
import { MAPS_CONSENT_COOKIE } from '@/lib/site/cspReportOnly';

/** The localStorage key holding the visitor's choice. */
export const CONSENT_STORAGE_KEY = 'lumitra-consent';

/** Bump when what needs consent changes: every stored choice is then asked again. */
export const CONSENT_VERSION = 1;

/** The DOM id of the banner. */
export const CONSENT_BANNER_ID = 'fc-consent';

/** The session storage prefix and cookie the tracker writes (removed on revoke). */
export const TRACKER_SESSION_PREFIX = 'ap_';
export const TRACKER_COOKIE = 'lumitra_variants_pub';

/** The cookie mirroring a `maps` grant, read by the edge middleware (cspReportOnly.ts). */
export const CONSENT_MAPS_COOKIE = MAPS_CONSENT_COOKIE;

/** What a visitor is asked about, each answered on its own. */
export const CONSENT_CATEGORIES = ['analytics', 'maps'] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export type ConsentChoice = 'granted' | 'denied';

export interface StoredConsent {
  v: number;
  analytics?: boolean;
  maps?: boolean;
  at: string;
}

/**
 * The stored choice for one category from the raw localStorage value, or null
 * when there is none, it is unreadable, it was stored for another version, or
 * that category was never answered.
 */
export function parseStoredConsent(
  raw: string | null,
  version: number = CONSENT_VERSION,
  category: ConsentCategory = 'analytics',
): ConsentChoice | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredConsent> | null;
    if (!value || value.v !== version || typeof value[category] !== 'boolean') return null;
    return value[category] ? 'granted' : 'denied';
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

type Purposes = 'analytics' | 'maps' | 'both';

const BODY: Record<LegalLanguage, Record<Purposes, string>> = {
  de: {
    analytics:
      'Mit Ihrer Einwilligung erfassen wir, wie diese Website genutzt wird (Lumitra Analytics), und speichern dafür Daten in Ihrem Browser. Ohne Einwilligung wird nichts erfasst. Sie können Ihre Wahl jederzeit unter „Cookie-Einstellungen“ im Seitenfuß ändern.',
    maps:
      'Diese Seite zeigt Karten von Google Maps. Sie werden erst mit Ihrer Einwilligung geladen; dabei erhält Google (Google Ireland Limited) Daten wie Ihre IP-Adresse. Ohne Einwilligung wird keine Verbindung zu Google hergestellt. Sie können Ihre Wahl jederzeit unter „Cookie-Einstellungen“ im Seitenfuß ändern.',
    both:
      'Mit Ihrer Einwilligung erfassen wir, wie diese Website genutzt wird (Lumitra Analytics), und speichern dafür Daten in Ihrem Browser, und wir laden Karten von Google Maps, wobei Google (Google Ireland Limited) Daten wie Ihre IP-Adresse erhält. Ohne Einwilligung geschieht beides nicht. Sie können Ihre Wahl jederzeit unter „Cookie-Einstellungen“ im Seitenfuß ändern.',
  },
  en: {
    analytics:
      'With your consent we measure how this website is used (Lumitra Analytics) and store data in your browser for it. Without consent nothing is measured. You can change your choice at any time under "Cookie settings" in the footer.',
    maps:
      'This page shows maps from Google Maps. They load only with your consent, and Google (Google Ireland Limited) then receives data such as your IP address. Without consent nothing contacts Google. You can change your choice at any time under "Cookie settings" in the footer.',
    both:
      'With your consent we measure how this website is used (Lumitra Analytics) and store data in your browser for it, and we load maps from Google Maps, which gives Google (Google Ireland Limited) data such as your IP address. Without consent neither happens. You can change your choice at any time under "Cookie settings" in the footer.',
  },
};

const COPY: Record<LegalLanguage, ConsentCopy> = {
  de: {
    title: 'Datenschutz-Einstellungen',
    body: BODY.de.analytics,
    accept: 'Akzeptieren',
    decline: 'Ablehnen',
    privacyLink: 'Datenschutzerklärung',
    label: 'Datenschutz-Einstellungen',
  },
  en: {
    title: 'Privacy settings',
    body: BODY.en.analytics,
    accept: 'Accept',
    decline: 'Decline',
    privacyLink: 'Privacy policy',
    label: 'Privacy settings',
  },
};

/**
 * The banner copy for a BCP 47 tag (German for `de*`, English otherwise), naming
 * what the page asks about.
 */
export function consentCopy(language: string, categories: readonly ConsentCategory[] = ['analytics']): ConsentCopy {
  const lang = legalLanguage(language);
  const analytics = categories.includes('analytics');
  const maps = categories.includes('maps');
  const purposes: Purposes = analytics && maps ? 'both' : maps ? 'maps' : 'analytics';
  return { ...COPY[lang], body: BODY[lang][purposes] };
}

/** What the runtime needs: the categories asked, the version, the storage key and the tracker to load. */
export interface ConsentRuntimeConfig {
  /** The tracker to load after `analytics` consent, null when the page has none. */
  tracker: TrackerPayload | null;
  /** What this page asks about. Without it, `analytics` alone (the runtime's first contract). */
  categories?: readonly ConsentCategory[];
  version?: number;
  storageKey?: string;
}

/**
 * The inline runtime. Defines `window.__lumitraConsent` with `open()`,
 * `accept()`, `decline()`, `grant(category)`, `get(category)` (the analytics
 * answer without one), `categories` and `version`, then:
 *   - a stored "yes" to analytics for this version loads the tracker at once;
 *   - every category this page asks about already answered keeps the banner
 *     hidden;
 *   - otherwise the banner shows, without moving focus (it is not modal and
 *     sits first in the reading order).
 * Any link to `#cookie-settings` (the footer's "Cookie settings") reopens it
 * and moves focus to it; Escape closes a reopened banner and gives focus back
 * to the link. Accept answers every category of the page with yes and Decline
 * with no. `grant(category)` answers one (a map's "Load map" button) and closes
 * the banner when nothing else is open. Accepting analytics loads the tracker
 * (and calls the loader's `enableTracking` when it exposes one); declining it
 * after an earlier "yes" removes what the tracker stored and reloads the page so
 * nothing keeps running. Every other answer is announced as a `lumitra:consent`
 * event whose detail names the category (`{maps:true}`), which the map islands
 * listen to: a "no" removes a loaded map. Storage that throws (sandboxed frames,
 * some private modes) keeps the choice for this page view only.
 *
 * While the banner is open, nothing of the page sits in the top layer, which is
 * above every z-index (the z-index cap is src/lib/styles/stacking.ts): opening
 * it closes any open popover and modal dialog and leaves fullscreen, and while
 * it stays open a popover or modal dialog the page opens is cancelled or
 * closed, and fullscreen is left again. A modal dialog makes all else inert, so
 * the banner cannot sit above one and still be pressed. Once the visitor
 * chooses, the page has the top layer back.
 */
export function consentRuntimeScript(input: ConsentRuntimeConfig): string {
  const config = {
    key: input.storageKey ?? CONSENT_STORAGE_KEY,
    v: input.version ?? CONSENT_VERSION,
    id: CONSENT_BANNER_ID,
    hash: COOKIE_SETTINGS_HASH,
    prefix: TRACKER_SESSION_PREFIX,
    cookie: TRACKER_COOKIE,
    mapsCookie: CONSENT_MAPS_COOKIE,
    all: CONSENT_CATEGORIES,
    cats: (input.categories ?? ['analytics']).filter((c) => (CONSENT_CATEGORIES as readonly string[]).includes(c)),
    tracker: input.tracker ?? null,
  };
  return (
    '(function(){' +
    `var C=${safeJson(config)};` +
    'var w=window,d=document,el=d.getElementById(C.id),mem={},loaded=false,opener=null;' +
    'function known(c){return C.all.indexOf(c)!==-1;}' +
    'function asks(c){return C.cats.indexOf(c)!==-1;}' +
    // The stored record for this version, or null.
    'function stored(){try{var raw=w.localStorage.getItem(C.key);if(!raw)return null;var r=JSON.parse(raw);' +
    "if(!r||typeof r!=='object'||r.v!==C.v)return null;return r;}catch(e){return null;}}" +
    // One category's answer: the stored one, else this page view's (storage that throws).
    "function state(c){var r=stored(),x=r&&typeof r[c]==='boolean'?r[c]:(typeof mem[c]==='boolean'?mem[c]:null);return x===null?null:(x?'granted':'denied');}" +
    // Whether this page still has a question nobody answered.
    'function pending(){for(var i=0;i<C.cats.length;i++)if(state(C.cats[i])===null)return true;return false;}' +
    // Keeps every other category's answer: answering maps never touches analytics.
    "function write(p){var r=stored()||{},o={v:C.v},k,i;for(i=0;i<C.all.length;i++){k=C.all[i];if(typeof r[k]==='boolean')o[k]=r[k];}" +
    'for(k in p){if(Object.prototype.hasOwnProperty.call(p,k)&&known(k)){o[k]=p[k];mem[k]=p[k];}}o.at=new Date().toISOString();' +
    'try{w.localStorage.setItem(C.key,JSON.stringify(o));}catch(e){}' +
    "if(typeof p.maps==='boolean'){try{d.cookie=C.mapsCookie+(p.maps?'=1; path=/; max-age=31536000; SameSite=Lax':'=; path=/; max-age=0; SameSite=Lax');}catch(e){}}}" +
    "function emit(c,yes){var x={};x[c]=yes;try{w.dispatchEvent(new CustomEvent('lumitra:consent',{detail:x}));}catch(e){}}" +
    // Load the tracker. It is an ES module that only exports init() and
    // enableTracking() (analytics-platform packages/tracker), so a classic
    // <script src> cannot run it: import it, init it with the site's public
    // config, then turn on the post-consent behavioural tracking. The globals
    // stay for anything that reads them. A failure is logged, never silent.
    'function start(m){if(!m||typeof m.init!==\'function\'){console.warn(\'[consent] analytics tracker has no init()\');return;}' +
    'var c=C.tracker.config;if(!c.projectId){console.warn(\'[consent] analytics project id missing, tracker not started\');return;}' +
    'try{m.init({projectId:c.projectId,apiKey:c.key,endpoint:c.endpoint});if(typeof m.enableTracking===\'function\')m.enableTracking();w.LumitraAnalytics=m;}' +
    "catch(e){console.warn('[consent] analytics tracker failed to start',e);}}" +
    'function load(){if(loaded||!C.tracker)return;loaded=true;var cfg={},k;' +
    'for(k in C.tracker.config){if(Object.prototype.hasOwnProperty.call(C.tracker.config,k))cfg[k]=C.tracker.config[k];}' +
    'cfg.consent={analytics:true};w.__AP_VARIANTS=C.tracker.variants;w.__AP_CONFIG=cfg;' +
    "try{w.dispatchEvent(new CustomEvent('lumitra:consent',{detail:{analytics:true}}));}catch(e){}" +
    // __fcImportTracker is the test seam for the module import (jsdom cannot run import()).
    "if(C.tracker.src){var imp=w.__fcImportTracker||function(u){return import(u);};" +
    "imp(C.tracker.src).then(start,function(e){console.warn('[consent] analytics tracker failed to load',e);});}}" +
    // Remove what the tracker stored (revoking an earlier yes).
    'function forget(){try{var ss=w.sessionStorage;for(var i=ss.length-1;i>=0;i--){var n=ss.key(i);if(n&&n.indexOf(C.prefix)===0)ss.removeItem(n);}}catch(e){}' +
    "try{d.cookie=C.cookie+'=; path=/; max-age=0';}catch(e){}}" +
    // The top layer guard. `up` is the banner waiting on screen. Each step is
    // guarded: an engine without one of these features throws on its name.
    'function up(){return !!el&&!el.hidden;}' +
    "var told=false;function tell(){if(!told){told=true;console.warn('[consent] closed a popover, dialog or fullscreen that would cover the consent banner');}}" +
    "function shut(t){try{if(t.tagName==='DIALOG'&&t.open&&t.matches(':modal')){t.close();tell();}if(t.matches(':popover-open')){t.hidePopover();tell();}}catch(e){}}" +
    'function unfull(){var f=d.fullscreenElement||d.webkitFullscreenElement;if(!f)return;tell();' +
    'try{var p=d.exitFullscreen?d.exitFullscreen():d.webkitExitFullscreen();if(p&&p.catch)p.catch(function(){});}catch(e){}}' +
    "function clear(){var all=[];try{all=d.querySelectorAll('dialog[open]');}catch(e){}for(var i=0;i<all.length;i++)shut(all[i]);" +
    "try{all=d.querySelectorAll(':popover-open');}catch(e){all=[];}for(var j=0;j<all.length;j++)shut(all[j]);unfull();}" +
    "d.addEventListener('beforetoggle',function(ev){if(up()&&ev.newState==='open'&&ev.cancelable&&ev.target!==el){ev.preventDefault();tell();}},true);" +
    "d.addEventListener('toggle',function(ev){if(up()&&ev.newState==='open'&&ev.target&&ev.target.nodeType===1)shut(ev.target);},true);" +
    "d.addEventListener('fullscreenchange',function(){if(up())unfull();});d.addEventListener('webkitfullscreenchange',function(){if(up())unfull();});" +
    // showModal sets `open`: an engine that fires no toggle for a dialog still says that.
    "try{new MutationObserver(function(rs){if(!up())return;for(var i=0;i<rs.length;i++)shut(rs[i].target);})" +
    ".observe(d.documentElement,{subtree:true,attributes:true,attributeFilter:['open']});}catch(e){}" +
    'function show(focus){if(!el)return;el.hidden=false;clear();if(focus){try{el.focus();}catch(e){}}}' +
    'function hide(){if(!el)return;el.hidden=true;var o=opener;opener=null;if(o&&o.focus&&d.contains(o)){try{o.focus();}catch(e){}}}' +
    "function choose(yes){var before=state('analytics'),p={},i;for(i=0;i<C.cats.length;i++)p[C.cats[i]]=yes;write(p);hide();" +
    "for(i=0;i<C.cats.length;i++){if(C.cats[i]==='analytics'){if(yes)load();}else emit(C.cats[i],yes);}" +
    "if(!yes&&asks('analytics')){forget();if(before==='granted'||loaded){try{w.location.reload();}catch(e){}}}}" +
    // One category, from a control outside the banner that names it (a map's "Load map").
    "function grant(c){if(!known(c))return;var p={};p[c]=true;write(p);if(c==='analytics')load();else emit(c,true);if(up()&&!pending())hide();}" +
    'function open(){var a=d.activeElement;opener=a&&a!==d.body&&!(el&&el.contains(a))?a:null;show(true);}' +
    "w.__lumitraConsent={open:open,accept:function(){choose(true);},decline:function(){choose(false);},grant:grant,get:function(c){return state(c||'analytics');},categories:C.cats.slice(),version:C.v};" +
    "d.addEventListener('click',function(ev){var t=ev.target;while(t&&t.nodeType===1){" +
    // Only the banner's own buttons answer: a choice nobody made is not consent.
    "if(el&&el.contains(t)&&t.hasAttribute('data-fc-consent-accept')){ev.preventDefault();choose(true);return;}" +
    "if(el&&el.contains(t)&&t.hasAttribute('data-fc-consent-decline')){ev.preventDefault();choose(false);return;}" +
    "var h=t.tagName==='A'?(t.getAttribute('href')||''):'';" +
    'if(h&&h.slice(-C.hash.length)===C.hash){ev.preventDefault();opener=t;show(true);return;}' +
    't=t.parentNode;}});' +
    "d.addEventListener('keydown',function(ev){if((ev.key==='Escape'||ev.key==='Esc')&&el&&!el.hidden&&!pending()){hide();}});" +
    "if(state('analytics')==='granted')load();if(pending())show(false);" +
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
