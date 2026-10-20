// The editor's top-bar rename (EditableProjectTitle): click the project name,
// Enter / blur save, Escape cancels, empty is refused with a message, a failed
// save rolls the name back and says why, the tab title follows the name, and
// the rename never becomes an undo step.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react';
import ProjectModel from '@/models/ProjectModel';

const runUntracked = vi.fn(<T,>(fn: () => T): T => fn());
vi.mock('@/stores/RootStore', () => ({
  getHistoryStore: () => ({ runUntracked }),
}));

import EditableProjectTitle from '../EditableProjectTitle';

function makeProject(title = 'Framer Clone Demo') {
  return ProjectModel.create({ id: 'site_1', metadata: { title, description: '' }, pages: {} });
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  runUntracked.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ok(name: string) {
  return new Response(JSON.stringify({ siteId: 'site_1', name }), { status: 200 });
}

function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: /rename project/i }));
  return screen.getByRole('textbox', { name: 'Project name' }) as HTMLInputElement;
}

describe('EditableProjectTitle', () => {
  it('shows the name as a keyboard-reachable button and sets the tab title', () => {
    render(<EditableProjectTitle project={makeProject()} />);
    const button = screen.getByRole('button', { name: /rename project/i });
    expect(button.textContent).toBe('Framer Clone Demo');
    expect(document.title).toBe('Framer Clone Demo | Lumitra Sites');
  });

  it('Enter saves: the name changes at once and is sent with the old name as precondition', async () => {
    const project = makeProject();
    fetchMock.mockResolvedValue(ok('Bakery'));
    render(<EditableProjectTitle project={project} />);
    const input = openEditor();
    expect(input.value).toBe('Framer Clone Demo');
    fireEvent.change(input, { target: { value: '  Bakery ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(project.metadata.title).toBe('Bakery'); // optimistic
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/site_1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'Bakery', expectedName: 'Framer Clone Demo' });
    await waitFor(() => expect(document.title).toBe('Bakery | Lumitra Sites'));
    expect(screen.getByRole('button', { name: /rename project/i }).textContent).toBe('Bakery');
    // The working-copy write went around undo history.
    expect(runUntracked).toHaveBeenCalled();
  });

  it('blur saves', async () => {
    const project = makeProject();
    fetchMock.mockResolvedValue(ok('Blurred'));
    render(<EditableProjectTitle project={project} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'Blurred' } });
    fireEvent.blur(input);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(project.metadata.title).toBe('Blurred');
  });

  it('Escape cancels without saving and returns focus to the name', () => {
    const project = makeProject();
    render(<EditableProjectTitle project={project} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'Never saved' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(project.metadata.title).toBe('Framer Clone Demo');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /rename project/i }));
  });

  it('after Enter focus returns to the name', async () => {
    fetchMock.mockResolvedValue(ok('Saved'));
    render(<EditableProjectTitle project={makeProject()} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'Saved' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /rename project/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('a second rename cannot start while the first is saving (no false conflict)', async () => {
    let resolveFirst!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolveFirst = r; }));
    const project = makeProject();
    render(<EditableProjectTitle project={project} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'First' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const button = screen.getByRole('button', { name: /rename project/i });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(screen.queryByRole('textbox')).toBeNull();

    await act(async () => resolveFirst(ok('First')));
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(project.metadata.title).toBe('First');
    // Now a second rename opens and uses the saved name as its precondition.
    fetchMock.mockResolvedValue(ok('Second'));
    const again = openEditor();
    fireEvent.change(again, { target: { value: 'Second' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).expectedName).toBe('First');
  });

  it('the error can be dismissed', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'rename_failed', message: 'down' } }), { status: 500 }),
    );
    render(<EditableProjectTitle project={makeProject()} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'X' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss rename error' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a name refused by the server shows the rule it broke', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'bad_body', message: 'invalid request body', issues: [{ message: 'A project name can be at most 100 characters.' }] } }),
        { status: 400 },
      ),
    );
    render(<EditableProjectTitle project={makeProject()} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'Valid here' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toBe('A project name can be at most 100 characters.');
  });

  it('puts the previous tab title back when the editor goes away', () => {
    document.title = 'Projects';
    const { unmount } = render(<EditableProjectTitle project={makeProject()} />);
    expect(document.title).toBe('Framer Clone Demo | Lumitra Sites');
    unmount();
    expect(document.title).toBe('Projects');
  });

  it('an empty name is refused with an announced message and the field stays open', () => {
    const project = makeProject();
    render(<EditableProjectTitle project={project} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('A project needs a name.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Project name' })).toBe(input);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(project.metadata.title).toBe('Framer Clone Demo');
  });

  it('an unchanged name closes the field without a request', () => {
    render(<EditableProjectTitle project={makeProject()} />);
    const input = openEditor();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a failed save rolls the name back and shows why', async () => {
    const project = makeProject();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden' } }), { status: 403 }),
    );
    render(<EditableProjectTitle project={project} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(project.metadata.title).toBe('Nope');
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'You do not have permission to rename this project.',
    );
    expect(project.metadata.title).toBe('Framer Clone Demo');
    expect(document.title).toBe('Framer Clone Demo | Lumitra Sites');
  });

  it('a network failure rolls back too', async () => {
    const project = makeProject();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<EditableProjectTitle project={project} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'Offline' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(project.metadata.title).toBe('Framer Clone Demo');
  });

  it("a lost race shows the other person's name, not the stale one", async () => {
    const project = makeProject();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'name_conflict', message: 'x', currentName: 'Their name' } }),
        { status: 409 },
      ),
    );
    render(<EditableProjectTitle project={project} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'Mine' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toContain('Their name');
    expect(project.metadata.title).toBe('Their name');
  });
});
