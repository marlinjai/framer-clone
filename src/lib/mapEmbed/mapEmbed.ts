// src/lib/mapEmbed/mapEmbed.ts
//
// The Google Maps embed (decided by Marlin on 2026-11-02: a real use case, the
// site owner names it in the privacy policy). A dedicated primitive and not a
// stored `iframe`: the render gate keeps refusing every iframe a node stores
// (src/lib/renderer/blockedNodes.ts), and this one is drawn by the renderers from
// an address they rebuild themselves.
//
// The node is a div marked `data-map-embed="google"` (the box, sized and styled
// through the normal sections) whose map is described by props:
//
//   - mapUrl      a Google Maps embed address, or the `<iframe>` snippet Google's
//                 "Share, Embed a map" dialog gives, from which only `src` is read;
//   - mapAddress  the address text the placeholder shows, and the query of the
//                 keyless map and the "Open in Google Maps" link when no URL is set;
//   - mapTitle    the frame's accessible name ("Map: <address>" when empty).
//
// Every address is parsed and rebuilt from its parts, never passed through: the
// host is exactly www.google.com, the path one of the documented embed forms, and
// only the parameters each form documents survive, each checked. The forms:
//
//   - `/maps/embed?pb=...`, what the Share dialog gives, needs no key;
//   - `/maps/embed/v1/<place|view|directions|streetview|search>?key=...`, the Maps
//     Embed API (developers.google.com/maps/documentation/embed/embedding-map);
//   - `/maps?q=...&output=embed`, the keyless query form (also accepted from
//     maps.google.com and rebuilt on www.google.com). Google does not document it
//     any more, but it is what an address alone can become, so the generator and
//     an owner who only types an address get a map.
//
// Under German law (section 25 TDDDG, Art. 6 (1) (a) GDPR) a privacy policy line is
// not enough to contact Google before consent, so no surface loads the map on its
// own: the published page shows a placeholder until the visitor accepts the "maps"
// consent category (src/lib/consent/consent.ts), and the editor surfaces never load
// it (they run on the signed-in editor's origin).
//
// PURE: no React, no DOM. Shared by the registry, the renderers, the published
// island, the panel, the generator's validator, the legal templates and the tests.

import { legalLanguage, type LegalLanguage } from '@/lib/legal/legalPages';

/** The marker prop (and DOM attribute) of the map embed box. */
export const MAP_EMBED_ATTR = 'data-map-embed';
export const MAP_EMBED_MARKER = 'google';

/**
 * The props that describe the map (never DOM attributes). `mapLanguage` is not
 * stored: the published renderer writes the site language there before rendering.
 */
export const MAP_EMBED_PROP_KEYS = ['mapUrl', 'mapAddress', 'mapTitle', 'mapLanguage'] as const;
export type MapEmbedPropKey = (typeof MAP_EMBED_PROP_KEYS)[number];

/** The host every rebuilt frame address points at. */
export const GOOGLE_MAPS_HOST = 'www.google.com';
export const GOOGLE_MAPS_ORIGIN = `https://${GOOGLE_MAPS_HOST}`;

/** The canvas label (the map never loads in the editor). */
export const MAP_EMBED_CANVAS_LABEL = 'Google Maps: loads on the published site after the visitor consents';

/** The longest input read, so a pasted page cannot cost a parse. */
const MAX_INPUT = 4000;
const MAX_TEXT = 200;
const MAX_QUERY = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** True when the props mark a map embed box. */
export function isMapEmbed(props: unknown): boolean {
  return isRecord(props) && props[MAP_EMBED_ATTR] === MAP_EMBED_MARKER;
}

// ---------------------------------------------------------------- parsing

/** A parsed, rebuilt map: the frame address and what "Open in Google Maps" searches for. */
export interface ParsedMapEmbed {
  /** The rebuilt frame address, always on https://www.google.com. */
  src: string;
  /** Which documented form it is. */
  form: 'share' | 'embed-api' | 'query';
  /** A place, address or coordinates for the open link, when the address says one. */
  query: string | null;
}

export type MapEmbedParse = { ok: true; map: ParsedMapEmbed } | { ok: false; error: string };

const fail = (error: string): MapEmbedParse => ({ ok: false, error });

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#38': '&', '#038': '&', '#x26': '&', '#34': '"', '#39': "'" };

