// Step 2 of three: raw captures to frozen reference pages. Reads what capture.devbrowser.txt
// left in ~/.dev-browser/tmp and writes test/score/corpus/busbasis. Step 3 is rebuild.ts.
//
//   pnpm exec tsx test/score/busbasis/freeze.ts
//
// Personal data goes here, shape preserved so the layout does not move: every mail
// address, the street address and the names of the team, which are found by where they
// stand so this file never holds them. Images are placeholders from the capture.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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
}

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
    const body = scrubText(raw.widths.desktop.html);
    const html = `<!doctype html>\n<html lang="${raw.head.htmlLang}" class="${raw.head.htmlClass}"><head><meta charset="utf-8"><title>${scrubText(raw.head.title)}</title>${SHEET_MARKER}${extra}</head>${body}</html>\n`;
    if (/<script|https?:\/\/(?!www\.w3\.org)/.test(html.replace(/xmlns(?::\w+)?="[^"]*"/g, ''))) {
      throw new Error(`${page.slug}: a script or an address survived the freeze`);
    }
    fs.writeFileSync(path.join(CORPUS_DIR, 'pages', `${page.slug}.html`), html);

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

if (process.argv[1]?.endsWith('freeze.ts')) main();
