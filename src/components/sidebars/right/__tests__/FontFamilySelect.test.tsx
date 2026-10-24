// The Typography font picker offers the self-hosted library grouped by
// category, keeps Inherit and the system stack, never offers Inter, writes the
// canonical stack, and keeps an unknown stored family selectable.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FONT_CATEGORIES, FONT_LIBRARY, SYSTEM_FONT_STACK, fontStack, getFontFamily } from '@/lib/fonts/registry';
import { FontFamilySelect, fontOptionValue } from '../primitives/FontFamilySelect';
import { SECTION_MAP } from '../sectionConfig';

afterEach(cleanup);

describe('FontFamilySelect', () => {
  it('lists every library family under its category, plus Inherit and System UI, and no Inter', () => {
    render(<FontFamilySelect value={undefined} onChange={() => {}} aria-label="Font" />);
    const select = screen.getByLabelText('Font') as HTMLSelectElement;
    const groups = [...select.querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups).toEqual(FONT_CATEGORIES.map((c) => c.label));
    for (const f of FONT_LIBRARY) {
      const option = [...select.options].find((o) => o.value === fontStack(f));
      expect(option?.textContent).toBe(f.displayName);
      expect((option?.parentElement as HTMLOptGroupElement).label).toBe(
        FONT_CATEGORIES.find((c) => c.id === f.category)!.label,
      );
    }
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels.slice(0, 2)).toEqual(['Inherit', 'System UI']);
    expect(labels.some((l) => /inter/i.test(l ?? ''))).toBe(false);
    expect(select.value).toBe('inherit');
  });

  it('writes the family with its fallback stack and previews the chosen face', () => {
    const onChange = vi.fn();
    const fraunces = fontStack(getFontFamily('fraunces')!);
    const { rerender } = render(<FontFamilySelect value={undefined} onChange={onChange} aria-label="Font" />);
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: fraunces } });
    expect(onChange).toHaveBeenCalledWith(fraunces);
    rerender(<FontFamilySelect value={fraunces} onChange={onChange} aria-label="Font" />);
    const preview = document.querySelector('[data-font-preview]') as HTMLElement;
    expect(preview.style.fontFamily).toContain('Fraunces');
  });

  it('selects a library family stored without its canonical stack, and keeps an unknown one as Custom', () => {
    expect(fontOptionValue('Fraunces, serif')).toBe(fontStack(getFontFamily('fraunces')!));
    expect(fontOptionValue(SYSTEM_FONT_STACK)).toBe(SYSTEM_FONT_STACK);
    // A bare or differently ordered system stack is the System UI option, not a "Custom" one.
    expect(fontOptionValue('system-ui')).toBe(SYSTEM_FONT_STACK);
    expect(fontOptionValue('-apple-system, BlinkMacSystemFont, sans-serif')).toBe(SYSTEM_FONT_STACK);
    render(<FontFamilySelect value="Inter, sans-serif" onChange={() => {}} aria-label="Font" />);
    const select = screen.getByLabelText('Font') as HTMLSelectElement;
    expect(select.value).toBe('Inter, sans-serif');
    expect(select.selectedOptions[0].textContent).toBe('Custom: Inter');
  });
});

describe('where the font picker shows', () => {
  it('on text and on containers (a section sets the body font its text inherits)', () => {
    expect(SECTION_MAP.text).toContain('typography');
    expect(SECTION_MAP.container).toContain('typography');
  });
});
