import { describe, it, expect } from 'vitest';
import {
  renderPageMarkup,
  flattenInlineStyles,
  wrapDocument,
  emitStaticHtmlForPage,
  primaryBreakpointId,
} from '@/lib/renderer/staticHtmlEmitter';
import {
  makeSinglePageProject,
  BP_DESKTOP,
} from '@/lib/renderer/publish/__tests__/fixtures/sampleProject';

function homePage() {
  return makeSinglePageProject().getPage('page-home')!;
}

describe('renderPageMarkup', () => {
  it('renders host tags, text, and data-component-id identity attributes', () => {
    const html = renderPageMarkup(homePage(), BP_DESKTOP);
    expect(html).toContain('<h1');
    expect(html).toContain('Welcome home');
    expect(html).toContain(`data-component-id="${BP_DESKTOP}-home-root"`);
    expect(html).toContain('data-inner-component-id="home-title"');
  });

  it('omits hidden (canvasVisible:false) nodes', () => {
    const html = renderPageMarkup(homePage(), BP_DESKTOP);
    expect(html).not.toContain('invisible-marker');
  });

  it('emits void <img> with no closing tag', () => {
    const html = renderPageMarkup(homePage(), BP_DESKTOP);
    expect(html).toContain('<img');
    expect(html).not.toContain('</img>');
  });

  it('chooses the primary (largest) breakpoint by default', () => {
    expect(primaryBreakpointId(homePage())).toBe(BP_DESKTOP);
  });
});

describe('flattenInlineStyles', () => {
  it('hoists inline styles into classes and leaves no style= in the HTML', () => {
    const raw = renderPageMarkup(homePage(), BP_DESKTOP);
    expect(raw).toContain('style="');
    const { html, css } = flattenInlineStyles(raw);
    expect(html).not.toContain('style="');
    expect(html).toContain('class="s');
    expect(css.length).toBeGreaterThan(0);
    expect(css).toMatch(/\.s0\{[^}]+\}/);
  });

  it('deduplicates identical declarations to one class', () => {
    const { css } = flattenInlineStyles(
      '<a style="color:red"></a><b style="color:red"></b><c style="color:blue"></c>',
    );
    // two unique declarations -> two rules
    expect(css.split('\n')).toHaveLength(2);
  });

  it('merges a hoisted class with a pre-existing class attribute', () => {
    const { html } = flattenInlineStyles('<div class="keep" style="color:red"></div>');
    const classMatch = html.match(/class="([^"]*)"/g) ?? [];
    expect(classMatch).toHaveLength(1); // a single merged class attribute
    expect(html).toContain('keep');
    expect(html).toContain('s0');
  });

  it('decodes HTML entities back to literal CSS', () => {
    const { css } = flattenInlineStyles(
      '<div style="font-family:&quot;Inter&quot;,sans-serif"></div>',
    );
    expect(css).toContain('font-family:"Inter",sans-serif');
  });
});

describe('emitStaticHtmlForPage', () => {
  it('returns a fragment by default', () => {
    const out = emitStaticHtmlForPage(homePage(), BP_DESKTOP);
    expect(out).not.toContain('<!DOCTYPE');
    expect(out).toContain('Welcome home');
  });

  it('wraps a minimal HTML5 document with an inline <style> when flattening', () => {
    const out = emitStaticHtmlForPage(homePage(), BP_DESKTOP, {
      documentShell: 'minimal-html5',
      flattenStyles: true,
      title: 'My Home',
    });
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toContain('<title>My Home</title>');
    expect(out).toContain('<style>');
    expect(out).not.toContain('style="');
  });
});

describe('wrapDocument', () => {
  it('injects head tags verbatim and escapes the title', () => {
    const doc = wrapDocument({
      bodyHtml: '<main>hi</main>',
      title: 'A & B <x>',
      headTags: ['<link rel="stylesheet" href="style.css" />'],
    });
    expect(doc).toContain('<link rel="stylesheet" href="style.css" />');
    expect(doc).toContain('<title>A &amp; B &lt;x&gt;</title>');
    expect(doc).toContain('<body><main>hi</main></body>');
  });
});