/** `src` of the first iframe in a pasted snippet, with the entities the Share dialog writes decoded. */
function srcOfSnippet(snippet: string): string | null {
  const match = /<iframe\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(snippet);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? match[3] ?? '';
  return raw.replace(/&(#x26|#0?38|#3[49]|amp|quot|apos|lt|gt);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all);
}

/** A raw query string as name and raw (still encoded) value pairs; the first of a name wins. */
function rawParams(search: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : part.slice(eq + 1);
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

function decoded(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** Free text a visitor would read or Google would search for: printable, bounded. */
function cleanQuery(value: string | null): string | null {
  if (value === null) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_QUERY || /[\u0000-\u001f\u007f<>]/.test(text)) return null;
  return text;
}

// `pb` is Google's own encoding of the whole map. Its raw form only ever holds these
// characters (a name inside it is percent-encoded), so it is kept exactly as written.
const PB = /^(?:[A-Za-z0-9!._~*:+-]|%[0-9A-Fa-f]{2}){1,3000}$/;
const API_KEY = /^[A-Za-z0-9_-]{20,80}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/;
const REGION = /^[A-Za-z]{2}$/;
const NUMBER = /^-?\d{1,3}(?:\.\d{1,12})?$/;
const LAT_LNG = /^(-?\d{1,2}(?:\.\d{1,12})?),\s*(-?\d{1,3}(?:\.\d{1,12})?)$/;
const PANO = /^[A-Za-z0-9_-]{1,100}$/;

function latLng(value: string | null): string | null {
  const match = value === null ? null : LAT_LNG.exec(value.trim());
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? `${match[1]},${match[2]}` : null;
}

function intIn(value: string | null, min: number, max: number): string | null {
  if (value === null || !/^\d{1,2}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? String(n) : null;
}

function numberIn(value: string | null, min: number, max: number): string | null {
  if (value === null || !NUMBER.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? value : null;
}

const oneOf = (value: string | null, allowed: readonly string[]): string | null =>
  value !== null && allowed.includes(value) ? value : null;

/** How each Maps Embed API mode reads one parameter; null drops it. */
type ParamRule = (value: string | null) => string | null;

const COMMON: Record<string, ParamRule> = {
  center: latLng,
  zoom: (v) => intIn(v, 0, 21),
  maptype: (v) => oneOf(v, ['roadmap', 'satellite']),
  language: (v) => (v !== null && LANGUAGE.test(v) ? v : null),
  region: (v) => (v !== null && REGION.test(v) ? v : null),
};

const MODES: Record<string, { params: Record<string, ParamRule>; required: string[][] }> = {
  place: { params: { q: cleanQuery, ...COMMON }, required: [['q']] },
  search: { params: { q: cleanQuery, ...COMMON }, required: [['q']] },
  view: { params: { ...COMMON }, required: [['center']] },
  directions: {
    params: {
      origin: cleanQuery,
      destination: cleanQuery,
      waypoints: cleanQuery,
      mode: (v) => oneOf(v, ['driving', 'walking', 'bicycling', 'transit', 'flying']),
      avoid: (v) => (v !== null && /^(?:tolls|ferries|highways)(?:\|(?:tolls|ferries|highways)){0,2}$/.test(v) ? v : null),
      units: (v) => oneOf(v, ['metric', 'imperial']),
      ...COMMON,
    },
    required: [['origin', 'destination']],
  },
  streetview: {
    params: {
      location: latLng,
      pano: (v) => (v !== null && PANO.test(v) ? v : null),
      heading: (v) => numberIn(v, -180, 360),
      pitch: (v) => numberIn(v, -90, 90),
      fov: (v) => numberIn(v, 10, 100),
      center: latLng,
      zoom: COMMON.zoom,
      maptype: COMMON.maptype,
      language: COMMON.language,
      region: COMMON.region,
    },
    required: [['location'], ['pano']],
  },
};

const ORDER = (rule: Record<string, ParamRule>) => Object.keys(rule);

function query(pairs: [string, string][]): string {
  return pairs.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
}

/** The coordinates a `pb` holds (`!2d<lng>!3d<lat>`), as "lat,lng". */
function pbCoordinates(pb: string): string | null {
  const match = /!2d(-?\d{1,3}(?:\.\d+)?)!3d(-?\d{1,2}(?:\.\d+)?)/.exec(pb);
  return match ? latLng(`${match[2]},${match[1]}`) : null;
}

/**
 * Parse what an owner pasted: a Google Maps embed address or Google's `<iframe>`
 * snippet. The result is rebuilt from checked parts, so nothing of the input
 * reaches a page as written. An unknown parameter is dropped, a wrong host, path
 * or a missing required parameter refuses the whole address.
 */
export function parseMapEmbed(input: unknown): MapEmbedParse {
  if (typeof input !== 'string' || input.trim() === '') return fail('Paste a Google Maps embed address or the embed code.');
  if (input.length > MAX_INPUT) return fail('That is too long for a map address.');
  let text = input.trim();
  if (text.startsWith('<')) {
    const src = srcOfSnippet(text);
    if (src === null) return fail('That code holds no map: paste the embed code from Google Maps, Share, Embed a map.');
    text = src.trim();
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('That is not an address: it should start with https://www.google.com/maps/embed');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return fail('Only https://www.google.com/maps addresses can be embedded.');
  }
  const host = url.hostname.toLowerCase();
  const params = rawParams(url.search);
  const path = url.pathname.replace(/\/+$/, '');

  if (host === GOOGLE_MAPS_HOST && path === '/maps/embed') {
    const pb = params.get('pb');
    if (!pb || !PB.test(pb)) return fail('This embed address has no map in it (its pb part is missing or damaged). Copy it again from Google Maps.');
    return { ok: true, map: { src: `${GOOGLE_MAPS_ORIGIN}/maps/embed?pb=${pb}`, form: 'share', query: pbCoordinates(pb) } };
  }

  const api = /^\/maps\/embed\/v1\/([a-z]+)$/.exec(path);
  if (host === GOOGLE_MAPS_HOST && api) {
    const mode = MODES[api[1]];
    if (!mode) return fail(`Google Maps has no "${api[1]}" embed. Use place, view, directions, streetview or search.`);
    const key = params.get('key');
    if (!key || !API_KEY.test(key)) return fail('A Maps Embed API address needs its key parameter.');
    const kept: [string, string][] = [['key', key]];
    const values: Record<string, string> = {};
    for (const name of ORDER(mode.params)) {
      const value = mode.params[name](decoded(params.get(name)));
      if (value !== null) {
        values[name] = value;
        kept.push([name, value]);
      }
    }
    if (!mode.required.some((all) => all.every((name) => name in values))) {
      return fail(`This ${api[1]} map is missing ${mode.required.map((all) => all.join(' and ')).join(' or ')}.`);
    }
    const openQuery = values.q ?? values.destination ?? values.center ?? values.location ?? null;
    return { ok: true, map: { src: `${GOOGLE_MAPS_ORIGIN}/maps/embed/v1/${api[1]}?${query(kept)}`, form: 'embed-api', query: openQuery } };
  }

  if ((host === GOOGLE_MAPS_HOST || host === 'maps.google.com') && path === '/maps' && params.get('output') === 'embed') {
    const q = cleanQuery(decoded(params.get('q')));
    if (q === null) return fail('This map address has no place in it (its q part is missing).');
    const kept: [string, string][] = [['q', q]];
    const z = intIn(decoded(params.get('z')), 1, 21);
    if (z !== null) kept.push(['z', z]);
    const t = oneOf(decoded(params.get('t')), ['m', 'k', 'h', 'p']);
    if (t !== null) kept.push(['t', t]);
    const hl = decoded(params.get('hl'));
    if (hl !== null && LANGUAGE.test(hl)) kept.push(['hl', hl]);
    return { ok: true, map: { src: `${GOOGLE_MAPS_ORIGIN}/maps?${query(kept)}&output=embed`, form: 'query', query: q } };
  }

  if (host !== GOOGLE_MAPS_HOST && host !== 'maps.google.com') {
    return fail('Only Google Maps can be embedded: the address must be on https://www.google.com/maps/embed');
  }
  return fail('That is a Google Maps page, not an embed. In Google Maps choose Share, Embed a map, and paste that code.');
}

/** The keyless map of an address alone. */
export function addressMapSrc(address: string): string | null {
  const q = cleanQuery(address);
  return q === null ? null : `${GOOGLE_MAPS_ORIGIN}/maps?${query([['q', q]])}&output=embed`;
}

/** Google's documented search link (Maps URLs, api=1): works without consent, it is a plain link. */
export function openInMapsHref(searchFor: string | null): string | null {
  const q = cleanQuery(searchFor);
  return q === null ? null : `${GOOGLE_MAPS_ORIGIN}/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/**
 * Whether a frame address is one this module builds. The published island checks
 * the address again right before it creates the frame: nothing else may ever
 * become an iframe's `src`.
 */
export function isRebuiltMapSrc(src: unknown): src is string {
  if (typeof src !== 'string' || !src.startsWith(`${GOOGLE_MAPS_ORIGIN}/maps`)) return false;
  const parsed = parseMapEmbed(src);
  return parsed.ok && parsed.map.src === src;
}

// ---------------------------------------------------------------- props

/** Printable text for the placeholder and the frame title. */
export function cleanMapText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= MAX_TEXT && !/[\u0000-\u001f\u007f<>]/.test(text) ? text : undefined;
}

export interface MapEmbedCopy {
  load: string;
  open: string;
  note: string;
  /** The frame's name when the owner set none. */
  title: (address: string) => string;
  /** The placeholder region's name. */
  region: string;
  /** Shown when the box has no usable map. */
  empty: string;
  privacyLink: string;
}

const COPY: Record<LegalLanguage, MapEmbedCopy> = {
  de: {
    load: 'Karte laden',
    open: 'In Google Maps öffnen',
    note: 'Beim Laden der Karte erhält Google (Google Ireland Limited) Daten wie Ihre IP-Adresse. „Karte laden“ fragt Sie zuerst nach Ihrer Einwilligung; widerrufen können Sie unter „Cookie-Einstellungen“ im Seitenfuß.',
    title: (address) => (address ? `Karte: ${address}` : 'Karte'),
    region: 'Karte von Google Maps',
    empty: 'Hier ist noch keine Karte hinterlegt.',
    privacyLink: 'Datenschutzerklärung',
  },
  en: {
    load: 'Load map',
    open: 'Open in Google Maps',
    note: 'Loading the map sends data such as your IP address to Google (Google Ireland Limited). "Load map" asks for your consent first; you can withdraw it under "Cookie settings" in the footer.',
    title: (address) => (address ? `Map: ${address}` : 'Map'),
    region: 'Map from Google Maps',
    empty: 'No map has been set here yet.',
    privacyLink: 'Privacy policy',
  },
};

/** The placeholder copy for a BCP 47 tag: German for `de*`, English otherwise. */
export function mapEmbedCopy(language: string): MapEmbedCopy {
  return COPY[legalLanguage(language)];
}

/** What a map box shows: everything read again from the props on every render. */
export interface MapEmbedView {
  /** The rebuilt frame address, or null when neither the URL nor the address is usable. */
  src: string | null;
  /** The address text, possibly empty. */
  address: string;
  /** The frame's accessible name. */
  title: string;
  /** "Open in Google Maps", or null when nothing names a place. */
  openHref: string | null;
  /** Why a set URL was not used, for the canvas and the panel. */
  urlError: string | null;
  copy: MapEmbedCopy;
}

/**
 * The map a box shows. A set URL that does not parse is never used (its error is
 * reported), and the address alone then still gives a map. This runs at render
 * time on every surface: the panel refusing a value is a convenience, this is the gate.
 */
export function readMapEmbed(props: unknown): MapEmbedView {
  const p = isRecord(props) ? props : {};
  const copy = mapEmbedCopy(typeof p.mapLanguage === 'string' ? p.mapLanguage : 'en');
  const address = cleanMapText(p.mapAddress) ?? '';
  const hasUrl = typeof p.mapUrl === 'string' && p.mapUrl.trim() !== '';
  const parsed = hasUrl ? parseMapEmbed(p.mapUrl) : null;
  const map = parsed?.ok ? parsed.map : null;
  const src = map?.src ?? (address ? addressMapSrc(address) : null);
  return {
    src,
    address,
    title: cleanMapText(p.mapTitle) ?? copy.title(address),
    openHref: openInMapsHref(address || map?.query || null),
    urlError: parsed && !parsed.ok ? parsed.error : null,
    copy,
  };
}

/** The box's DOM props: the map description removed (it is drawn by the renderer). */
export function stripMapEmbedProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  for (const key of MAP_EMBED_PROP_KEYS) delete out[key];
  delete out.children;
  return out;
}

/** The generator's and the panel's check for one map prop value. */
export function cleanMapEmbedProp(key: MapEmbedPropKey, value: unknown): string | undefined {
  if (key === 'mapUrl') {
    const parsed = parseMapEmbed(value);
    return parsed.ok ? parsed.map.src : undefined;
  }
  if (key === 'mapLanguage') return undefined;
  return cleanMapText(value);
}

// ---------------------------------------------------------------- trees

interface TreeNode {
  props?: Record<string, unknown> | null;
  children?: TreeNode[] | null;
}

/** Whether any of these trees holds a map embed (bounded walk). */
export function treesHoldMapEmbed(roots: Iterable<TreeNode | null | undefined>): boolean {
  let seen = 0;
  for (const root of roots) {
    const stack: TreeNode[] = root ? [root] : [];
    while (stack.length > 0 && seen < 20000) {
      const node = stack.pop()!;
      seen++;
      if (isMapEmbed(node.props)) return true;
      if (Array.isArray(node.children)) stack.push(...node.children);
    }
  }
  return false;
}

/**
 * The tree with the site language on every map box, and whether it has one. A new
 * tree where something changes; the input is not mutated.
 */
export function withMapLanguage<N extends TreeNode>(root: N, language: string): { root: N; hasMap: boolean } {
  let hasMap = false;
  const walk = (node: N): N => {
    const children = Array.isArray(node.children) ? (node.children as N[]) : null;
    const nextChildren = children ? children.map(walk) : null;
    const changedChildren = !!children && nextChildren!.some((child, i) => child !== children[i]);
    if (isMapEmbed(node.props)) {
      hasMap = true;
      return { ...node, props: { ...node.props, mapLanguage: language }, ...(changedChildren ? { children: nextChildren } : {}) };
    }
    return changedChildren ? { ...node, children: nextChildren } : node;
  };
  return { root: walk(root), hasMap };
}
