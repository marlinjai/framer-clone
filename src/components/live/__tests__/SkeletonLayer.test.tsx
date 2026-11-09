// SkeletonLayer.tsx: where skeletons stand among the page root's children, the
// narrow layout per breakpoint, and that a section is static, plain-text and
// keyed so a replace keeps it.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  isNarrowBreakpoint,
  SKELETON_ATTR,
  SKELETON_LEAVING_ATTR,
  SkeletonGroupView,
  skeletonGroups,
  SkeletonSection,
  withSkeletons,
  type SkeletonGroup,
} from '../SkeletonLayer';
import { PLAN_SECTION_KINDS, type LivePlan } from '@/lib/projects/liveEvents';

const section = (ref: string, title = ref) => ({ ref, title, kind: 'generic' as const });
const plan = (over: Partial<LivePlan>): LivePlan => ({ planId: 'p', agentId: 'agent-a', label: 'Claude', pageId: 'home', sections: [], expiresAt: '', ...over });

describe('skeletonGroups', () => {
  it('groups by anchor in plan order, and an after that is not a top-level section draws nothing', () => {
    const groups = skeletonGroups(
      [
        { plan: plan({ planId: 'a', after: 'title' }), leaving: false, sections: [section('hero')] },
        { plan: plan({ planId: 'b' }), leaving: false, sections: [section('faq')] },
        { plan: plan({ planId: 'c', agentId: 'agent-b', after: 'title' }), leaving: true, sections: [section('team')] },
        { plan: plan({ planId: 'd', after: 'deleted' }), leaving: false, sections: [section('gone')] },
      ],
      ['title', 'about'],
    );
    expect(groups.map((g) => [g.after, g.items.map((i) => `${i.agentId}:${i.section.ref}:${i.leaving}`)])).toEqual([
      ['title', ['agent-a:hero:false', 'agent-b:team:true']],
      [undefined, ['agent-a:faq:false']],
    ]);
  });
});

describe('withSkeletons', () => {
  const child = (key: string) => <div key={key} data-id={key} />;
  const tag = (g: SkeletonGroup) => <i key={`s:${g.after ?? 'end'}`} data-after={g.after ?? 'end'} />;
  const order = (nodes: React.ReactNode[]) =>
    nodes.map((n) => (React.isValidElement(n) ? String((n.props as Record<string, unknown>)['data-id'] ?? `skeleton:${(n.props as Record<string, unknown>)['data-after']}`) : '?'));

  it('splices a group after the last copy of its section, the end group last', () => {
    const groups: SkeletonGroup[] = [{ after: 'a', items: [] }, { items: [] }];
    expect(order(withSkeletons([child('a__0'), child('a__1'), child('b')], groups, tag))).toEqual(['a__0', 'a__1', 'skeleton:a', 'b', 'skeleton:end']);
    expect(withSkeletons([child('a')], [], tag)).toHaveLength(1);
  });
});

describe('isNarrowBreakpoint', () => {
  const bps = [
    { id: 'desktop', minWidth: 1024 },
    { id: 'tablet', minWidth: 768 },
    { id: 'mobile', minWidth: 0 },
  ];
  it('stacks only on the breakpoint whose widths stay at or below the tablet width', () => {
    expect(bps.map((b) => isNarrowBreakpoint(b.id, bps))).toEqual([false, false, true]);
    expect(isNarrowBreakpoint('unknown', bps)).toBe(false);
  });
});

describe('a skeleton section', () => {
  it('shows its title as plain text, is hidden from assistive technology and carries its key', () => {
    const { container } = render(<SkeletonSection agentId="agent-a" section={{ ref: 'hero', title: '<img src=x onerror=alert(1)>', kind: 'hero' }} narrow={false} leaving={false} />);
    const el = container.querySelector(`[${SKELETON_ATTR}]`)!;
    expect(el.getAttribute(SKELETON_ATTR)).toBe('agent-a:hero');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(el.hasAttribute(SKELETON_LEAVING_ATTR)).toBe(false);
  });

  it('draws every kind without animation of its own', () => {
    for (const kind of PLAN_SECTION_KINDS) {
      for (const narrow of [false, true]) {
        const { container, unmount } = render(<SkeletonSection agentId="a" section={{ ref: 'r', title: kind, kind }} narrow={narrow} leaving />);
        expect(container.innerHTML).not.toMatch(/animation|shimmer|pulse/);
        expect(container.querySelector(`[${SKELETON_LEAVING_ATTR}]`)).not.toBeNull();
        unmount();
      }
    }
  });

  it('a replace keeping the ref keeps the same element (keyed by agent and ref, never by plan)', () => {
    const bps = [{ id: 'desktop', minWidth: 1024 }];
    const view = (title: string) => <SkeletonGroupView group={{ items: [{ agentId: 'agent-a', section: { ref: 'hero', title, kind: 'hero' }, leaving: false }] }} breakpointId="desktop" allBreakpoints={bps} />;
    const { container, rerender } = render(view('Hero'));
    const before = container.querySelector(`[${SKELETON_ATTR}]`);
    rerender(view('Hero again'));
    expect(container.querySelector(`[${SKELETON_ATTR}]`)).toBe(before);
  });
});

describe('the skeleton title', () => {
  it('sits on its own light chip, so it reads on a dark frame too', () => {
    const { getByText } = render(<SkeletonSection agentId="agent-a" section={section('pricing', 'Pricing')} narrow={false} leaving={false} />);
    const title = getByText('Pricing');
    expect(title.style.background).toBe('rgba(255, 255, 255, 0.92)');
    expect(title.style.color).toBe('rgb(64, 64, 64)');
    // A long title wraps (a skeleton takes no pointer, so no tooltip could show the rest).
    expect(title.style.whiteSpace).toBe('normal');
  });
});
