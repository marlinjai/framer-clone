// The capture's sizing and size cap with an injected renderer (jsdom has no
// canvas), and the DOM runner's unit conversion with stubbed geometry (jsdom
// has no layout): a canvas zoomed to 50% still measures in layout px.

import { describe, expect, it } from 'vitest';
import { captureFrame, captureScale, MAX_CAPTURE_CSS_HEIGHT, type JpegRenderer } from '../capture';
import { measureFrame, auditRenderedFrames, type MeasureEnv } from '../measureDom';
import { REVIEW_LIMITS } from '../protocol';

function sized(el: HTMLElement, w: number, h: number): HTMLElement {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
  return el;
}

describe('captureFrame', () => {
  it('scales Desktop to about 1000 px, keeps smaller frames 1:1', () => {
    expect(captureScale(1280)).toBeCloseTo(0.78125);
    expect(captureScale(390)).toBe(1);
  });

  it('caps the captured height and marks a tall page as truncated', async () => {
    const calls: Array<Parameters<JpegRenderer>[1]> = [];
    const render: JpegRenderer = async (_el, o) => {
      calls.push(o);
      return 'data:image/jpeg;base64,QUJD';
    };
    const out = await captureFrame({ element: sized(document.createElement('div'), 1280, 6000), breakpoint: 'desktop' }, render);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(calls[0]).toMatchObject({ width: 1280, height: MAX_CAPTURE_CSS_HEIGHT, backgroundColor: '#ffffff' });
    expect(out.image).toMatchObject({ breakpoint: 'desktop', width: 1000, cssWidth: 1280, truncated: true, data: 'QUJD' });
  });

  it('steps quality and scale down until the image fits, else fails with a reason', async () => {
    const big = 'A'.repeat(REVIEW_LIMITS.maxImageBase64Chars + 4);
    const qualities: number[] = [];
    const fitsOnThird: JpegRenderer = async (_el, o) => {
      qualities.push(o.quality);
      return `data:image/jpeg;base64,${qualities.length < 3 ? big : 'QUJD'}`;
    };
    const el = sized(document.createElement('div'), 390, 900);
    const ok = await captureFrame({ element: el, breakpoint: 'mobile' }, fitsOnThird);
    expect(ok.ok).toBe(true);
    expect(qualities).toEqual([0.72, 0.55, 0.55]);
    const never: JpegRenderer = async () => `data:image/jpeg;base64,${big}`;
    const fail = await captureFrame({ element: el, breakpoint: 'mobile' }, never);
    expect(fail).toMatchObject({ ok: false, breakpoint: 'mobile' });
  });

  it('never throws: a renderer error and an unrendered frame come back as reasons', async () => {
    const boom: JpegRenderer = async () => {
      throw new Error('tainted canvas');
    };
    expect(await captureFrame({ element: sized(document.createElement('div'), 390, 900), breakpoint: 'mobile' }, boom)).toMatchObject({
      ok: false,
      reason: 'rendering failed (tainted canvas)',
    });
    expect(await captureFrame({ element: sized(document.createElement('div'), 0, 0), breakpoint: 'mobile' }, boom)).toMatchObject({
      ok: false,
      reason: 'the frame is not rendered',
    });
  });
});

describe('measureFrame', () => {
  const rect = (x: number, y: number, w: number, h: number) =>
    ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) }) as DOMRect;

  function setup() {
    document.body.innerHTML = `
      <div data-viewport-content-id="vp-phone">
        <div data-inner-component-id="root">
          <p data-inner-component-id="stat">1,200+</p>
        </div>
      </div>`;
    const content = document.querySelector<HTMLElement>('[data-viewport-content-id]')!;
    const root = document.querySelector<HTMLElement>('[data-inner-component-id="root"]')!;
    const stat = document.querySelector<HTMLElement>('[data-inner-component-id="stat"]')!;
    // Camera at 50%: the 390px frame is 195 screen px wide, offset on screen.
    sized(content, 390, 800);
    content.getBoundingClientRect = () => rect(500, 100, 195, 400);
    root.getBoundingClientRect = () => rect(500, 100, 195, 400);
    stat.getBoundingClientRect = () => rect(510, 110, 60, 20);
    for (const [el, cw, ch, sw, sh] of [
      [root, 390, 800, 390, 800],
      [stat, 120, 40, 120, 64],
    ] as const) {
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: cw });
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: ch });
      Object.defineProperty(el, 'scrollWidth', { configurable: true, value: sw });
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: sh });
    }
    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 390 });
    const env: MeasureEnv = {
      getComputedStyle: (el) =>
        ({
          display: 'block',
          position: 'static',
          overflowX: el === stat ? 'hidden' : 'visible',
          overflowY: el === stat ? 'hidden' : 'visible',
          marginTop: '0px',
          marginRight: '0px',
          marginBottom: '0px',
          marginLeft: '0px',
          transform: 'none',
          gridRowStart: 'auto',
          gridColumnStart: 'auto',
          gridRowEnd: 'auto',
          gridColumnEnd: 'auto',
          color: 'rgb(17, 17, 17)',
          backgroundColor: el === root ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0)',
          backgroundImage: 'none',
          fontSize: '16px',
          fontWeight: '700',
        }) as unknown as CSSStyleDeclaration,
      createRange: () => document.createRange(),
    };
    return { content, env };
  }

  it('divides screen geometry by the camera zoom and links parents', () => {
    const { content, env } = setup();
    const m = measureFrame(content, { breakpoint: 'mobile', isSmallest: true }, env);
    expect(m.width).toBe(390);
    const stat = m.nodes.find((n) => n.id === 'stat')!;
    expect(stat.parentId).toBe('root');
    expect(stat.box).toEqual({ x: 20, y: 20, w: 120, h: 40 });
    expect(stat.text).toMatchObject({ content: '1,200+', fontSizePx: 16, fontWeight: 700 });
  });

  it('runs the audit on what it measured (the clipped stat)', () => {
    const { env } = setup();
    const out = auditRenderedFrames(
      [
        { viewportId: 'vp-phone', breakpoint: 'mobile', isSmallest: true },
        { viewportId: 'vp-desktop', breakpoint: 'desktop', isSmallest: false },
      ],
      { maxFindings: 10, env },
    );
    expect(out.missing).toEqual(['desktop']);
    expect(out.findings.map((f) => `${f.kind}:${f.nodeId}:${f.breakpoint}`)).toContain('text-clipped:stat:mobile');
  });
});
