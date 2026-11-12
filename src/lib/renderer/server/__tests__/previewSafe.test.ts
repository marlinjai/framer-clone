// What a page loses when it is rendered as a branch's public preview (src/lib/renderer/server/previewSafe.ts).

import { describe, expect, it } from 'vitest';
import { MAP_EMBED_ATTR, MAP_EMBED_MARKER } from '@/lib/mapEmbed/mapEmbed';
import { PREVIEW_MAP_NOTICE, previewSafeTree } from '../previewSafe';

describe('previewSafeTree', () => {
  it('drops what would hand the address to another site or send something there, in any letter case, at any depth', () => {
    const tree = {
      type: 'div',
      props: { id: 'root' },
      children: [
        { type: 'img', props: { src: 'https://elsewhere.example/x.png', referrerPolicy: 'unsafe-url', alt: 'x' } },
        { type: 'a', props: { href: 'https://elsewhere.example', referrerpolicy: 'origin', ping: 'https://tracker.example/p' } },
        {
          type: 'form',
          props: { action: 'https://newsletter.example/subscribe', method: 'post', className: 'f' },
          children: [{ type: 'button', props: { type: 'submit', formAction: 'https://other.example/x', children: 'Join' } }],
        },
      ],
    };
    const safe = previewSafeTree(tree);
    expect(safe.children[0].props).toEqual({ src: 'https://elsewhere.example/x.png', alt: 'x' });
    expect(safe.children[1].props).toEqual({ href: 'https://elsewhere.example' });
    expect(safe.children[2].props).toEqual({ method: 'post', className: 'f' });
    expect(safe.children[2].children![0].props).toEqual({ type: 'submit', children: 'Join' });
    const text = JSON.stringify(safe);
    for (const gone of ['newsletter.example', 'tracker.example', 'other.example', 'unsafe-url']) expect(text).not.toContain(gone);
    // The input is untouched.
    expect(tree.children[2].props.action).toBe('https://newsletter.example/subscribe');
  });

  it('puts a note where a map would load a frame of another company\'s, keeping the box\'s look', () => {
    const tree = {
      type: 'div',
      children: [{ type: 'div', props: { [MAP_EMBED_ATTR]: MAP_EMBED_MARKER, mapQuery: 'Bakery, Berlin', style: { height: '320px' }, className: 'c1' }, children: [] }],
    };
    const map = previewSafeTree(tree).children[0] as { type: string; props: Record<string, unknown>; children: Array<{ props: { children: string } }> };
    expect(map.props).toEqual({ style: { height: '320px' }, className: 'c1', role: 'note' });
    expect(map.children[0].props.children).toBe(PREVIEW_MAP_NOTICE);
    expect(JSON.stringify(map)).not.toContain('Bakery, Berlin');
  });

  it('returns the very same tree when nothing has to go', () => {
    const tree = { type: 'div', props: { id: 'a' }, children: [{ type: 'p', props: { children: 'Hello' } }] };
    expect(previewSafeTree(tree)).toBe(tree);
  });
});
