// DimensionInput tests.
// Asserts:
//   - parseStyleValue / formatStyleValue round-trip lengths, keywords and bare numbers.
//   - Typing + Enter / blur commits; a no-op blur emits nothing.
//   - Typing a unit ("2rem") switches to it; typing "auto" selects auto.
//   - The unit picker switches unit and keeps the number; keywords commit as-is.
//   - One unit renders a static suffix, no picker.
//   - An empty label renders no <label>; PropertyRow names the field instead.
//   - ArrowUp / ArrowDown step by `step`, Shift x10, clamped to min / max.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { DimensionInput, parseStyleValue, formatStyleValue } from '../primitives/DimensionInput';
import { PropertyRow } from '../primitives/PropertyRow';

afterEach(cleanup);

type Props = React.ComponentProps<typeof DimensionInput>;

/** Feeds each committed value back in as the new value, like the MST store does. */
function Controlled({ onChange, value: initial, ...rest }: Props) {
  const [value, setValue] = React.useState(initial);
  return (
    <DimensionInput
      {...rest}
      value={value}
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
    />
  );
}

function renderInput(props: Partial<Props> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <Controlled label="Width" value="10px" onChange={onChange} {...props} />,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  return { ...utils, onChange, input };
}

describe('parseStyleValue / formatStyleValue', () => {
  it.each([
    ['10px', { value: 10, unit: 'px' }],
    ['50%', { value: 50, unit: '%' }],
    ['-1.5rem', { value: -1.5, unit: 'rem' }],
    ['auto', { value: undefined, unit: 'auto' }],
    ['none', { value: undefined, unit: 'none' }],
    ['', { value: undefined, unit: 'px' }],
    [12, { value: 12, unit: 'px' }],
    ['12', { value: 12, unit: 'px' }],
    ['calc(100% - 4px)', { value: undefined, unit: 'px' }],
  ])('parses %j', (raw, expected) => {
    expect(parseStyleValue(raw as string | number)).toEqual(expected);
  });

  it('gives bare numbers the bare unit (unitless line-height)', () => {
    expect(parseStyleValue('1.5', '')).toEqual({ value: 1.5, unit: '' });
    expect(parseStyleValue(1.5, '')).toEqual({ value: 1.5, unit: '' });
    expect(parseStyleValue('24px', '')).toEqual({ value: 24, unit: 'px' });
  });

  it('formats values and keywords', () => {
    expect(formatStyleValue(10, 'px')).toBe('10px');
    expect(formatStyleValue(1.5, '')).toBe('1.5');
    expect(formatStyleValue(undefined, 'px')).toBe('');
    expect(formatStyleValue(5, 'auto')).toBe('auto');
    expect(formatStyleValue(5, 'none')).toBe('none');
  });
});

describe('DimensionInput commit', () => {
  it('commits a typed number with the current unit on Enter', () => {
    const { input, onChange } = renderInput();
    fireEvent.change(input, { target: { value: '24' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('24px');
  });

  it('commits on blur', () => {
    const { input, onChange } = renderInput();
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('30px');
  });

  it('emits nothing when blurring an unchanged value', () => {
    const { input, onChange } = renderInput();
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the property when the field is emptied', () => {
    const { input, onChange } = renderInput();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('switches to a typed unit the field offers', () => {
    const { input, onChange } = renderInput({ units: ['px', 'rem'] });
    fireEvent.change(input, { target: { value: '2rem' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('2rem');
  });

  it('accepts "auto" typed into the field when auto is offered', () => {
    const { input, onChange } = renderInput();
    fireEvent.change(input, { target: { value: 'auto' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('restores the stored value when the text is not a number', () => {
    const { input, onChange } = renderInput();
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('10');
  });

  it('keeps a unitless value unitless', () => {
    const { input, onChange } = renderInput({ value: '1.5', units: ['', 'px', 'em'] });
    expect(input.value).toBe('1.5');
    fireEvent.change(input, { target: { value: '1.6' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('1.6');
  });
});

describe('DimensionInput unit picker', () => {
  it('switches unit and keeps the number', () => {
    const { onChange } = renderInput();
    fireEvent.change(screen.getByLabelText('Width unit'), { target: { value: '%' } });
    expect(onChange).toHaveBeenCalledWith('10%');
  });

  it('switching to auto commits "auto" and disables the number', () => {
    const { input, onChange } = renderInput();
    fireEvent.change(screen.getByLabelText('Width unit'), { target: { value: 'auto' } });
    expect(onChange).toHaveBeenCalledWith('auto');
    expect(input.disabled).toBe(true);
  });

  it('renders auto as a disabled empty field with an "auto" placeholder', () => {
    const { input } = renderInput({ value: 'auto' });
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('auto');
  });

  it('lists a stored unit the field does not offer so it stays selected', () => {
    renderInput({ value: '2em', units: ['px', '%'] });
    const select = screen.getByLabelText('Width unit') as HTMLSelectElement;
    expect(select.value).toBe('em');
  });

  it('renders a single unit as a static suffix, not a picker', () => {
    renderInput({ units: ['px'] });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('px')).toBeTruthy();
  });
});

describe('DimensionInput labelling', () => {
  it('renders its label when given one', () => {
    const { container, input } = renderInput();
    const label = container.querySelector('label');
    expect(label?.textContent).toBe('Width');
    expect(label?.getAttribute('for')).toBe(input.id);
  });

  it('renders no <label> element when the label is empty', () => {
    const { container } = renderInput({ label: '' });
    expect(container.querySelector('label')).toBeNull();
  });

  it('takes its accessible name from the surrounding PropertyRow', () => {
    render(
      <PropertyRow label="Gap">
        <DimensionInput label="" value="8px" onChange={() => {}} units={['px', 'rem']} />
      </PropertyRow>,
    );
    expect(screen.getByLabelText('Gap')).toBe(screen.getByRole('textbox'));
    expect(screen.getByLabelText('Gap unit')).toBeTruthy();
  });

  it('uses aria-label for a field in a grouped row', () => {
    render(
      <PropertyRow label="Size" group>
        <DimensionInput label="" aria-label="Width" prefix="W" value="10px" onChange={() => {}} />
      </PropertyRow>,
    );
    expect(screen.getByRole('group', { name: 'Size' })).toBeTruthy();
    expect(screen.getByLabelText('Width')).toBe(screen.getByRole('textbox'));
  });
});

describe('DimensionInput arrow stepping', () => {
  it('ArrowUp / ArrowDown step by 1', () => {
    const { input, onChange } = renderInput();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('11px');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('10px');
  });

  it('Shift steps by 10', () => {
    const { input, onChange } = renderInput();
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith('20px');
  });

  it('clamps to min and max', () => {
    const { input, onChange } = renderInput({ value: '5px', min: 0, max: 12 });
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith('0px');
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith('10px');
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith('12px');
  });

  it('rounds away float noise on fractional steps', () => {
    const { input, onChange } = renderInput({ value: '0.2em', units: ['em'], step: 0.1 });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('0.3em');
  });
});
