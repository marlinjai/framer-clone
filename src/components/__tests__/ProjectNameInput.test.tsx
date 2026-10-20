// ProjectNameInput, kept mounted after Escape so the blur that follows really
// reaches React: proves the "settle once" guard, not just an unmounted node.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import ProjectNameInput from '../ProjectNameInput';

afterEach(() => cleanup());

function setup(initialName = 'Old') {
  const onSubmit = vi.fn();
  const onCancel = vi.fn(); // does NOT unmount the field
  render(<ProjectNameInput initialName={initialName} onSubmit={onSubmit} onCancel={onCancel} />);
  const input = screen.getByRole('textbox', { name: 'Project name' }) as HTMLInputElement;
  return { input, onSubmit, onCancel };
}

describe('ProjectNameInput', () => {
  it('focuses and selects the current name', () => {
    const { input } = setup('Framer Clone Demo');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Framer Clone Demo'.length);
  });

  it('Escape then blur cancels once and never submits', () => {
    const { input, onSubmit, onCancel } = setup();
    fireEvent.change(input, { target: { value: 'Changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter then blur submits exactly once, trimmed', () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: '  New  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('New');
  });

  it('a refused name can be fixed and then submitted', () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert').textContent).toBe('A project needs a name.');
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    fireEvent.change(input, { target: { value: 'Fixed' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('Fixed');
  });

  it('Escape does not bubble to surrounding handlers', () => {
    const outer = vi.fn();
    const onCancel = vi.fn();
    render(
      <div onKeyDown={outer}>
        <ProjectNameInput initialName="x" onSubmit={vi.fn()} onCancel={onCancel} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });
});
