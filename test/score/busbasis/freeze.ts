// Step 2 of three: raw captures to frozen reference pages. Reads what capture.devbrowser.txt
// left in ~/.dev-browser/tmp and writes test/score/corpus/busbasis. Step 3 is rebuild.ts.
//
//   pnpm exec tsx test/score/busbasis/freeze.ts
//
// Personal data goes here, shape preserved so the layout does not move: every mail
// address, the street address and the names of the team, which are found by where they
// stand so this file never holds them. Images are placeholders from the capture.
//
// A frame's address cannot stay on the frozen page, which holds none, so it goes to
// `pages/<page>.frames.json` beside it: a Google map rebuilt by the product's own parser
// with its place masked, which the lift turns into the map component. A frozen page
// whose live page had no address list fails here, so a refresh cannot drop the map.
//
//   pnpm exec tsx test/score/busbasis/freeze.ts --frames-only home
//
// writes only that file, from a frames-only capture (capture-frames.devbrowser.txt).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseMapEmbed } from '@/lib/mapEmbed/mapEmbed';
import { BUSBASIS_PAGES } from './pages';

export const CORPUS_DIR = path.resolve(process.cwd(), 'test/score/corpus/busbasis');
export const SHARED_SHEET = 'busbasis.css';
export const SHEET_MARKER = '<style data-shared-sheet></style>';

interface RawWidth {
  width: number;
  height: number;
  scrollHeight: number;
  elements: number;
  html: string;
  firsts: Record<string, Record<string, string>>;
  rows: Record<string, unknown>;
}

interface RawCapture {
  slug: string;
  path: string;
  status: number;
  finalUrl: string;
  capturedAt: string;
  head: { title: string; htmlClass: string; htmlLang: string };
  sheets: { kind: string; href?: string; text: string }[];
  widths: Record<string, RawWidth>;
  /** The `src` of every iframe of the live page, in document order. */
  frames?: string[];
}

/** What capture-frames.devbrowser.txt writes. */
interface RawFrames {
  slug: string;
  path: string;
  status: number;
  capturedAt: string;
  frames: string[];
}

export const framesFile = (slug: string): string => path.join(CORPUS_DIR, 'pages', `${slug}.frames.json`);

/** Letters and digits become x and 0, so a line keeps its length. */
const mask = (text: string): string => text.replace(/\p{L}/gu, 'x').replace(/\d/g, '0');

function maskTeamNames(html: string): string {
  const start = html.indexOf('Unser Team');
  if (start < 0) return html;
  const end = html.indexOf('</section>', start);
  const block = html.slice(start, end);
  const names = [...block.matchAll(/<img alt="([^"]+)"/g)].map((m) => m[1]);
  let scrubbed = block;
  for (const name of new Set(names)) {
    scrubbed = scrubbed.replaceAll(`alt="${name}"`, `alt="${mask(name)}"`).replaceAll(`>${name}<`, `>${mask(name)}<`);
  }
  return html.slice(0, start) + scrubbed + html.slice(end);
}

function scrubText(html: string): string {
  return maskTeamNames(html)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (address) => (address === 'ihre.email@beispiel.de' ? address : mask(address)))
    .replace(/Hauptstra(?:ß|ss)e 51/g, mask)
    .replace(/16547(?:&nbsp;|\s)+Birkenwerder/g, mask)
    .replace(/[–—]/g, '-');
}

/** The storefront's keyframes under the `u-` names a global name needs, as an import would write them. */
function prefixKeyframes(css: string): string {
  const names = [...css.matchAll(/@keyframes\s+([-\w]+)/g)].map((m) => m[1]);
  let out = css.replace(/@keyframes\s+([-\w]+)/g, '@keyframes u-$1');
  for (const name of new Set(names)) {
    out = out.replace(/animation(-name)?:[^;}]*/g, (declaration) =>
      declaration.replace(new RegExp(`(^|[\\s:,])${name}(?=$|[\\s,;])`, 'g'), `$1u-${name}`),
    );
  }
  return out;
}

const PLACEHOLDER_URL = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='100%25' height='100%25' fill='hsl(0 0%25 30%25)'/%3E%3C/svg%3E")`;

