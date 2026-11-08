// A site's colour mode on the editor surfaces (docs/plans/2026-11-02-theme-and-head.md,
// "The mode on the canvas", slice T3): the frame's scheme answers a stored
// `prefers-color-scheme` rule, never the editor's machine, and a forced `dark` frame
// answers `&:is(.dark *)`.

import { describe, expect, it } from 'vitest';
import type { SurfaceMemo } from '@/lib/responsive/responsiveCss';
import { constantConditions } from '../surfaces';
import { surfaceSheet, type SurfaceNode, type SurfaceProblem, type SurfaceSheetInput } from '../surfaceSheet';

const BREAKPOINTS = [{ id: 'desk', minWidth: 1280 }, { id: 'mob', minWidth: 320 }];
const FRAMES = [
  { breakpointId: 'desk', width: 1280, height: 800 },
  { breakpointId: 'mob', width: 320, height: 640 },
];
const ROOT = '[data-viewport-content-id]';
const PREVIEW = '[data-preview-frame]';
const copy = (breakpoint: string, id: string, root = ROOT) => `${root} [data-component-id="${breakpoint}-${id}"]`;

const node = (id: string, props: Record<string, unknown>, ...children: SurfaceNode[]): SurfaceNode => ({ id, type: 'div', props, children });

const DARK_RULE = { id: 'd', selector: '&', at: ['@media (prefers-color-scheme: dark)'], style: { color: 'white' } };
const LIGHT_RULE = { id: 'l', selector: '&', at: ['@media (prefers-color-scheme: light)'], style: { color: 'black' } };
const NARROW_DARK = { id: 'n', selector: '&', at: ['@media (prefers-color-scheme: dark) and (max-width: 600px)'], style: { color: 'gray' } };
const page = node('a', { rules: [DARK_RULE, LIGHT_RULE, NARROW_DARK] });

const canvas = (more: Partial<SurfaceSheetInput> = {}, tree: SurfaceNode = page): string =>
  surfaceSheet({ kind: 'canvas', tree, frames: FRAMES, breakpoints: BREAKPOINTS, ...more });
const preview = (more: Partial<SurfaceSheetInput> = {}, tree: SurfaceNode = page): string =>
  surfaceSheet({ kind: 'preview', tree, frames: [FRAMES[1]], breakpoints: BREAKPOINTS, ...more });

describe('a colour mode on the canvas', () => {
  it('with no mode chosen, keeps every colour scheme rule dead, as today', () => {
    const css = canvas();
    expect(css).not.toContain('color:white');
    expect(css).not.toContain('color:black');
    expect(css).not.toContain('prefers-color-scheme');
  });

  it('in light, shows the light rule unconditionally and never the dark one', () => {
    const css = canvas({ colorMode: 'light' });
    expect(css).toContain(`${copy('desk', 'a')}{color:black!important}`);
    expect(css).toContain(`${copy('mob', 'a')}{color:black!important}`);
    expect(css).not.toContain('color:white');
    expect(css).not.toContain('color:gray');
    expect(css).not.toContain('prefers-color-scheme');
  });

  it('in dark, shows the dark rule, and lets the frame answer what is left', () => {
    const css = canvas({ colorMode: 'dark' });
    expect(css).toContain(`${copy('desk', 'a')}{color:white!important}`);
    expect(css).not.toContain('color:black');
    // The narrow frame answers the width; the wide one rules it out.
    expect(css).toContain(`${copy('mob', 'a')}{color:gray!important}`);
    expect(css).not.toContain(`${copy('desk', 'a')}{color:gray`);
    expect(css).not.toContain('prefers-color-scheme');
  });

  it('a switch with one memo never hands back the other mode\'s blocks', () => {
    const memo: SurfaceMemo = new WeakMap();
    const dark = canvas({ colorMode: 'dark', memo });
    const light = canvas({ colorMode: 'light', memo });
    expect(dark).toContain('color:white');
    expect(light).not.toContain('color:white');
    expect(light).toContain('color:black');
    expect(canvas({ colorMode: 'dark', memo })).toBe(dark);
    expect(canvas({ memo })).not.toContain('color:white');
  });

  it('leaves a form it cannot answer as stored, and says so once', () => {
    const tree = node('a', { rules: [{ id: 'o', selector: '&', at: ['@media (prefers-color-scheme: dark) or (min-width: 600px)'], style: { color: 'red' } }] });
    const problems: SurfaceProblem[] = [];
    const css = canvas({ colorMode: 'light', onProblem: (p) => problems.push(p) }, tree);
    // As stored, the canvas reads it as it reads any condition on the environment: dead.
    expect(css).not.toContain('color:red');
    expect(problems.filter((p) => p.reason.includes('prefers-color-scheme'))).toHaveLength(1);
  });

  it('answers a rule on the document the same way, on the page root of each frame', () => {
    const tree = node('root', { rules: [{ id: 'r', selector: ':root', at: ['@media (prefers-color-scheme: dark)'], style: { color: 'white' } }] });
    expect(canvas({ colorMode: 'dark' }, tree)).toContain(`${copy('desk', 'root')}{color:white!important}`);
    expect(canvas({ colorMode: 'light' }, tree)).not.toContain('color:white');
  });
});

describe('a colour mode on the preview', () => {
  it('with no mode chosen, keeps the condition for the real system, as published', () => {
    const css = preview();
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('color:white');
  });

  it('on a forced or previewed mode, answers it from the site and never from the machine', () => {
    const light = preview({ colorMode: 'light' });
    expect(light).not.toContain('prefers-color-scheme');
    expect(light).not.toContain('color:white');
    expect(light).toContain(`${copy('mob', 'a', PREVIEW)}{color:black!important}`);
    const dark = preview({ colorMode: 'dark' });
    expect(dark).not.toContain('prefers-color-scheme');
    expect(dark).toContain(`${copy('mob', 'a', PREVIEW)}{color:white!important}`);
    expect(dark).toContain(`${copy('mob', 'a', PREVIEW)}{color:gray!important}`);
  });
});

describe('the dark class on a forced dark frame', () => {
  const tree = node('a', { rules: [{ id: 'k', selector: '&:is(.dark *)', style: { color: 'white' } }] });

  it('is live there, and dead on every other frame, the editor document notwithstanding', () => {
    expect(canvas({ colorMode: 'dark', darkClass: true }, tree)).toContain(`${copy('desk', 'a')}:is(*, :is(.dark *)){color:white!important}`);
    // A `system` site previewing dark writes no class, as its published page does not.
    expect(canvas({ colorMode: 'dark' }, tree)).toContain(`${copy('desk', 'a')}:not(*, :is(.dark *)){color:white!important}`);
    expect(preview({ colorMode: 'dark', darkClass: true }, tree)).toContain(':is(*, :is(.dark *))');
    expect(preview({ colorMode: 'dark' }, tree)).toContain(':not(*, :is(.dark *))');
  });

  it('answers only that exact selector', () => {
    expect(constantConditions(':is(.dark *)', 'canvas', false, true)).toBe(':is(*, :is(.dark *))');
    expect(constantConditions(':where(.dark *)', 'canvas', false, true)).toBe(':not(*, :where(.dark *))');
    expect(constantConditions(':is(.dark p)', 'canvas', false, true)).toBe(':not(*, :is(.dark p))');
    expect(constantConditions(':is(html .dark *)', 'canvas', false, true)).toBe(':not(*, :is(html .dark *))');
    expect(constantConditions(':is(.dark *)', 'canvas', false, false)).toBe(':not(*, :is(.dark *))');
  });
});
