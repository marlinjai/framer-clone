// Photo backgrounds (imageQuery on a container), aspect-ratio image boxes and
// the credit rules for background photos in the validator.

import { describe, expect, it } from 'vitest';
import { validateGeneration } from '../validate';
import { allowedPropKeysFor, deriveBreakpointKeys, GENERATION_LIMITS, IMAGE_QUERY_PROP } from '../schema';
import { CSS_PROP_SET } from '@/models/ComponentModel';
import { CONTAINER_TYPES } from '@/components/sidebars/right/sectionConfig';

const breakpoints = deriveBreakpointKeys([
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Mobile', minWidth: 320 },
]);

function ok(raw: unknown) {
  let n = 0;
  const out = validateGeneration(raw, { breakpoints, newId: () => `id${(n += 1)}` });
  if (!out.ok) throw new Error(`expected ok, got errors: ${out.errors.join('; ')}`);
  return out.result;
}

const SCRIM = 'linear-gradient(to top, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0) 65%)';
const UNSPLASH = 'https://images.unsplash.com/photo-1?w=2400&q=80&fit=max&auto=format';
const credit = {
  'data-credit-name': 'Ana',
  'data-credit-url': 'https://unsplash.com/@ana?utm_source=lumitra&utm_medium=referral',
  'data-credit-source-url': 'https://unsplash.com/?utm_source=lumitra&utm_medium=referral',
};

describe('schema: photo backgrounds and aspect ratio', () => {
  it('allows imageQuery on every container tag and on img, nowhere else', () => {
    for (const tag of CONTAINER_TYPES) expect(allowedPropKeysFor(tag)).toContain(IMAGE_QUERY_PROP);
    expect(allowedPropKeysFor('img')).toContain(IMAGE_QUERY_PROP);
    expect(allowedPropKeysFor('h1')).not.toContain(IMAGE_QUERY_PROP);
    expect(allowedPropKeysFor('a')).not.toContain(IMAGE_QUERY_PROP);
  });

  it('aspectRatio is an editor style key', () => {
    expect(CSS_PROP_SET.has('aspectRatio')).toBe(true);
  });

  it('a scrim plus a sized Unsplash URL fits one style value', () => {
    expect(`${SCRIM}, url("${UNSPLASH}&ixid=M3w2Mzg1NzF8MHwxfHNlYXJjaHwxfHxtb3VudGFpbnxlbnwwfHx8fDE3MzAwMDAwMDB8MA")`.length).toBeLessThan(
      GENERATION_LIMITS.maxStyleValueChars,
    );
  });
});

