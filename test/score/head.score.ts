// The head item rows (docs/plans/2026-11-02-theme-and-head.md, Score changes): 17 meta names,
// 8 properties, 7 link rels and JSON-LD, each measured in three columns with the real code.
//
//   format    the item stored in the site's list and in a page's own metadata survives JSON and
//             the readers again, whole, and parseHeadItem reads it back as itself.
//   renderer  the real emission (resolveHead, then HeadItemTags in a whole document): a meta or
//             link tag stands in the raw <head>, JSON-LD in the body and parses back, whichever
//             of the two homes holds the item. A raw position, not just "the tag exists".
//   ai        a generation has no field for a head item, so anything it carries beyond its nodes
//             is dropped. The cell fails on purpose (ai-head-refused) and passes only if the
//             generator ever starts keeping one, which the floor then reports.
//
// The panel is slice H3 and the canvas has no counterpart: report.ts fails both under the head
// gap. The raw head of a real build, the eight user agents and three browsers are
// test/behaviour/headItems.spec.ts and test/renderGate/headItems.gate.tsx.

import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel from '@/models/ProjectModel';
import { HeadItemTags } from '@/components/site/HeadItemTags';
import { parseHeadItem, resolveHead, type StoredHeadItem } from '@/lib/site/headItems';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import pageItems from './data/page-items.json';
import { headSample } from './lib/headRows';
import { writeOut } from './lib/io';
import { pageItemEntries } from './lib/universe';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';

const pass = (note?: string): Cell => ({ status: 'pass', ...(note ? { note } : {}) });
const fail = (gap: 'head-items' | 'ai-head-refused', note: string): Cell => ({ status: 'fail', gap, note });
const key = (id: string) => rowKey('page-item', `head:${id}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const AI_CONTEXT = { breakpoints: deriveBreakpointKeys([{ label: 'Desktop', minWidth: 1280 }, { label: 'Mobile', minWidth: 320 }]) };

/** The item stored in a site's settings and in a page, through JSON and the readers once more. */
function formatCell(item: StoredHeadItem): Cell {
  const siteRound = normalizeSiteSettings(JSON.parse(JSON.stringify(normalizeSiteSettings({ head: [item] }))));
  if (!same(siteRound.head, [item])) return fail('head-items', `the site's list changed it: ${JSON.stringify(siteRound.head)}`);

  const project = ProjectModel.create({ id: 'head-row', metadata: { title: 'Head' }, pages: {} });
  const page = project.createPage('Home');
  page.updateMetadata({ head: [item] });
  const reread = ProjectModel.create(JSON.parse(JSON.stringify(getSnapshot(project))));
  const stored = [...reread.pages.values()][0]?.metadata.head;
  if (!same(stored, [item])) return fail('head-items', `the page's metadata changed it: ${JSON.stringify(stored)}`);

  const parsed = parseHeadItem(item);
  if (!parsed.ok) return fail('head-items', `parseHeadItem refuses it: ${parsed.refusal.message}`);
  if (!same(parsed.item, item)) return fail('head-items', 'parseHeadItem reads it as something else');
  return pass();
}

/** The whole document the real route would send for these stored lists. */
function documentFor(site: unknown, page: unknown): string {
  const { items, problems } = resolveHead(site, page);
  if (problems.length > 0) throw new Error(problems.map((p) => p.message).join('; '));
  return renderToString(
    React.createElement(
      'html',
      null,
      React.createElement('head', null, React.createElement('meta', { charSet: 'utf-8' })),
      React.createElement('body', null, React.createElement(HeadItemTags, { items }), React.createElement('p', null, 'page')),
    ),
  );
}

/** The attributes of one raw tag, names lowercased and values unescaped. */
function attributesOf(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
    attrs[m[1].toLowerCase()] = m[2].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return attrs;
}

/** Where the item stands in the raw HTML: its tag before `</head>`, or JSON-LD after it, parsing back. */
function positionProblem(item: StoredHeadItem, html: string): string | null {
  const at = html.indexOf('</head>');
  if (at < 0) return 'no head in the document';
  const head = html.slice(0, at);
  const body = html.slice(at);
  if (item.kind === 'jsonld') {
    const found = [...body.matchAll(/<script type="application\/ld\+json" data-head-jsonld="">([\s\S]*?)<\/script>/g)];
    if (found.length !== 1) return `${found.length} JSON-LD blocks in the body`;
    return same(JSON.parse(found[0][1]), item.data) ? null : 'the JSON-LD does not parse back to the stored object';
  }
  const tag = item.kind === 'link' ? 'link' : 'meta';
  const identity = item.kind === 'meta' ? ['name', item.name] : item.kind === 'property' ? ['property', item.property] : ['rel', item.rel];
  const tagsOf = (html: string) =>
    [...html.matchAll(/<(meta|link)\b[^>]*>/g)]
      .filter((m) => m[1] === tag)
      .map((m) => attributesOf(m[0]))
      .filter((attrs) => attrs[identity[0] as string] === identity[1]);
  const inHead = tagsOf(head);
  if (inHead.length !== 1) return `${inHead.length} such tags in <head>`;
  if (tagsOf(body).length > 0) return 'the tag is also in the body';
  const { kind: _kind, ...expected } = item;
  for (const [field, value] of Object.entries(expected)) {
    const written = inHead[0][field.toLowerCase()];
    if (written !== value) return `${field} is written as ${JSON.stringify(written)}, stored as ${JSON.stringify(value)}`;
  }
  return null;
}

