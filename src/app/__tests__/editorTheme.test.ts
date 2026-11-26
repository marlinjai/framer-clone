// The editor's interface modes (docs/plans/2026-11-23-sites-home-and-light-mode.md, S2): each
// light block exists twice, once for the chosen Light and once for System on a light system,
// and the two must stay the same, or System and Light would look different.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function lightBlocks(css: string): { chosen: string; system: string } {
  const chosen = /\[data-ui-theme="light"\]\s*\{([^}]*)\}/.exec(css)?.[1];
  const system = /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-ui-theme\]\)\s*\{([^}]*)\}/.exec(css)?.[1];
  if (chosen === undefined || system === undefined) throw new Error('a light block is missing');
  const norm = (block: string) => block.split(';').map((d) => d.trim()).filter(Boolean).sort();
  return { chosen: norm(chosen).join(';'), system: norm(system).join(';') };
}

describe('the light blocks', () => {
  it.each(['editor-theme.css', 'globals.css'])('in %s say the same for Light and for System', (file) => {
    const { chosen, system } = lightBlocks(read(file));
    expect(chosen.length).toBeGreaterThan(0);
    expect(system).toBe(chosen);
  });

  it('the editor reads the suite interface modes and no dark-only suite value', () => {
    const theme = read('editor-theme.css');
    expect(theme).toContain('@import "@marlinjai/suite-theme-core/ui.css";');
    for (const file of ['editor-theme.css', 'globals.css', 'cms-grid-theme.css']) {
      expect(read(file).replace(/\/\*[\s\S]*?\*\//g, ''), file).not.toMatch(/var\(--suite-/);
    }
  });
});

// The canvas around the site frames follows the interface mode (Marlin, 2026-11-25): its ground,
// grid and the frame labels use the interface tokens. A frame's own `bg-white` is the page's backing
// under the site's own background and stays. The full raw-colour check of the editor is slice S3.
describe('the canvas ground', () => {
  const RAW = /\b(?:bg|text|ring|border)-(?:gray|neutral|zinc|slate|stone)-\d{2,3}\b|#e5e7eb|#f3f4f6/g;
  it.each([
    'components/Canvas.tsx',
    'components/ResponsivePageRenderer.tsx',
    'components/live/SkeletonLayer.tsx',
    'components/ai/PageGenDraftLayer.tsx',
  ])('%s draws the ground and the frame labels with no fixed light gray', (file) => {
    const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    expect(source.match(RAW) ?? []).toEqual([]);
  });

  it('defines the ground and the grid from the interface mode', () => {
    const theme = read('editor-theme.css');
    expect(theme).toContain('--canvas-ground: var(--ui-sunken);');
    expect(theme).toMatch(/--canvas-grid: color-mix\(in oklab, var\(--ui-text\)/);
  });
});
