// How large a save body is for a realistic project (fourth review): a generated
// page of six sections plus three more pages. A body above the keepalive limit
// cannot be finished by the browser after the page is gone, so such a project
// relies on the unload warning (which mobile Safari does not show). The number
// measured here (about 34 KB) is recorded in docs/plans/2026-11-04-editor-autosave.md.
import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore } from '@/stores/RootStore';
import { getHistoryStore } from '@/stores/RootStore';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { applyResult, captureTarget } from '@/lib/ai/pageGen/editorBridge';
import { KEEPALIVE_BODY_MAX_BYTES } from '../projectWrite';

const section = (label: string, heading: string, paragraphs: number, buttons = 1) => ({
  type: 'section',
  label,
  props: { style: { padding: { base: '96px 48px', mobile: '48px 20px' }, display: 'flex', flexDirection: 'column', gap: '24px', backgroundColor: '#faf7f2' } },
  children: [
    { type: 'h2', props: { children: heading, style: { fontSize: { base: '44px', mobile: '30px' }, fontWeight: '700', color: '#1f1a14' } } },
    ...Array.from({ length: paragraphs }, (_, i) => ({
      type: 'p',
      props: {
        children: `${heading}: a paragraph of real copy about the bakery, the flour from a mill nearby, the long fermentation and the people who bake every morning before six (${i + 1}).`,
        style: { fontSize: '18px', lineHeight: '1.6', color: '#4a4036', maxWidth: '640px' },
      },
    })),
    ...Array.from({ length: buttons }, (_, i) => ({ type: 'a', props: { href: '/menu', children: `See the menu ${i + 1}`, style: { padding: '14px 28px', borderRadius: '999px', backgroundColor: '#1f1a14', color: '#fff' } } })),
  ],
});

describe('the save body of a realistic project', () => {
  it('a generated six-section page plus three pages', () => {
    const store = createRootStore();
    store.projectStore.createProject('Crumb & Hearth');
    const project = store.projectStore.findProjectByTitle('Crumb & Hearth')!;
    const home = project.findPageBySlug('') ?? project.createPage('Home');
    store.editorUI.setCurrentProject(project);
    store.editorUI.setCurrentPage(home);
    for (const title of ['About', 'Menu', 'Contact']) project.createPage(title);
    getHistoryStore()?.clear();
    const target = captureTarget('newPage', home, undefined);
    const raw = {
      title: 'Crumb & Hearth Bakery',
      nodes: [
        section('Hero', 'Bread worth waking up for', 2, 2),
        section('Story', 'Our story', 3),
        section('Menu', 'What we bake', 4),
        section('Process', 'Slow dough, honest bread', 3),
        section('Visit', 'Visit us', 2),
        section('Footer', 'Crumb & Hearth', 1, 0),
      ],
    };
    const out = validateGeneration(raw, { breakpoints: deriveBreakpointKeys(target.breakpoints.map(({ label, minWidth }) => ({ label, minWidth }))) });
    if (!out.ok) throw new Error(out.errors.join('; '));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { imageRequests, ...result } = out.result;
    const applied = applyResult(project, target, { generationId: 'g', model: 'm', ...result, images: { requested: 0, resolved: 0, fellBack: {}, credits: [] } });
    expect(applied.ok).toBe(true);
    const body = JSON.stringify({ project: getSnapshot(project), expectedVersion: 3, requestKey: '00000000-0000-4000-8000-000000000000' });
    const bytes = new Blob([body]).size;
    const pages = Object.keys((getSnapshot(project) as { pages: Record<string, unknown> }).pages).length;
    expect(pages).toBe(5);
    // Recorded in the plan: about 34 KB (33,578 bytes on 2026-11-05), inside the
    // 60 KB keepalive budget with room for roughly as much again. A project about
    // twice this size or more relies on the unload warning.
    expect(bytes).toBeGreaterThan(20 * 1024);
    expect(bytes).toBeLessThan(KEEPALIVE_BODY_MAX_BYTES);
  });
});
