// The Google Map in the editor: the registry drop, its panel section, and the
// canvas drawing. The panel stores only a rebuilt embed address and says why it
// refuses one; the canvas never loads the map.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import { createComponentElement } from '@/lib/renderer/createComponentElement';
import { isMapEmbed } from '@/lib/mapEmbed/mapEmbed';
import { SECTION_MAP, getComponentCategory } from '../sectionConfig';

let currentProject: ProjectModelType | null = null;
vi.mock('@/hooks/useStore', () => ({
  useStore: () => ({ editorUI: { currentProject } }),
}));

import { MapEmbedSection } from '../sections/MapEmbedSection';

const SHARE = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2419.6!2d13.2834!3d52.6871!5e0';

afterEach(() => {
  cleanup();
  currentProject = null;
});

function setup() {
  const project = ProjectModel.create({ id: 'proj', metadata: { title: 'Werkstatt' }, pages: {} });
  const home = project.createPage('Home');
  home.setSlug('');
  const box = home.insertRegistryComponent('mapEmbed', { kind: 'appTree' })!;
  currentProject = project;
  return { project, box };
}

const props = (box: { props: unknown }) => box.props as Record<string, unknown>;

describe('the Google Map in the editor', () => {
  it('arrives as a marked box without a sample address, with its section first', () => {
    const { box } = setup();
    expect(isMapEmbed(box.props)).toBe(true);
    expect(props(box)).not.toHaveProperty('mapAddress');
    expect(getComponentCategory(box)).toBe('mapEmbed');
    expect(SECTION_MAP.mapEmbed[0]).toBe('mapEmbed');
    expect(SECTION_MAP.mapEmbed).not.toContain('layout');
  });

  it('stores the rebuilt address of pasted embed code, and refuses another host with the reason', () => {
    const { box } = setup();
    render(<MapEmbedSection component={box} />);
    const embed = screen.getByPlaceholderText(/maps\/embed/);
    fireEvent.change(embed, { target: { value: `<iframe src="${SHARE}" width="600"></iframe>` } });
    expect(props(box).mapUrl).toBe(SHARE);
    fireEvent.change(embed, { target: { value: 'https://evil.test/maps/embed?pb=x' } });
    expect(screen.getByRole('alert').textContent).toMatch(/Only Google Maps/);
    expect(props(box).mapUrl).toBe(SHARE);
    fireEvent.change(embed, { target: { value: '' } });
    expect(props(box).mapUrl).toBeUndefined();
  });

  it('keeps the address and the title as typed, reads them cleaned, and says when there is no map', () => {
    const { box } = setup();
    render(<MapEmbedSection component={box} />);
    expect(screen.getByText(/the box shows no map/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Hauptstraße 1, 10115 Berlin'), { target: { value: '  Am   Markt 3, Bernau ' } });
    // Kept as typed, so a space mid-word survives; the renderers read it cleaned.
    expect(props(box).mapAddress).toBe('  Am   Markt 3, Bernau ');
    expect(screen.queryByText(/the box shows no map/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Map: Am Markt 3, Bernau'), { target: { value: 'Our workshop' } });
    expect(props(box).mapTitle).toBe('Our workshop');
  });

  it('draws the placeholder on the canvas and never a frame', () => {
    const { box } = setup();
    box.setProps({ mapUrl: SHARE, mapAddress: 'Bernau' });
    const markup = renderToStaticMarkup(<>{createComponentElement(box, props(box), [], undefined, { mode: 'editor' } as never)}</>);
    expect(markup).not.toContain('<iframe');
    expect(markup).toContain('Bernau');
    expect(markup).toContain('loads after consent');
  });
});
