// The Link component in the editor: a dropped link gets the Link section
// first, its target is checked as it is typed (an unsafe one never reaches
// the prop), a page can be picked, and the product page path the project
// works out drives what `{{product.href}}` says.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import { SECTION_MAP, getComponentCategory } from '../sectionConfig';

let currentProject: ProjectModelType | null = null;
vi.mock('@/hooks/useStore', () => ({
  useStore: () => ({ editorUI: { currentProject } }),
}));

import { LinkSection, linkTargetError } from '../sections/LinkSection';

afterEach(() => {
  cleanup();
  currentProject = null;
});

function setup() {
  const project = ProjectModel.create({ id: 'proj', metadata: { title: 'Shop' }, pages: {} });
  const home = project.createPage('Home');
  home.setSlug('');
  const contact = project.createPage('Contact');
  contact.setSlug('contact');
  const link = home.insertRegistryComponent('link', { kind: 'appTree' })!;
  currentProject = project;
  const provider = new InMemoryDataSourceProvider({ collections: [], rows: {} });
  render(
    <DataSourceProviderContext.Provider value={provider}>
      <LinkSection component={link} />
    </DataSourceProviderContext.Provider>,
  );
  return { project, link };
}

const hrefOf = (link: { props: unknown }) => (link.props as Record<string, unknown>).href;

describe('the Link section', () => {
  it('is the first section of a link', () => {
    const { link } = setup();
    expect(link.type).toBe('a');
    expect(getComponentCategory(link)).toBe('link');
    expect(SECTION_MAP.link[0]).toBe('link');
  });

  it('takes a safe target as it is typed and refuses an unsafe one', () => {
    const { link } = setup();
    const field = screen.getByLabelText('Link target');
    fireEvent.change(field, { target: { value: 'https://example.com/book' } });
    expect(hrefOf(link)).toBe('https://example.com/book');

    fireEvent.change(field, { target: { value: 'javascript:alert(1)' } });
    expect(hrefOf(link)).toBe('https://example.com/book');
    expect(screen.getByRole('alert').textContent).toContain('Use a page path');
  });

  it('links to a page picked from the list', () => {
    const { project, link } = setup();
    const contact = project.pagesArray.find((p) => p.slug === 'contact')!;
    fireEvent.change(screen.getByRole('combobox'), { target: { value: contact.id } });
    expect(hrefOf(link)).toBe('/contact');
  });

  it('explains an empty target', () => {
    expect(linkTargetError('  ')).toContain('Add a link');
    expect(linkTargetError('/contact')).toBeNull();
  });
});

describe('the product page path of a project', () => {
  it('follows the product page, and is null without one', () => {
    const project = ProjectModel.create({ id: 'proj', metadata: { title: 'Shop' }, pages: {} });
    const home = project.createPage('Home');
    home.setSlug('');
    expect(project.productPagePath).toBeNull();
    const productPage = project.createPage('Product');
    productPage.setSlug('products/:handle');
    expect(project.productPagePath).toBe('/products');
  });
});
