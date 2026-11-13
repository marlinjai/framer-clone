import { describe, expect, it } from 'vitest';
import { EMPTY_BUSINESS } from '@/lib/site/siteSettings';
import { addFxLayer, fxFromPreset } from '@/lib/fxScene/edit';
import { checkBeforePublish, hasPublishIssues, type PublishCheckPage } from '../publishCheck';
import { countFxBoxesWithoutHtmlText, fxTextWarning } from '../fxTextCheck';

const made = fxFromPreset('gold-noise-gradient');
if (!made.ok) throw new Error('preset');
const withLockup = addFxLayer(made.stored, 'text');
if (!withLockup.ok) throw new Error('lockup');
const lockupScene = withLockup.stored;

const box = (fx: unknown, children: unknown[]) => ({ id: 'b', type: 'div', props: { 'data-fx': 'scene', fx }, children });
const text = (children: string) => ({ id: 't', type: 'h1', props: { children } });
const page = (children: unknown[]): PublishCheckPage => ({
  id: 'home',
  slug: '',
  metadata: { title: 'Home' },
  snapshot: { appComponentTree: { id: 'r', type: 'div', props: {}, children } } as never,
});

describe('the FX text publish warning', () => {
  it('warns when a scene has a text layer and the box has no HTML text', () => {
    expect(countFxBoxesWithoutHtmlText(box(lockupScene, []))).toBe(1);
    expect(fxTextWarning(box(lockupScene, []))).toMatch(/no text in its box/);
  });
  it('is quiet when the box holds HTML text, even nested', () => {
    expect(fxTextWarning(box(lockupScene, [text('Hello')]))).toBeNull();
    expect(fxTextWarning(box(lockupScene, [{ id: 'd', type: 'div', props: {}, children: [text('Hello')] }]))).toBeNull();
  });
  it('counts text bound to data and numbers as text', () => {
    expect(fxTextWarning(box(lockupScene, [{ id: 'h', type: 'h1', props: {}, bindings: { children: { source: 'x' } } }]))).toBeNull();
    expect(fxTextWarning(box(lockupScene, [{ id: 'n', type: 'p', props: { children: 7 } }]))).toBeNull();
  });
  it('treats blank text as no text', () => {
    expect(countFxBoxesWithoutHtmlText(box(lockupScene, [text('   ')]))).toBe(1);
  });
  it('is quiet for a scene without text layers, and for a text box layer it warns', () => {
    const plain = made.stored; // the gold preset draws no text
    expect(fxTextWarning(box(plain, []))).toBeNull();
    const withBox = addFxLayer(plain, 'textBox');
    expect(withBox.ok).toBe(true);
    if (withBox.ok) expect(countFxBoxesWithoutHtmlText(box(withBox.stored, []))).toBe(1);
  });
  it('ignores an unreadable scene and ordinary nodes', () => {
    expect(fxTextWarning(box({ nope: true }, []))).toBeNull();
    expect(fxTextWarning({ type: 'div', props: {}, children: [text('x')] })).toBeNull();
    expect(fxTextWarning(null)).toBeNull();
  });
  it('reaches the publish check as an issue on its page', () => {
    const check = checkBeforePublish(EMPTY_BUSINESS, [page([box(lockupScene, [])])], { definitions: {}, refused: [] });
    expect(check.components.some((c) => c.pageId === 'home' && /FX scene/.test(c.message))).toBe(true);
    expect(hasPublishIssues(check)).toBe(true);
    const ok = checkBeforePublish(EMPTY_BUSINESS, [page([box(lockupScene, [text('Hi')])])], { definitions: {}, refused: [] });
    expect(hasPublishIssues(ok)).toBe(false);
  });
});
