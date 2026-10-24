// The properties panel's Image section: fit and focal point for an img, and a
// container's photo background (URL, overlay, credit dropped on a new picture).

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ComponentModel, { ComponentTypeEnum } from '@/models/ComponentModel';
import { ImageSection, focalPointAt } from '../sections/ImageSection';
import { SECTION_MAP } from '../sectionConfig';

function img(style: Record<string, unknown> = {}) {
  return ComponentModel.create({
    id: 'img-1',
    type: 'img',
    componentType: ComponentTypeEnum.HOST,
    props: { src: 'https://example.com/a.jpg', alt: 'A', style: { objectFit: 'cover', ...style } },
  });
}

const CREDIT = {
  'data-credit-name': 'Ana',
  'data-credit-url': 'https://unsplash.com/@ana',
  'data-credit-source-url': 'https://unsplash.com/',
};

function section(style: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  return ComponentModel.create({
    id: 'sec-1',
    type: 'section',
    componentType: ComponentTypeEnum.HOST,
    props: { ...props, style },
  });
}

afterEach(cleanup);

describe('ImageSection registration', () => {
  it('shows for images and containers', () => {
    expect(SECTION_MAP.image).toContain('image');
    expect(SECTION_MAP.container).toContain('image');
    expect(SECTION_MAP.text).not.toContain('image');
  });
});

describe('ImageSection on an img', () => {
  it('sets the fit', () => {
    const c = img();
    render(<ImageSection component={c} />);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'contain' } });
    expect(c.props.style.objectFit).toBe('contain');
  });

  it('moves the focal point with the arrow keys from the current position', () => {
    const c = img({ objectPosition: 'center center' });
    render(<ImageSection component={c} />);
    const picker = screen.getByTestId('focal-point-picker');
    fireEvent.keyDown(picker, { key: 'ArrowLeft', shiftKey: true });
    expect(c.props.style.objectPosition).toBe('40% 50%');
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    expect(c.props.style.objectPosition).toBe('40% 51%');
    expect(picker.getAttribute('aria-label')).toContain('40% from the left');
  });

  it('falls back to the numbers when the preview cannot load', () => {
    const c = img();
    render(<ImageSection component={c} />);
    fireEvent.error(screen.getByTestId('focal-point-picker').querySelector('img')!);
    expect(screen.getByText(/could not be loaded for a preview/)).toBeTruthy();
  });

  it('maps a pointer position to percent of the image', () => {
    expect(focalPointAt({ left: 10, top: 20, width: 200, height: 100 }, 60, 95)).toEqual({ x: 25, y: 75 });
    expect(focalPointAt({ left: 0, top: 0, width: 100, height: 100 }, 500, -5)).toEqual({ x: 100, y: 0 });
    expect(focalPointAt({ left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toEqual({ x: 50, y: 50 });
  });
});

describe('ImageSection on a container', () => {
  const PHOTO = 'https://images.unsplash.com/photo-1?w=2400';
  const SCRIM = 'linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4))';

  it('adds a first photo that covers the box without tiling', () => {
    const c = section();
    render(<ImageSection component={c} />);
    fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'https://example.com/hero.jpg' } });
    expect(c.props.style).toMatchObject({
      backgroundImage: 'url("https://example.com/hero.jpg")',
      backgroundSize: 'cover',
      backgroundRepeat: 'no-repeat',
    });
  });

  it('keeps the scrim and drops a stock credit when the picture changes', () => {
    const c = section({ backgroundImage: `${SCRIM}, url("${PHOTO}")`, backgroundSize: 'cover' }, CREDIT);
    render(<ImageSection component={c} />);
    fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'https://example.com/own.jpg' } });
    expect(c.props.style.backgroundImage).toBe(`${SCRIM}, url("https://example.com/own.jpg")`);
    expect(c.props).not.toHaveProperty('data-credit-name');
  });

  it('keeps the credit when only the same photo size changes', () => {
    const c = section({ backgroundImage: `url("${PHOTO}")` }, CREDIT);
    render(<ImageSection component={c} />);
    fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'https://images.unsplash.com/photo-1?w=1200' } });
    expect(c.props['data-credit-name']).toBe('Ana');
  });

  it('sets the focal point as background-position', () => {
    const c = section({ backgroundImage: `url("${PHOTO}")`, backgroundPosition: '50% 50%' });
    render(<ImageSection component={c} />);
    fireEvent.keyDown(screen.getByTestId('focal-point-picker'), { key: 'ArrowUp', shiftKey: true });
    expect(c.props.style.backgroundPosition).toBe('50% 40%');
  });

  it('notes a custom gradient overlay', () => {
    const c = section({ backgroundImage: `linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent), url("${PHOTO}")` });
    render(<ImageSection component={c} />);
    expect(screen.getByText(/custom gradient/)).toBeTruthy();
  });

  it('renders nothing for a text element', () => {
    const c = ComponentModel.create({ id: 't', type: 'p', componentType: ComponentTypeEnum.HOST, props: { children: 'x' } });
    const { container } = render(<ImageSection component={c} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('ImageSection alt text', () => {
  const withAlt = (props: Record<string, unknown>) =>
    ComponentModel.create({
      id: 'img-2',
      type: 'img',
      componentType: ComponentTypeEnum.HOST,
      label: 'Photo',
      props: { src: 'https://example.com/team-dinner.jpg', style: {}, ...props },
    });

  it('warns about a missing or generic alt text and clears the warning once it describes the image', () => {
    const c = withAlt({ alt: 'Image' });
    render(<ImageSection component={c} />);
    expect(screen.getByTestId('alt-warning').textContent).toMatch(/generic alt text/);
    const field = screen.getByPlaceholderText('Two baristas pouring latte art');
    fireEvent.change(field, { target: { value: '' } });
    expect(screen.getByTestId('alt-warning').textContent).toMatch(/No alt text/);
    fireEvent.change(field, { target: { value: 'team-dinner' } });
    expect(screen.getByTestId('alt-warning').textContent).toMatch(/file name/);
    fireEvent.change(field, { target: { value: 'Our team at the summer dinner' } });
    expect(c.props.alt).toBe('Our team at the summer dinner');
    expect(screen.queryByTestId('alt-warning')).toBeNull();
  });

  it('marks an image decorative (empty alt, no warning) and back', () => {
    const c = withAlt({});
    render(<ImageSection component={c} />);
    expect(screen.getByTestId('alt-warning')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: /Decorative/ }));
    expect(c.props).toMatchObject({ alt: '', 'data-decorative': 'true' });
    expect(screen.queryByTestId('alt-warning')).toBeNull();
    expect(screen.queryByPlaceholderText('Two baristas pouring latte art')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /Decorative/ }));
    expect(c.props['data-decorative']).toBeUndefined();
    expect(screen.getByTestId('alt-warning').textContent).toMatch(/No alt text/);
  });
});
