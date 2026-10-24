// Lenis smooth scrolling: the site setting (off by default, normalized),
// the switch in Site settings, and the runtime wiring (anchors kept, the
// preview frame as wrapper, never under reduced motion, destroyed on cleanup).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import { DEFAULT_SITE_SETTINGS, normalizeSiteSettings } from '@/lib/site/siteSettings';

const lenisCtor = vi.fn();
const lenisDestroy = vi.fn();
vi.mock('lenis', () => ({
  default: class {
    constructor(options: unknown) {
      lenisCtor(options);
    }
    destroy() {
      lenisDestroy();
    }
  },
}));

let project: ProjectModelType | undefined;
vi.mock('@/hooks/useStore', () => ({
  useStore: () => ({
    editorUI: {
      get currentProject() {
        return project;
      },
    },
  }),
}));

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  lenisCtor.mockClear();
  lenisDestroy.mockClear();
  window.matchMedia = ((q: string) => ({
    matches: q.includes('reduce') ? reducedMotion : false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const flush = () => new Promise(r => setTimeout(r, 0));

describe('the site setting', () => {
  it('is off by default and only true when stored as true', () => {
    expect(DEFAULT_SITE_SETTINGS.smoothScroll).toBe(false);
    expect(normalizeSiteSettings({}).smoothScroll).toBe(false);
    expect(normalizeSiteSettings({ smoothScroll: 'yes' }).smoothScroll).toBe(false);
    expect(normalizeSiteSettings({ smoothScroll: true }).smoothScroll).toBe(true);
  });

  it('is switched on in Site settings and saved with the rest', async () => {
    const { default: SiteSettingsButton } = await import('@/components/site/SiteSettingsDialog');
    project = ProjectModel.create({ id: 'site_1', metadata: { title: 'Bakery' }, pages: {} });
    project.createPage('Home').setSlug('');
    render(<SiteSettingsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Site settings' }));
    const dialog = screen.getByTestId('site-settings-dialog');
    const toggle = within(dialog).getByRole('switch', { name: 'Smooth scrolling' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(project.site.smoothScroll).toBe(true);
  });
});

describe('startSmoothScroll', () => {
  it('starts Lenis with anchors kept and the given wrapper, and destroys it', async () => {
    const { startSmoothScroll } = await import('../smoothScroll');
    const wrapper = document.createElement('div');
    const content = document.createElement('div');
    const stop = startSmoothScroll({ wrapper, content });
    await flush();
    expect(lenisCtor).toHaveBeenCalledWith(expect.objectContaining({ wrapper, content, anchors: true, autoRaf: true }));
    stop();
    expect(lenisDestroy).toHaveBeenCalled();
  });

  it('never starts under reduced motion', async () => {
    reducedMotion = true;
    const { startSmoothScroll } = await import('../smoothScroll');
    startSmoothScroll();
    await flush();
    expect(lenisCtor).not.toHaveBeenCalled();
  });

  it('a cleanup before the import resolves leaves nothing running', async () => {
    const { startSmoothScroll } = await import('../smoothScroll');
    const stop = startSmoothScroll();
    stop();
    await flush();
    expect(lenisCtor).not.toHaveBeenCalled();
  });
});
