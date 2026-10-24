// A form through the REAL publish pipeline: an editor project with a dropped
// Form preset, saved as a page snapshot, adapted (snapshotToComponentNode),
// hydrated (hydrateBindings), its responsive styles moved to the stylesheet
// (applyResponsiveStyles) and rendered (renderComponentNode). The published
// markup must be a working, accessible form, with the form configuration
// never reaching the DOM and the field styles kept.

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel from '@/models/ProjectModel';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { snapshotToComponentNode } from '../../server/snapshotToComponentNode';
import { renderPublishedPage } from '../../server/renderPublishedPage';

afterEach(cleanup);

const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;
const commerceRepo = {
  listProducts: async () => ({ products: [], total: 0 }),
  getProductByHandle: async () => null,
  listVariants: async () => [],
  getPrices: async () => [],
  getAvailability: async () => ({ variantId: 'x', locationId: 'all', availableQuantity: 0, stale: false }),
} as unknown as CommerceServerRepository;

describe('a dropped Form, published', () => {
  it('renders a POST form with labelled controls, a submit button, its styles, and no config in the DOM', async () => {
    const project = ProjectModel.create({ id: 'proj', metadata: { title: 'Bakery' }, pages: {} });
    const page = project.createPage('Kontakt');
    const form = page.insertRegistryComponent('form', { kind: 'appTree' })!;
    // A responsive value on a field and on the button, as the panel writes them.
    const breakpointId = page.viewportNodes[0]?.breakpointId as string;
    const mobileId = page.viewportNodes[page.viewportNodes.length - 1]?.breakpointId as string;
    form.children[1].updateResponsiveStyle('fontSize', '18px', breakpointId);
    form.children[1].updateResponsiveStyle('fontSize', '15px', mobileId);
    form.children[4].updateResponsiveStyle('padding', '16px 24px', breakpointId);

    const adapted = snapshotToComponentNode(getSnapshot(page) as never);
    const { body } = await renderPublishedPage({
      root: adapted.root as ComponentNode,
      pageParams: {},
      cmsRepo,
      commerceRepo,
      breakpoints: adapted.breakpoints,
    });
    const { container } = render(<>{body}</>);

    const formEl = container.querySelector('form')!;
    expect(formEl).not.toBeNull();
    expect(formEl.getAttribute('method')).toBe('post');
    expect(formEl.getAttribute('action')).toBe('/api/forms/submit');
    expect((container.querySelector('input[name="_form"]') as HTMLInputElement).value).toBe(form.id);

    const email = screen.getByLabelText(/^Email/) as HTMLInputElement;
    expect(email.type).toBe('email');
    expect(email.name).toBe('email');
    expect(email.required).toBe(true);
    expect((screen.getByLabelText(/^Message/) as HTMLTextAreaElement).tagName).toBe('TEXTAREA');
    expect((screen.getByLabelText(/I agree/) as HTMLInputElement).type).toBe('checkbox');
    const submit = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(submit.type).toBe('submit');

    // A responsive field moves ALL its styles into its stylesheet class (as any
    // published node does); the wrapper carries that class, the rule its styles.
    const emailWrapper = email.closest('[data-form-field]') as HTMLElement;
    const fieldClass = [...emailWrapper.classList].find((c) => c.startsWith('fc-'));
    expect(fieldClass).toBeTruthy();
    const css = [...container.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    expect(css).toContain(`.${fieldClass}`);
    expect(css).toMatch(/width:\s*100%/);
    expect(css).toMatch(/font-size:\s*15px/);
    // A button with only plain values keeps its inline style across the island boundary.
    expect(submit.getAttribute('style') ?? '').toMatch(/background-color:\s*(#111827|rgb\(17, 24, 39\))/);
    expect(submit.getAttribute('style') ?? '').toContain('16px 24px');

    for (const leaked of ['formName', 'successMessage', 'data-form-kind', 'fieldType', 'loadingLabel']) {
      expect(container.innerHTML).not.toContain(leaked);
    }
  });
});
