// The owner's notification address is a private form setting. The published page hands the form node to a CLIENT
// island, so whatever is on that node is serialized to every visitor: the address must be gone from it, and from the
// markup, while the stored form (what the submit endpoint reads) keeps it.

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel from '@/models/ProjectModel';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { readFormSettings } from '@/lib/forms/definition';
import { snapshotToComponentNode } from '../../server/snapshotToComponentNode';
import { renderPublishedPage } from '../../server/renderPublishedPage';
import FormIsland from '../FormIsland';

afterEach(cleanup);

const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;
const commerceRepo = {
  listProducts: async () => ({ products: [], total: 0 }),
  getProductByHandle: async () => null,
  listVariants: async () => [],
  getPrices: async () => [],
  getAvailability: async () => ({ variantId: 'x', locationId: 'all', availableQuantity: 0, stale: false }),
} as unknown as CommerceServerRepository;

const ADDRESS = 'owner-private@bakery.example';

/** Every element of a React tree, depth first. */
function elements(node: React.ReactNode, out: React.ReactElement[] = []): React.ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (React.isValidElement(node)) {
    out.push(node);
    elements((node.props as { children?: React.ReactNode }).children, out);
  }
  return out;
}

describe('the notification address of a published form', () => {
  it('is kept in the stored form, and never given to the client island or written to the markup', async () => {
    const project = ProjectModel.create({ id: 'proj', metadata: { title: 'Bakery' }, pages: {} });
    const page = project.createPage('Kontakt');
    const form = page.insertRegistryComponent('form', { kind: 'appTree' })!;
    form.setProps({ notifyEmail: ADDRESS });

    const adapted = snapshotToComponentNode(getSnapshot(page) as never, {});
    // What the submit endpoint reads (the stored snapshot) still has it.
    expect(JSON.stringify(adapted.root)).toContain(ADDRESS);
    expect(readFormSettings((adapted.root as ComponentNode).children?.[0]?.props as Record<string, unknown> | undefined)).toBeDefined();

    const { body } = await renderPublishedPage({
      root: adapted.root as ComponentNode,
      pageParams: {},
      cmsRepo,
      commerceRepo,
      breakpoints: adapted.breakpoints,
    });
    const islands = elements(body).filter((el) => el.type === FormIsland);
    expect(islands).toHaveLength(1);
    expect(JSON.stringify(islands[0].props)).not.toContain(ADDRESS);

    const { container } = render(<>{body}</>);
    expect(container.innerHTML).not.toContain(ADDRESS);
  });
});
