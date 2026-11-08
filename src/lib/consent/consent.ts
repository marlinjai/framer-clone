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

/**
 * How long a banner opened from outside it ("Load map", "Cookie settings", the
 * `#cookie-settings` address) ignores pointer clicks on Accept and Decline, unless an
 * earlier press landed inside it: the opening tap's twin must not answer.
 */
export const CONSENT_TAP_GUARD_MS = 500;

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

/** One purpose in a banner that asks about more than one. */
export interface ConsentRowCopy {
  title: string;
  text: string;
}

export interface ConsentCopy {
  title: string;
  /** The banner's text: the one purpose it asks about, or the intro of a banner with one row per purpose. */
  body: string;
  accept: string;
  decline: string;
  privacyLink: string;
  /** The accessible name of the dialog region. */
  label: string;
  /** Each purpose on its own, for a banner that asks about more than one. */
  rows: Record<ConsentCategory, ConsentRowCopy>;
  /** Answers every purpose the banner shows with no. */
  declineAll: string;
  /** Closes a banner whose questions are all answered. */
  close: string;
}

type Purposes = ConsentCategory | 'several';

const BODY: Record<LegalLanguage, Record<Purposes, string>> = {
  de: {
    analytics:
      'Mit Ihrer Einwilligung erfassen wir, wie diese Website genutzt wird (Lumitra Analytics), und speichern dafür Daten in Ihrem Browser. Ohne Einwilligung wird nichts erfasst. Sie können Ihre Wahl jederzeit unter „Cookie-Einstellungen“ im Seitenfuß ändern.',
    maps:
      'Diese Website zeigt Karten von Google Maps. Sie werden erst mit Ihrer Einwilligung geladen; dabei erhält Google (Google Ireland Limited) Daten wie Ihre IP-Adresse und kann Cookies setzen. Ohne Einwilligung wird keine Verbindung zu Google hergestellt. Sie können Ihre Wahl jederzeit unter „Cookie-Einstellungen“ im Seitenfuß ändern.',
    several:
      'Diese Website fragt Sie für jeden Zweck einzeln. Ohne Ihre Einwilligung geschieht nichts davon. Sie können Ihre Wahl jederzeit unter „Cookie-Einstellungen“ im Seitenfuß ändern.',
  },
  en: {
    analytics:
      'With your consent we measure how this website is used (Lumitra Analytics) and store data in your browser for it. Without consent nothing is measured. You can change your choice at any time under "Cookie settings" in the footer.',
    maps:
      'This website shows maps from Google Maps. They load only with your consent, and Google (Google Ireland Limited) then receives data such as your IP address and may set cookies. Without consent nothing contacts Google. You can change your choice at any time under "Cookie settings" in the footer.',
    several:
      'This website asks you about each purpose separately. Without your consent none of it happens. You can change your choice at any time under "Cookie settings" in the footer.',
  },
};

const ROWS: Record<LegalLanguage, Record<ConsentCategory, ConsentRowCopy>> = {
  de: {
    analytics: {
      title: 'Reichweitenmessung (Lumitra Analytics)',
      text: 'Wir erfassen, wie diese Website genutzt wird, und speichern dafür Daten in Ihrem Browser.',
    },
    maps: {
      title: 'Karten von Google Maps',
      text: 'Beim Laden einer Karte erhält Google (Google Ireland Limited) Daten wie Ihre IP-Adresse und kann Cookies setzen. Dabei können Daten in die USA übermittelt werden.',
    },
  },
  en: {
    analytics: {
      title: 'Audience measurement (Lumitra Analytics)',
      text: 'We measure how this website is used and store data in your browser for it.',
    },
    maps: {
      title: 'Maps from Google Maps',
      text: 'When a map loads, Google (Google Ireland Limited) receives data such as your IP address and may set cookies. Data may be transferred to the USA.',
    },
  },
};

