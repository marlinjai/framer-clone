// The canvas shows a site in the site's colours, never the editor's (docs/plans/
// 2026-11-23-sites-home-and-light-mode.md, "The canvas and published sites do not follow the
// interface theme"). The editor pins its interface colours on `:root` (editor-theme.css); every
// page box and floating element on the canvas carries `data-fc-theme` (src/lib/site/
// surfaceTheme.ts), and the shared tokens declare the published values there too. A name the
// editor pins that the shared tokens do not reset would reach the site on the canvas: the
// score's canvas parity (test/score/pageBase.score.ts) broke that way after 2026-11-22.
import fs from 'node:fs';
import path from 'node:path';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { THEME_ATTRIBUTE } from '@/lib/site/surfaceTheme';

const read = (file: string) => postcss.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function propsOf(rule: Rule): Set<string> {
  const names = new Set<string>();
  rule.walkDecls((decl) => {
    if (decl.prop.startsWith('--')) names.add(decl.prop);
  });
  return names;
}

/** The editor's own names: chrome only, which no site content reads. */
const EDITOR_ONLY = new Set(['--brand-edge', '--brand-fill', '--brand-mark', '--canvas-ground', '--canvas-grid', '--destructive-foreground', '--home-glow', '--home-shadow', '--link', '--selection-ring', '--warning-edge', '--warning-surface']);

describe('the shared tokens on the canvas', () => {
  const tokens = read('theme-tokens.css');
  const block = tokens.nodes.find((node): node is Rule => node.type === 'rule' && node.selectors.includes(':root'));

  it('declare the published values on every canvas frame as well as on the page', () => {
    expect(block?.selectors).toEqual([':root', `[${THEME_ATTRIBUTE}]`]);
  });

  it('reset every name the editor pins, except its own chrome names', () => {
    const shared = propsOf(block!);
    const editor = read('editor-theme.css');
    const pinned = new Set<string>();
    editor.walkRules((rule) => {
      if (rule.parent?.type === 'root' && rule.selector === ':root') propsOf(rule).forEach((name) => pinned.add(name));
    });
    expect(pinned.size).toBeGreaterThan(20);
    const leaking = [...pinned].filter((name) => !shared.has(name) && !EDITOR_ONLY.has(name));
    expect(leaking).toEqual([]);
  });

  it('give a frame no colour scheme of its own, so the editor mode does not reach its controls', () => {
    const reset = tokens.nodes.find((node): node is Rule => node.type === 'rule' && node.selector === `[${THEME_ATTRIBUTE}]`);
    let scheme: string | undefined;
    reset?.walkDecls('color-scheme', (decl) => {
      scheme = decl.value;
    });
    expect(scheme).toBe('normal');
  });
});