function freezeCss(css: string): string {
  return prefixKeyframes(css)
    .replace(/url\((?!["']?data:)[^)]*\)/g, PLACEHOLDER_URL)
    .replace(/[–—]/g, '-');
}

/**
 * A Google map's `pb` with every text and coordinate masked and its structure kept. Each
 * part is `!<field><type><value>`: a `d` is a coordinate, an `s` a place name, a place id
 * or a language. The frozen page masks the street, and these name it and point at it.
 */
function maskMapPb(pb: string): string {
  return pb
    .split('!')
    .map((part) => {
      const match = /^(\d+)([a-z])(.*)$/.exec(part);
      if (!match) return part;
      const [, field, type, value] = match;
      if (type === 'd') return `${field}${type}${value.replace(/\d/g, '0')}`;
      if (type === 's') return `${field}${type}${encodeURIComponent(mask(decodeURIComponent(value)))}`;
      return part;
    })
    .join('!');
}

/** One frame's address as the lift may use it: a Google map the product rebuilt, masked, or null. */
function freezeFrame(slug: string, src: string): string | null {
  const parsed = parseMapEmbed(src);
  if (!parsed.ok) return null;
  const { map } = parsed;
  let masked: string;
  if (map.form === 'share') masked = map.src.replace(/pb=(.*)$/, (_, pb: string) => `pb=${maskMapPb(pb)}`);
  else if (map.form === 'query') masked = map.src.replace(/([?&]q=)([^&]*)/, (_, name: string, q: string) => `${name}${encodeURIComponent(mask(decodeURIComponent(q)))}`);
  // A Maps Embed API address carries the owner's key, which the corpus must not hold.
  else throw new Error(`${slug}: a Maps Embed API frame, whose key the corpus cannot hold; decide how to freeze it before refreshing`);
  const again = parseMapEmbed(masked);
  if (!again.ok || again.map.src !== masked || again.map.form !== map.form) throw new Error(`${slug}: the masked map address no longer parses as the same map`);
  return masked;
}

/**
 * The frame addresses of a frozen page, paired with its iframes by document order. A
 * page with frames and no address list, or a list of another length, is a capture that
 * does not belong to this page: it fails rather than lift a map as a bare iframe.
 */
function freezeFrames(slug: string, html: string, frames: string[] | undefined, source: { capturedAt: string }): void {
  const count = (html.match(/<iframe\b/g) ?? []).length;
  const file = framesFile(slug);
  if (count === 0) {
    if (frames && frames.length > 0) throw new Error(`${slug}: ${frames.length} frame addresses for a page with no iframe`);
    fs.rmSync(file, { force: true });
    return;
  }
  if (!frames) throw new Error(`${slug}: the page has ${count} iframes and the capture recorded no addresses; capture it again`);
  if (frames.length !== count) throw new Error(`${slug}: ${frames.length} frame addresses for ${count} iframes`);
  const out = {
    _doc: 'Held out: see README.md. The address of each iframe of the frozen page, in document order: a Google map rebuilt by parseMapEmbed with its place masked, or null for a frame the product cannot draw.',
    capturedAt: source.capturedAt,
    frames: frames.map((src) => freezeFrame(slug, src)),
  };
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

/** Only the frame addresses, for pages frozen before the capture recorded them. */
function freezeFramesOnly(slugs: string[]): void {
  if (slugs.length === 0) throw new Error('name the pages: freeze.ts --frames-only home');
  for (const slug of slugs) {
    const page = BUSBASIS_PAGES.find((p) => p.slug === slug);
    if (!page) throw new Error(`${slug} is not in pages.ts`);
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dev-browser/tmp', `bb-${slug}-frames.json`), 'utf8')) as RawFrames;
    if (raw.slug !== slug || raw.path !== page.path) throw new Error(`${slug}: captured ${raw.path}, listed ${page.path}`);
    if (raw.status !== 200) throw new Error(`${slug}: the live page answered ${raw.status}`);
    freezeFrames(slug, fs.readFileSync(path.join(CORPUS_DIR, 'pages', `${slug}.html`), 'utf8'), raw.frames, raw);
    console.log(`froze the frame addresses of ${slug}`);
  }
}

const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');

export function main(): void {
  fs.mkdirSync(path.join(CORPUS_DIR, 'pages'), { recursive: true });
  const pages: Record<string, unknown>[] = [];
  let shared: string | undefined;

  for (const page of BUSBASIS_PAGES) {
    const file = path.join(os.homedir(), '.dev-browser/tmp', `bb-${page.slug}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawCapture;
    if (raw.path !== page.path) throw new Error(`${page.slug}: captured ${raw.path}, listed ${page.path}`);

    const link = raw.sheets.find((s) => s.kind === 'link');
    if (!link) throw new Error(`${page.slug}: no stylesheet`);
    if (shared !== undefined && shared !== link.text) throw new Error(`${page.slug}: a second main stylesheet`);
    shared = link.text;

    const extra = raw.sheets.filter((s) => s !== link).map((s) => `<style>${freezeCss(s.text)}</style>`).join('');
    // Line endings too: git normalises them, which would break the hash, and HTML parsing already does.
    const body = scrubText(raw.widths.desktop.html).replace(/\r\n?/g, '\n');
    const html = `<!doctype html>\n<html lang="${raw.head.htmlLang}" class="${raw.head.htmlClass}"><head><meta charset="utf-8"><title>${scrubText(raw.head.title)}</title>${SHEET_MARKER}${extra}</head>${body}</html>\n`;
    if (/<script|https?:\/\/(?!www\.w3\.org)/.test(html.replace(/xmlns(?::\w+)?="[^"]*"/g, ''))) {
      throw new Error(`${page.slug}: a script or an address survived the freeze`);
    }
    fs.writeFileSync(path.join(CORPUS_DIR, 'pages', `${page.slug}.html`), html);
    freezeFrames(page.slug, html, raw.frames, raw);

    const computed = Object.fromEntries(
      Object.entries(raw.widths).map(([id, w]) => [id, { width: w.width, height: w.height, scrollHeight: w.scrollHeight, firsts: w.firsts, rows: w.rows }]),
    );
    fs.writeFileSync(path.join(CORPUS_DIR, 'pages', `${page.slug}.computed.json.gz`), zlib.gzipSync(JSON.stringify(computed), { level: 9 }));
    pages.push({ slug: page.slug, pageType: page.pageType, source: `https://basiscampberlin.de${page.path}`, status: raw.status, capturedAt: raw.capturedAt, elements: raw.widths.desktop.elements });
  }

  fs.writeFileSync(path.join(CORPUS_DIR, SHARED_SHEET), freezeCss(shared as string));
  fs.writeFileSync(path.join(CORPUS_DIR, 'captures.json'), `${JSON.stringify({ sheetSha256OfCapture: sha256(shared as string), pages }, null, 2)}\n`);
  console.log(`froze ${pages.length} pages into ${CORPUS_DIR}`);
}

if (process.argv[1]?.endsWith('freeze.ts')) {
  const at = process.argv.indexOf('--frames-only');
  if (at >= 0) freezeFramesOnly(process.argv.slice(at + 1));
  else main();
}