const COPY: Record<LegalLanguage, Omit<ConsentCopy, 'body' | 'rows'>> = {
  de: {
    title: 'Datenschutz-Einstellungen',
    accept: 'Akzeptieren',
    decline: 'Ablehnen',
    privacyLink: 'Datenschutzerklärung',
    label: 'Datenschutz-Einstellungen',
    declineAll: 'Alle ablehnen',
    close: 'Schließen',
  },
  en: {
    title: 'Privacy settings',
    accept: 'Accept',
    decline: 'Decline',
    privacyLink: 'Privacy policy',
    label: 'Privacy settings',
    declineAll: 'Decline all',
    close: 'Close',
  },
};

/**
 * The banner copy for a BCP 47 tag (German for `de*`, English otherwise), naming
 * what the site asks about: one purpose, or an intro above one row per purpose.
 */
export function consentCopy(language: string, categories: readonly ConsentCategory[] = ['analytics']): ConsentCopy {
  const lang = legalLanguage(language);
  const known = CONSENT_CATEGORIES.filter((c) => categories.includes(c));
  const purposes: Purposes = known.length > 1 ? 'several' : (known[0] ?? 'analytics');
  return { ...COPY[lang], body: BODY[lang][purposes], rows: ROWS[lang] };
}
/** What the runtime needs: the categories asked, the version, the storage key and the tracker to load. */
export interface ConsentRuntimeConfig {
  /** The tracker to load after `analytics` consent, null when the page has none. */
  tracker: TrackerPayload | null;
  /** What this page uses, and so asks about by itself. Without it, `analytics` alone (the runtime's first contract). */
  categories?: readonly ConsentCategory[];
  /**
   * What the whole site uses: a banner reopened from "Cookie settings" shows each of
   * these, on any page, so a "yes" given on one page can be withdrawn on every other.
   * Without it, the page's categories.
   */
  siteCategories?: readonly ConsentCategory[];
  version?: number;
  storageKey?: string;
}

