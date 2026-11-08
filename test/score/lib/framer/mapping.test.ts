// The Framer mapping against its two sources of truth: the installed framer-plugin typings
// (every cited symbol is declared, every quoted enumeration matches) and the published matrix
// (every row classified, every table key a real row).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROW_KINDS, type RowKind } from '../types';
import { FRAMER_RULES, FRAMER_VERDICTS, SVG_UNSETTLED, classifyFramer, type FramerVerdict } from './mapping';
import { CSS_UNITS, FRAMER_DOCS, FRAMER_PLUGIN, QUOTED_TUPLES, QUOTED_UNIONS, readTypings } from './typings';
import crypto from 'node:crypto';

const typings = readTypings();
const published = JSON.parse(fs.readFileSync(path.resolve('docs/primitives-score/latest.json'), 'utf8')) as {
  matrix: { rows: Record<string, string> };
};
const rowKeys = Object.keys(published.matrix.rows);
const idsOf = (kind: RowKind) => new Set(rowKeys.filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1)));

/** The text of the declaration of `name`, from its line to its closing brace or semicolon. */
function declaration(name: string): string | undefined {
  const lines = typings.split('\n');
  const head = new RegExp(`^(export )?declare (type|interface|class|enum|const|abstract class) ${name.replace(/\$/g, '\\$')}\\b`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return undefined;
  let depth = 0;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= 0 && /[;}]\s*$/.test(line)) break;
  }
  return out.join('\n');
}

function allVerdicts(): Array<{ where: string; verdict: FramerVerdict }> {
  const out: Array<{ where: string; verdict: FramerVerdict }> = [];
  for (const key of rowKeys) {
    const [kind, ...rest] = key.split(':');
    out.push({ where: key, verdict: classifyFramer(kind, rest.join(':')) });
  }
  return out;
}

describe('the pinned typings', () => {
  it('are framer-plugin 3.10.3, byte for byte the file the mapping was read from', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('node_modules/framer-plugin/package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(FRAMER_PLUGIN.version);
    const root = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    expect(root.devDependencies['framer-plugin']).toBe(FRAMER_PLUGIN.version);
    expect(crypto.createHash('sha256').update(typings).digest('hex')).toBe(FRAMER_PLUGIN.typingsSha256);
  });

  it.each(Object.entries(QUOTED_UNIONS))('quote %s literally', (name, values) => {
    const text = declaration(name);
    expect(text, `${name} is declared`).toBeDefined();
    const literals = [...(text ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(literals).toEqual([...values]);
  });

  it.each(Object.entries(QUOTED_TUPLES))('quote the tuple %s literally', (name, values) => {
    const text = declaration(name) ?? '';
    const body = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    const items = body.replace(/[[\]\s"]/g, '').split(',').filter(Boolean);
    expect(items).toEqual([...values]);
  });

  it('quote the CSSUnit enum literally', () => {
    const text = declaration('CSSUnit') ?? '';
    expect([...text.matchAll(/= "([^"]*)"/g)].map((m) => m[1])).toEqual([...CSS_UNITS]);
  });

  it('declare every symbol a verdict cites, and every member it names', () => {
    const missing: string[] = [];
    for (const { where, verdict } of allVerdicts()) {
      for (const symbol of verdict.symbols) {
        const [name, member] = symbol.split('.');
        const text = declaration(name);
        if (!text) missing.push(`${where}: ${name} is not declared`);
        else if (member && !new RegExp(`\\b${member}\\b`).test(text)) missing.push(`${where}: ${name} has no member ${member}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it('give vw no trait: the enum declares it and nothing accepts it, so it stays unknown', () => {
    expect(typings.match(/CSSUnit\.ViewportWidth/g)).toBeNull();
    expect(classifyFramer('css-value', 'vw').verdict).toBe('unknown');
  });
});

describe('the mapping', () => {
  it('has rules for every row kind, and refuses a kind it does not know', () => {
    expect(Object.keys(FRAMER_RULES).sort()).toEqual([...ROW_KINDS].sort());
    expect(() => classifyFramer('css-thing', 'x')).toThrow(/unknown row kind "css-thing"/);
  });

  it('keys every table by a row id that exists in the published matrix', () => {
    const stray: string[] = [];
    for (const kind of ROW_KINDS) {
      const ids = idsOf(kind);
      for (const id of Object.keys(FRAMER_RULES[kind].table)) if (!ids.has(id)) stray.push(`${kind}:${id}`);
    }
    const svgElements = idsOf('svg-element');
    for (const element of SVG_UNSETTLED) if (!svgElements.has(element)) stray.push(`svg-element:${element}`);
    expect(stray).toEqual([]);
  });

  it('gives every row exactly one of the four verdicts, with a reason', () => {
    for (const { where, verdict } of allVerdicts()) {
      expect(FRAMER_VERDICTS, where).toContain(verdict.verdict);
      expect(verdict.reason.length, `${where} has a reason`).toBeGreaterThan(0);
    }
  });

  it('rests every native, partial and unknown verdict on a typings symbol or a fetched page', () => {
    for (const { where, verdict } of allVerdicts()) {
      if (verdict.verdict === 'code-only') continue;
      expect(verdict.symbols.length > 0 || Boolean(verdict.docUrl), where).toBe(true);
    }
  });

  it('names the restriction of every partial verdict', () => {
    for (const { where, verdict } of allVerdicts()) {
      if (verdict.verdict === 'partial') expect(verdict.restriction?.length, where).toBeGreaterThan(0);
      else expect(verdict.restriction, where).toBeUndefined();
    }
  });

  it('cites a fetched page or the recorded editor test for every documented-not-measured row, and only those', () => {
    const fetched = new Set<string>(Object.values(FRAMER_DOCS));
    for (const { where, verdict } of allVerdicts()) {
      if (verdict.documentedNotMeasured) {
        expect(Boolean(verdict.docUrl) !== Boolean(verdict.source), `${where} has one source`).toBe(true);
        if (verdict.docUrl) expect(fetched.has(verdict.docUrl), where).toBe(true);
      } else {
        expect(verdict.docUrl, where).toBeUndefined();
        expect(verdict.source, where).toBeUndefined();
      }
    }
  });

  it('never defaults a row to native: every native row is an explicit table entry', () => {
    for (const key of rowKeys) {
      const [kind, ...rest] = key.split(':');
      const id = rest.join(':');
      if (classifyFramer(kind, id).verdict === 'native') expect(FRAMER_RULES[kind as RowKind].table[id], key).toBeDefined();
    }
  });

  it('keeps the measured hover fact on :hover, and focus out of the gestures', () => {
    expect(classifyFramer('css-selector', ':hover').restriction).toMatch(/no CSS :hover rule/);
    expect(classifyFramer('component', 'state-focused').verdict).toBe('code-only');
    expect(classifyFramer('svg-attribute', 'animate.dur').verdict).toBe('unknown');
    expect(classifyFramer('svg-attribute', 'path.d').verdict).toBe('partial');
    expect(classifyFramer('html-element-attribute', 'input.required').documentedNotMeasured).toBe(true);
  });
});
