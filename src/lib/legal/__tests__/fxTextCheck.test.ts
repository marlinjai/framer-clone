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
    expect(fxTextWarning(box(lockupScene, []))).toMatch(/inside the box\.$/);
  });
  it('is quiet when the box holds HTML text, even nested', () => {
    expect(fxTextWarning(box(lockupScene, [text('Hello')]))).toBeNull();
    expect(fxTextWarning(box(lockupScene, [{ id: 'd', type: 'div', props: {}, children: [text('Hello')] }]))).toBeNull();
  });
  it('counts text bound to data and numbers as text', () => {
    expect(fxTextWarning(box(lockupScene, [{ id: 'h', type: 'h1', props: {}, bindings: { children: { source: 'x' } } }]))).toBeNull();
    expect(fxTextWarning(box(lockupScene, [{ id: 'n', type: 'p', props: { children: 7 } }]))).toBeNull();
  });
  it('counts text held in the box\'s own props.children, bound or numeric', () => {
    const own = (props: Record<string, unknown>, bindings?: unknown) => ({
      id: 'b',
      type: 'div',
      props: { 'data-fx': 'scene', fx: lockupScene, ...props },
      ...(bindings ? { bindings } : {}),
      children: [],
    });
    expect(fxTextWarning(own({ children: 'Hello' }))).toBeNull();
    expect(fxTextWarning(own({ children: 7 }))).toBeNull();
    expect(fxTextWarning(own({}, { children: { source: 'x' } }))).toBeNull();
    expect(countFxBoxesWithoutHtmlText(own({ children: '  ' }))).toBe(1);
  });
  it('does not warn for a text layer that is hidden (it draws nothing)', () => {
    const hidden = (lockupScene as { scene: { layers: { type: string; visible: boolean }[] } });
    const copy = JSON.parse(JSON.stringify(hidden));
    for (const l of copy.scene.layers) if (l.type === 'text') l.visible = false;
    expect(fxTextWarning(box(copy.scene ? { ...(lockupScene as object), scene: copy.scene } : lockupScene, []))).toBeNull();
  });
  it('does not warn for a text layer with nothing to draw (blank text), for either kind', () => {
    const blank = (type: string, keys: string[]) => {
      const added = addFxLayer(made.stored, type);
      if (!added.ok) throw new Error('add');
      const scene = JSON.parse(JSON.stringify(added.stored)) as { scene: { layers: { type: string; params: Record<string, unknown> }[] } };
      const layer = scene.scene.layers.find((l) => l.type === type)!;
      for (const k of keys) layer.params[k] = '   ';
      return scene;
    };
    const textBox = blank('textBox', ['text']);
    const lockup = blank('text', ['eyebrowText', 'headlineText', 'taglineText']);
    expect(fxTextWarning(box(textBox, []))).toBeNull();
    expect(fxTextWarning(box(lockup, []))).toBeNull();
    // one line is enough to draw something
    const one = blank('text', ['eyebrowText', 'taglineText']);
    expect(fxTextWarning(box(one, []))).toMatch(/no text in its box/);
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
    expect(check.fxText?.some((c) => c.pageId === 'home' && /FX scene/.test(c.message))).toBe(true);
    // its own list: it is not a component that will not show
    expect(check.components).toEqual([]);
    expect(hasPublishIssues(check)).toBe(true);
    const ok = checkBeforePublish(EMPTY_BUSINESS, [page([box(lockupScene, [text('Hi')])])], { definitions: {}, refused: [] });
    expect(hasPublishIssues(ok)).toBe(false);
  });
});