function rendererCell(item: StoredHeadItem): Cell {
  for (const [home, html] of [
    ['site', documentFor([item], [])],
    ['page', documentFor([], [item])],
  ] as const) {
    const problem = positionProblem(item, html);
    if (problem) return fail('head-items', `from the ${home}'s list: ${problem}`);
  }
  return pass();
}

/** Whether the generation still carries the whole item in a head field (head, metadata.head or siteSettings.head). */
function keptIn(item: StoredHeadItem, result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const r = result as { head?: unknown; metadata?: { head?: unknown }; siteSettings?: { head?: unknown } };
  return [r.head, r.metadata?.head, r.siteSettings?.head].some((list) => Array.isArray(list) && list.some((entry) => same(entry, item)));
}

/** A generation carrying the item at every place a model might put it. */
function aiCell(item: StoredHeadItem): Cell {
  const outcome = validateGeneration(
    {
      nodes: [{ type: 'div', props: { id: 'head-row' }, children: [{ type: 'h1', props: { children: 'Hello' } }] }],
      head: [item],
      metadata: { head: [item] },
      siteSettings: { head: [item] },
    },
    AI_CONTEXT,
  );
  if (!outcome.ok) return fail('ai-head-refused', `the generation was refused: ${outcome.errors.join('; ')}`);
  const kept = keptIn(item, outcome.result);
  return kept ? pass('the generator kept it') : fail('ai-head-refused', 'a generation has no head field: the item is dropped from the output');
}

describe('head item rows', () => {
  it('measures the format, the published page and the generator of every row, and names nothing that is not a row', () => {
    const format: SurfaceResults = {};
    const renderer: SurfaceResults = {};
    const ai: SurfaceResults = {};
    for (const id of pageItems.head) {
      const item = headSample(id);
      format[key(id)] = formatCell(item);
      renderer[key(id)] = rendererCell(item);
      ai[key(id)] = aiCell(item);
    }
    const rows = new Set(pageItemEntries().map((e) => rowKey(e.kind, e.id)));
    for (const name of [...Object.keys(format), ...Object.keys(renderer), ...Object.keys(ai)]) expect(rows.has(name), name).toBe(true);
    writeOut('page-items-head', { format, renderer, ai });
  });

  it('the cells can fail', () => {
    // A refused item has no tag; the same item from a tampered position is caught.
    const meta = headSample('meta:author');
    expect(positionProblem(meta, documentFor([], []))).toBe('0 such tags in <head>');
    expect(positionProblem(meta, `<html><head></head><body><meta name="author" content="x"/></body></html>`)).toBe('0 such tags in <head>');
    const ld = headSample('jsonld');
    expect(positionProblem(ld, documentFor([], [])) ).toMatch(/0 JSON-LD blocks/);
    expect(() => documentFor([], [{ kind: 'meta', name: 'viewport', content: 'x' }])).toThrow(/viewport/);
    // A format cell notices an item the reader changes.
    expect(formatCell({ kind: 'meta', name: 'author', content: 'x', extra: 1 }).status).toBe('fail');
    // The generator cell passes the day a generation keeps a head item.
    expect(keptIn(meta, { head: [meta] })).toBe(true);
    expect(keptIn(ld, { metadata: { head: [ld] } })).toBe(true);
    // A value copied into a prop, or a head entry that changed, is not a retained head item.
    expect(keptIn(meta, { nodes: [{ props: { 'data-x': 'value of author' } }] })).toBe(false);
    expect(keptIn(meta, { head: [{ ...meta, content: 'other' }] })).toBe(false);
    expect(keptIn(meta, { nodes: [] })).toBe(false);
    // A renderer cell notices a wrong value or destination, not just a missing tag.
    expect(positionProblem(meta, `<html><head><meta name="author" content="wrong"/></head><body></body></html>`)).toMatch(/content is written as/);
    expect(aiCell(meta).status).toBe('fail');
  });
});