/**
 * The inline runtime. Defines `window.__lumitraConsent` with `open(category?)`,
 * `accept()`, `decline()`, `get(category)` (the analytics answer without one),
 * `categories` and `version`, then:
 *   - a stored "yes" to analytics for this version loads the tracker at once;
 *   - every category this page uses already answered keeps the banner hidden;
 *   - otherwise the banner shows the questions of this page, without moving focus
 *     (it is not modal and sits first in the reading order).
 *
 * Only the banner's own buttons answer. A banner that asks about more than one
 * purpose has a row per purpose (`data-fc-consent-row`), each with its own Accept
 * and Decline that name it (`data-fc-consent-accept="maps"`), so each purpose is
 * one choice; its "Decline all" answers every row it shows with no. A button
 * without a name answers every row shown, which is the one row of a single banner.
 *
 * Opened by the visitor (a link to `#cookie-settings`, the footer's "Cookie
 * settings", or `open()`), the banner shows every category of the site, answered
 * or not, takes focus, and stays open until the visitor closes it (Close, or
 * Escape once nothing is open), so a "yes" given on any page can be withdrawn on
 * any page. `open(category)` is how a map's "Load map" asks: the banner shows the
 * page's questions and that one, focused on it, and closes once nothing it shows
 * is open. A map's placeholder never answers by itself, so no stored style can
 * turn a click on it into a consent nobody gave. A banner opened this way also
 * ignores pointer clicks on Accept and Decline for CONSENT_TAP_GUARD_MS, unless an
 * earlier press landed inside it: the banner appears under the finger that opened it,
 * and a quick second tap aimed at a decoy must not answer. Keys always answer.
 *
 * Accepting analytics loads the tracker (and calls the loader's `enableTracking`
 * when it exposes one); declining it after an earlier "yes" removes what the
 * tracker stored and reloads the page so nothing keeps running. Every other answer
 * is announced as a `lumitra:consent` event whose detail names the category
 * (`{maps:true}`), which the map islands listen to: a "no" removes a loaded map.
 * Storage that throws (sandboxed frames, some private modes) keeps the choice for
 * this page view only.
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
  const known = (list: readonly string[]) => CONSENT_CATEGORIES.filter((c) => list.includes(c));
  const cats = known(input.categories ?? ['analytics']);
  const config = {
    key: input.storageKey ?? CONSENT_STORAGE_KEY,
    v: input.version ?? CONSENT_VERSION,
    id: CONSENT_BANNER_ID,
    hash: COOKIE_SETTINGS_HASH,
    prefix: TRACKER_SESSION_PREFIX,
    cookie: TRACKER_COOKIE,
    mapsCookie: CONSENT_MAPS_COOKIE,
    all: CONSENT_CATEGORIES,
    cats,
    site: known([...cats, ...(input.siteCategories ?? [])]),
    tracker: input.tracker ?? null,
  };
  return (
    '(function(){' +
    `var C=${safeJson(config)};` +
    // mode: how the banner was opened. 'auto' (the page asked), 'focus' (a map asked), 'user' (Cookie settings).
    "var w=window,d=document,el=d.getElementById(C.id),mem={},loaded=false,opener=null,mode='auto',focusCat=null;" +
    // The tap guard: a banner opened by something outside it ("Load map", the footer
    // link, the address) appears under the visitor's finger, so a quick second tap aimed
    // at a decoy would land on its Accept. For the guard's time after such an opening a
    // pointer click answers nothing unless an earlier pointer press landed inside the
    // banner. Keyboard activation (a click with detail 0) always answers.
    `var guardUntil=0,downs=0,GUARD=${CONSENT_TAP_GUARD_MS};` +
    'function guard(){guardUntil=Date.now()+GUARD;downs=0;}' +
    'function guarded(ev){return ev.detail!==0&&Date.now()<guardUntil&&downs<2;}' +
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
    // The rows of a banner with one per purpose, and which categories the banner shows now.
    "function rows(){try{return el?el.querySelectorAll('[data-fc-consent-row]'):[];}catch(e){return [];}}" +
    "function wanted(c){return mode==='user'?C.site.indexOf(c)!==-1:(asks(c)||c===focusCat);}" +
    "function shown(){var rs=rows(),out=[],i,c;if(!rs.length){var base=mode==='user'?C.site:C.cats;for(i=0;i<base.length;i++)out.push(base[i]);if(focusCat&&out.indexOf(focusCat)===-1)out.push(focusCat);return out;}" +
    "for(i=0;i<rs.length;i++){c=rs[i].getAttribute('data-fc-consent-row');if(!rs[i].hidden&&known(c))out.push(c);}return out;}" +
    "function openShown(){var s=shown();for(var i=0;i<s.length;i++)if(state(s[i])===null)return true;return false;}" +
    // Shows the rows this opening asks about, marks each row's answer, and the Close button once nothing is open.
    "function layout(){var rs=rows(),i,c,b,j,v,st;for(i=0;i<rs.length;i++){c=rs[i].getAttribute('data-fc-consent-row');rs[i].hidden=!wanted(c);" +
    "st=state(c);b=rs[i].querySelectorAll('[data-fc-consent-accept],[data-fc-consent-decline]');for(j=0;j<b.length;j++){v=b[j].hasAttribute('data-fc-consent-accept');" +
    "b[j].setAttribute('aria-pressed',st===null?'false':String((st==='granted')===v));}}" +
    "var x=el?el.querySelector('[data-fc-consent-close]'):null;if(x)x.hidden=openShown();}" +
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
    // Focus goes to the row asked about, else to the banner.
    "function show(focus){if(!el)return;layout();el.hidden=false;clear();if(focus){var t=null;" +
    "if(focusCat){try{t=el.querySelector('[data-fc-consent-row=\"'+focusCat+'\"]');}catch(e){t=null;}}" +
    "try{(t&&!t.hidden?t:el).focus();}catch(e){}}}" +
    "function hide(){if(!el)return;el.hidden=true;mode='auto';focusCat=null;var o=opener;opener=null;if(o&&o.focus&&d.contains(o)){try{o.focus();}catch(e){}}}" +
    // Answers some categories: yes loads, no forgets (a page that ran the tracker reloads).
    "function answer(list,yes){var before=state('analytics'),p={},i,n=0;for(i=0;i<list.length;i++)if(known(list[i])){p[list[i]]=yes;n++;}if(!n)return;write(p);" +
    "var stop=false;for(i=0;i<list.length;i++){if(!known(list[i]))continue;if(list[i]==='analytics'){if(yes)load();else{forget();if(before==='granted'||loaded)stop=true;}}else emit(list[i],yes);}" +
    "if(stop){try{w.location.reload();}catch(e){}}" +
    "if(mode!=='user'&&!openShown())hide();else layout();}" +
    "function nameOf(t,attr){var v=t.getAttribute(attr);return v&&known(v)?[v]:shown();}" +
    "function open(c){guard();var a=d.activeElement;opener=a&&a!==d.body&&!(el&&el.contains(a))?a:null;" +
    "if(c&&known(c)&&C.site.indexOf(c)!==-1){if(mode!=='user')mode='focus';focusCat=c;}else{mode='user';focusCat=null;}show(true);}" +
    "w.__lumitraConsent={open:open,accept:function(){answer(shown(),true);},decline:function(){answer(shown(),false);},get:function(c){return state(c||'analytics');},categories:C.cats.slice(),version:C.v};" +
    "d.addEventListener('pointerdown',function(ev){if(el&&ev.target&&el.contains(ev.target))downs++;},true);" +
    "d.addEventListener('click',function(ev){var t=ev.target;while(t&&t.nodeType===1){" +
    // Only the banner's own buttons answer: a choice nobody made is not consent.
    "if(el&&el.contains(t)&&t.hasAttribute('data-fc-consent-accept')){ev.preventDefault();if(guarded(ev))return;answer(nameOf(t,'data-fc-consent-accept'),true);return;}" +
    "if(el&&el.contains(t)&&t.hasAttribute('data-fc-consent-decline')){ev.preventDefault();if(guarded(ev))return;answer(nameOf(t,'data-fc-consent-decline'),false);return;}" +
    "if(el&&el.contains(t)&&t.hasAttribute('data-fc-consent-close')){ev.preventDefault();if(!openShown())hide();return;}" +
    "var h=t.tagName==='A'?(t.getAttribute('href')||''):'';" +
    "if(h&&h.slice(-C.hash.length)===C.hash){ev.preventDefault();open();opener=t;return;}" +
    't=t.parentNode;}});' +
    "d.addEventListener('keydown',function(ev){if((ev.key==='Escape'||ev.key==='Esc')&&el&&!el.hidden&&!openShown()&&!pending()){hide();}});" +
    "if(state('analytics')==='granted')load();if(pending())show(false);" +
    "if(w.location&&w.location.hash===C.hash){mode='user';guard();show(true);}" +
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
    `#${CONSENT_BANNER_ID}[hidden],#${CONSENT_BANNER_ID} [hidden]{display:none!important}` +
    // A row's recorded answer, beside buttons of the same weight.
    `#${CONSENT_BANNER_ID} button[aria-pressed="true"]{box-shadow:inset 0 0 0 3px currentColor}` +
    `#${CONSENT_BANNER_ID} button:focus-visible,#${CONSENT_BANNER_ID} a:focus-visible{outline:2px solid currentColor;outline-offset:2px}` +
    `#${CONSENT_BANNER_ID}:focus{outline:none}` +
    `#${CONSENT_BANNER_ID}:focus-visible{outline:2px solid currentColor;outline-offset:2px}`
  );
}

/** On a site where nothing needs consent, a "Cookie settings" link would do nothing: hide it. */
export const HIDE_COOKIE_LINKS_CSS = `a[href$="${COOKIE_SETTINGS_HASH}"]{display:none!important}`;
