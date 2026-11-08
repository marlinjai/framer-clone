// The generator: no row is dropped (total in equals total out, per kind and overall), our columns
// are read from the right cells, an unknown kind or a malformed row fails loudly, and the output
// is deterministic.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROW_KINDS, SURFACES } from '../types';
import { FRAMER_VERDICTS } from './mapping';
import { buildFramerScore, renderFramerReport, type PublishedScore } from './report';

const published = JSON.parse(fs.readFileSync(path.resolve('docs/primitives-score/latest.json'), 'utf8')) as PublishedScore;

const cells = (overrides: Partial<Record<(typeof SURFACES)[number], string>>) => SURFACES.map((s) => overrides[s] ?? 'pass').join(' ');
const tiny = (rows: Record<string, string>): PublishedScore => ({ generatedAt: '2026-11-02T00:00:00.000Z', matrix: { included: Object.keys(rows).length, rows } });

describe('buildFramerScore', () => {
  const score = buildFramerScore(published);

  it('carries every published row, once', () => {
    expect(score.rows.length).toBe(published.matrix.included);
    expect(new Set(score.rows.map((r) => r.key))).toEqual(new Set(Object.keys(published.matrix.rows)));
    expect(score.totals.rows).toBe(published.matrix.included);
  });

  it('adds up per kind and per verdict to the rows in', () => {
    expect(score.byKind.map((k) => k.kind)).toEqual([...ROW_KINDS]);
    for (const k of score.byKind) {
      expect(FRAMER_VERDICTS.reduce((sum, v) => sum + k.framer[v], 0), k.kind).toBe(k.total);
      expect(k.framerTyped).toBe(k.framer.native + k.framer.partial);
    }
    expect(score.byKind.reduce((sum, k) => sum + k.total, 0)).toBe(published.matrix.included);
    expect(FRAMER_VERDICTS.reduce((sum, v) => sum + score.totals.framer[v], 0)).toBe(published.matrix.included);
  });

  it('reads our renderer and panel columns from the same cells latest.md counts', () => {
    const pass = (surface: (typeof SURFACES)[number]) =>
      Object.values(published.matrix.rows).filter((c) => c.split(' ')[SURFACES.indexOf(surface)] === 'pass').length;
    expect(score.totals.ourRenderer).toBe(pass('renderer'));
    expect(score.totals.ourPanel).toBe(pass('panel'));
  });

  it('reads the renderer and panel cells by surface, not by position guesswork', () => {
    const s = buildFramerScore(tiny({ 'css-property:opacity': cells({ renderer: 'renderer-drops-value', panel: 'pass' }) }));
    expect(s.rows[0]).toMatchObject({ verdict: 'native', ourRenderer: false, ourPanel: true });
    expect(s.byKind.find((k) => k.kind === 'css-property')?.framerTypedOursFails).toBe(1);
  });

  it('fails loudly on a row of an unknown kind', () => {
    expect(() => buildFramerScore(tiny({ 'css-thing:x': cells({}) }))).toThrow(/unknown row kind/);
  });

  it('fails loudly when the row count disagrees with included', () => {
    expect(() => buildFramerScore({ ...tiny({ 'css-property:opacity': cells({}) }), matrix: { included: 2, rows: { 'css-property:opacity': cells({}) } } })).toThrow(
      /says 2 are included/,
    );
  });

  it('fails loudly on a row with the wrong number of cells', () => {
    expect(() => buildFramerScore(tiny({ 'css-property:opacity': 'pass pass' }))).toThrow(/expected 5/);
  });
});

describe('renderFramerReport', () => {
  const score = buildFramerScore(published);
  const md = renderFramerReport(score);

  it('is deterministic', () => {
    expect(renderFramerReport(buildFramerScore(published))).toBe(md);
    expect(JSON.stringify(buildFramerScore(published))).toBe(JSON.stringify(score));
  });

  it('says what it measures and what it does not, and records the measured hover fact', () => {
    expect(md).toContain('not a render test of Framer\'s published pages');
    expect(md).toContain('rebuilds the corpus fixtures in Framer');
    expect(md).toContain('There is no CSS `:hover` rule for it, and with scripts blocked hover did nothing.');
    expect(md).toContain('framer-plugin` 3.10.3');
  });

  it('lists every row in the full row list', () => {
    for (const r of score.rows) expect(md).toContain(`| \`${r.id.replace(/\|/g, '\\|')}\` | ${r.verdict} |`);
  });

  it('contains no long dashes', () => {
    expect(md).not.toMatch(/[\u2013\u2014]/);
  });
});