describe('validateGeneration: photo backgrounds', () => {
  it('collects a background request with the scrim kept and the query taken out of the props', () => {
    const result = ok({
      nodes: [
        {
          type: 'section',
          label: 'Hero',
          props: {
            imageQuery: 'misty pine forest wide shot',
            style: { backgroundColor: '#0f172a', backgroundImage: SCRIM, minHeight: { base: '720px', mobile: '560px' } },
          },
          children: [{ type: 'h1', props: { children: 'Wald' } }],
        },
      ],
    });
    const hero = result.nodes[0];
    expect(hero.props).not.toHaveProperty(IMAGE_QUERY_PROP);
    expect((hero.props.style as Record<string, unknown>).backgroundImage).toBe(SCRIM);
    // A fluid section: landscape, sized as a full-width one.
    expect(result.imageRequests).toEqual([
      { nodeId: hero.id, kind: 'background', query: 'misty pine forest wide shot', orientation: 'landscape', widthPx: 1200 },
    ]);
  });

  it('reads the shape of a px background box from its width and minHeight', () => {
    const result = ok({
      nodes: [{ type: 'div', props: { imageQuery: 'tall cactus', style: { width: '400px', minHeight: '600px' } } }],
    });
    expect(result.imageRequests[0]).toMatchObject({ kind: 'background', orientation: 'portrait', widthPx: 400 });
  });

  it('a background URL from the brief wins over the query', () => {
    const result = ok({
      nodes: [{ type: 'section', props: { imageQuery: 'forest', style: { backgroundImage: `${SCRIM}, url("https://example.com/own.jpg")` } } }],
    });
    expect(result.imageRequests).toEqual([]);
    expect((result.nodes[0].props.style as Record<string, unknown>).backgroundImage).toBe(`${SCRIM}, url("https://example.com/own.jpg")`);
  });

  it('keeps an Unsplash background that comes back with its credit, without a hover title', () => {
    const backgroundImage = `${SCRIM}, url("${UNSPLASH}")`;
    const result = ok({ nodes: [{ type: 'section', props: { ...credit, style: { backgroundImage } } }] });
    const props = result.nodes[0].props;
    expect((props.style as Record<string, unknown>).backgroundImage).toBe(backgroundImage);
    expect(props).toMatchObject(credit);
    expect(props).not.toHaveProperty('title');
    expect(result.warnings).toEqual([]);
  });

  it('drops the photo layer of an uncredited Unsplash background, keeps the scrim and resolves the query afresh', () => {
    const result = ok({
      nodes: [{ type: 'section', props: { imageQuery: 'forest', style: { backgroundImage: `${SCRIM}, url("${UNSPLASH}")` } } }],
    });
    expect((result.nodes[0].props.style as Record<string, unknown>).backgroundImage).toBe(SCRIM);
    expect(result.nodes[0].props).not.toHaveProperty('data-credit-name');
    expect(result.imageRequests.map((r) => r.query)).toEqual(['forest']);
    expect(result.warnings.some((w) => w.includes('Unsplash background photo without its credit'))).toBe(true);
  });

  it('removes a background that was only an uncredited Unsplash photo, on every breakpoint', () => {
    const result = ok({
      nodes: [{ type: 'section', props: { style: { backgroundImage: { base: `url("${UNSPLASH}")`, mobile: `${SCRIM}, url("${UNSPLASH}")` } } } }],
    });
    // base and the pinned primary (desktop) were only the photo: gone; mobile keeps its scrim.
    expect((result.nodes[0].props.style as Record<string, unknown>).backgroundImage).toEqual({ mobile: SCRIM });
  });

  it('counts an unusable background query as a placeholder', () => {
    const result = ok({ nodes: [{ type: 'section', props: { imageQuery: '<b>x</b>' } }] });
    expect(result.imageRequests).toEqual([]);
    expect(result.invalidImageQueries).toBe(1);
  });

  it('never accepts credit attributes on a container without an Unsplash background', () => {
    const result = ok({ nodes: [{ type: 'section', props: { ...credit, style: { backgroundColor: '#000' } } }] });
    expect(result.nodes[0].props).not.toHaveProperty('data-credit-name');
  });
});

describe('validateGeneration: aspect-ratio images', () => {
  it('an aspectRatio without a height overrides the preset height and shapes the photo', () => {
    const result = ok({
      nodes: [{ type: 'img', preset: 'image', props: { imageQuery: 'baker portrait', alt: 'B', style: { width: '100%', aspectRatio: '4 / 5' } } }],
    });
    const style = result.nodes[0].props.style as Record<string, unknown>;
    expect(style).toMatchObject({ width: '100%', aspectRatio: '4 / 5', height: 'auto', objectFit: 'cover' });
    expect(result.imageRequests[0]).toMatchObject({ kind: 'img', orientation: 'portrait' });
  });

  it('a height the model gave stays', () => {
    const result = ok({
      nodes: [{ type: 'img', props: { imageQuery: 'bread', alt: 'B', style: { width: '640px', height: '360px', aspectRatio: '16 / 9' } } }],
    });
    expect((result.nodes[0].props.style as Record<string, unknown>).height).toBe('360px');
    expect(result.imageRequests[0]).toMatchObject({ orientation: 'landscape', widthPx: 640 });
  });
});
