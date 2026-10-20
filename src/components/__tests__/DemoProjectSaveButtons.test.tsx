// The standalone demo editor at `/` builds its project in the browser; no
// company holds it. Save and Publish only update projects created on the
// dashboard, so there they explain that instead of calling the server (which
// would refuse with a message about a deleted project, which is untrue here).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import ProjectModel from '@/models/ProjectModel';

let editorUI: { currentProject: unknown; isUnsavedDemo?: boolean };
vi.mock('@/hooks/useStore', () => ({ useStore: () => ({ editorUI }) }));

import SaveButton from '../SaveButton';
import PublishButton from '../PublishButton';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  editorUI = {
    currentProject: ProjectModel.create({ id: 'demo', metadata: { title: 'Framer Clone Demo', description: '' }, pages: {} }),
    isUnsavedDemo: true,
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MESSAGE =
  'This demo project exists only in this browser. Create a project on the projects dashboard to save and publish.';

describe('Save and Publish in the browser-only demo editor', () => {
  it('Save explains instead of calling the server', () => {
    render(<SaveButton />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByRole('alert').textContent).toBe(MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Publish explains instead of calling the server', () => {
    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: /publish/i }));
    expect(screen.getByRole('alert').textContent).toBe(MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a project loaded from the dashboard still saves', async () => {
    editorUI.isUnsavedDemo = false;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ siteId: 'demo', savedPages: [] }), { status: 200 }));
    render(<SaveButton />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByRole('status');
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/save', expect.anything());
  });
});
