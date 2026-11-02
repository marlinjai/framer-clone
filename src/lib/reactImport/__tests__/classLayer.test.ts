// @vitest-environment node
// Layer 2 inside the pipeline: classes from the source reach Tailwind, what came of them
// lands on the nodes, and every line stands where the source says it, with source text
// only in an excerpt.

import { describe, expect, it } from 'vitest';
import { DETAILS, type ImportLine } from '../report';
import { importSource, type ImportOptions } from '../source';

const SHEET = ':root { --primary: #123456; --border: #abcdef; --ring: #fedcba; }\n@theme inline { --color-primary: var(--primary); }';
const run = (text: string, options: ImportOptions = {}, sheet = SHEET) => importSource([{ name: 'c.tsx', text }, { name: 'theme.css', text: sheet }], options);
const lineOf = (lines: ImportLine[], detail: string) => lines.find((line) => line.detail === detail);

describe('where classes come from', () => {
  it('reads a literal, a template and a constant', async () => {
    const { root } = await run('const pad = "px-4";\n<div className={`${pad} flex`}><p className="bg-primary">x</p></div>');
    expect(root?.props).toMatchObject({ style: { display: 'flex', paddingInline: 'calc(var(--spacing) * 4)' } });
    expect(root?.children?.[0]?.props).toMatchObject({ style: { backgroundColor: 'var(--primary)' } });
  });

  it('reads the arguments of an imported helper, and merges where the helper merges', async () => {
    const cn = await run('import { cn } from "@/lib/utils";\n<div className={cn("px-2", false && "hidden", { flex: true, grid: false }, ["px-4"])} />');
    expect(cn.root?.props?.style).toEqual(expect.objectContaining({ display: 'flex', paddingInline: 'calc(var(--spacing) * 4)' }));
    expect(lineOf(cn.report.lines, DETAILS.classMerged)?.excerpt).toBe('px-2');
    expect(lineOf(cn.report.lines, DETAILS.cnAssumed)).toMatchObject({ kind: 'import', disposition: 'adapted', line: 1 });

    const clsx = await run('import clsx from "clsx";\n<div className={clsx("flex", "hidden")} />');
    // `clsx` does not merge, so both stay, and Tailwind's own order decides, as in the original.
    expect(lineOf(clsx.report.lines, DETAILS.classMerged)).toBeUndefined();
    expect(lineOf(clsx.report.lines, DETAILS.classHelper)).toMatchObject({ kind: 'import', disposition: 'converted' });
  });

  it('does not take a function for a helper by its name alone', async () => {
    const local = await run('function cn(...a) { return "hidden"; }\n<div className={cn("flex")} />');
    expect(lineOf(local.report.lines, DETAILS.classDynamic)).toMatchObject({ disposition: 'left' });
    const shadowed = await run('import { cn } from "@/lib/utils";\nfunction C({ cn }) { return <div className={cn("flex")} />; }');
    expect(lineOf(shadowed.report.lines, DETAILS.classDynamic)).toMatchObject({ disposition: 'left' });
  });

  it('converts the known part of a dynamic list, and leaves the list', async () => {
    const { root, report } = await run('import { cn } from "@/lib/utils";\nfunction C({ className }) { return <div className={cn("flex", className)} />; }');
    expect(root?.props?.style).toMatchObject({ display: 'flex' });
    expect(report.verdict).toBe('not-imported');
    expect(lineOf(report.lines, DETAILS.classDynamic)).toMatchObject({ kind: 'class-unknown', disposition: 'left', nodeKey: 'n-0' });
  });

  it('keeps only the last class attribute, as React does', async () => {
    const { root, report } = await run('<div className="hidden" className="flex" />');
    expect(root?.props?.style).toEqual({ '--border': '#abcdef', '--ring': '#fedcba', display: 'flex' });
    expect(lineOf(report.lines, DETAILS.classReplaced)).toMatchObject({ disposition: 'converted' });
  });
});

describe('what the lines say', () => {
  it('claims a class attribute with what became of it, and names each class that came to nothing', async () => {
    const { report } = await run('<div className="flex not-a-class" />');
    expect(lineOf(report.lines, DETAILS.classesLeft)).toMatchObject({ kind: 'class', disposition: 'left', line: 1, column: 6, nodeKey: 'n-0' });
    expect(lineOf(report.lines, DETAILS.classNoOutput)).toMatchObject({ disposition: 'left', line: 1, column: 6, excerpt: 'not-a-class' });
    const clean = await run('<div className="flex" />');
    expect(lineOf(clean.report.lines, DETAILS.classConverted)).toMatchObject({ disposition: 'converted' });
  });

  it('puts source only in excerpts, which a developer can leave out', async () => {
    const text = '<div className="flex secret-looking-word [color:url(https://evil.test/x)]" />';
    const kept = await run(text);
    expect(kept.report.lines.some((line) => line.excerpt?.includes('secret-looking-word'))).toBe(true);
    expect(kept.report.lines.some((line) => line.detail.includes('secret-looking-word') || line.detail.includes('evil.test'))).toBe(false);
    const left = await run(text, { excerpts: false });
    expect(JSON.stringify(left.report)).not.toContain('secret-looking-word');
    expect(JSON.stringify(left.report)).not.toContain('evil.test');
  });

  it('places a line about the sheet on its line in the sheet', async () => {
    const { report } = await run('<div className="flex" />', {}, ':root { --x: 1px; }\n\n@plugin "x";');
    expect(lineOf(report.lines, DETAILS.sheetAtRule)).toMatchObject({ file: 'theme.css', line: 3, disposition: 'left' });
  });
});

describe('what the project decides', () => {
  it('keys a breakpoint map by the project frame ids', async () => {
    const { root } = await run('<div className="p-2 md:p-4" />', { breakpoints: { tablet: 'frame-t', mobile: 'frame-m' } });
    expect(root?.props?.style).toMatchObject({ padding: { base: 'calc(var(--spacing) * 4)', 'frame-m': 'calc(var(--spacing) * 2)' } });
  });

  it('writes dark as the media query when asked', async () => {
    const sheet = `${SHEET}\n.dark { --primary: #000000; }`;
    const asked = await run('<div className="bg-primary" />', { systemDark: true }, sheet);
    expect(JSON.stringify(asked.root?.props?.rules)).toContain('prefers-color-scheme: dark');
    expect(lineOf(asked.report.lines, DETAILS.darkClass)).toBeUndefined();
  });

  it('puts tokens on the wrapper when there is one', async () => {
    const { root } = await run('<><p className="bg-primary">a</p><p>b</p></>');
    expect(root?.id).toBe('n');
    expect(root?.props?.style).toMatchObject({ '--primary': '#123456' });
  });
});
