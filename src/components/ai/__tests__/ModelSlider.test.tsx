import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelSlider } from '../ModelSlider';
import type { ModelChoice } from '@/lib/ai/modelChoice';

afterEach(() => cleanup());

function Harness({ initial = 'SONNET' as ModelChoice, onChange = vi.fn() }) {
  const [value, setValue] = React.useState<ModelChoice>(initial);
  return (
    <ModelSlider
      id="t"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('ModelSlider', () => {
  it('is a labelled three-step slider that reads out the model name', () => {
    render(<Harness />);
    const slider = screen.getByRole('slider', { name: 'Model' });
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '2');
    expect(slider).toHaveAttribute('step', '1');
    expect(slider).toHaveValue('1');
    expect(slider).toHaveAttribute('aria-valuetext', 'Balanced: Claude Sonnet 5.5');
    expect(slider).toHaveAccessibleDescription(/standard cost/);
  });

  it('moves between steps and updates the hint', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Model' });
    fireEvent.change(slider, { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith('OPUS');
    expect(slider).toHaveAttribute('aria-valuetext', 'Best: Claude Opus 5.5');
    expect(screen.getByText(/2x the Balanced cost/)).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith('HAIKU');
    expect(screen.getByText(/1\/20 of the Balanced cost/)).toBeInTheDocument();
  });

  it('can be disabled', () => {
    render(<ModelSlider id="d" value="OPUS" onChange={vi.fn()} disabled />);
    expect(screen.getByRole('slider')).toBeDisabled();
  });
});
