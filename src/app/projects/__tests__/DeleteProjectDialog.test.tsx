// The delete dialog's announcement after the server answers: a plain delete, a delete whose form submissions are still being
// removed, and the one case that needs support. It must never say the project's data is gone while the server says it is not.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const deleteProject = vi.fn();
vi.mock('@/lib/projects/deleteProject', () => ({ deleteProject: (...a: unknown[]) => deleteProject(...a) }));

import DeleteProjectDialog from '../DeleteProjectDialog';

afterEach(() => {
  cleanup();
  deleteProject.mockReset();
});

function open(onDeleted = vi.fn()) {
  render(
    <DeleteProjectDialog
      open
      onOpenChange={() => {}}
      siteId="s1"
      name="Bakery"
      published={false}
      liveHost={null}
      customDomains={[]}
      onDeleted={onDeleted}
      returnFocusTo={() => null}
    />,
  );
  return onDeleted;
}

describe('DeleteProjectDialog', () => {
  it('announces a plain delete plainly', async () => {
    deleteProject.mockResolvedValue({ ok: true });
    const onDeleted = open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('Deleted the project Bakery.'));
  });

  it('says the form submissions are still being removed when the server says so, and does not claim they are gone', async () => {
    deleteProject.mockResolvedValue({ ok: true, formSubmissionsPending: true });
    const onDeleted = open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    const said = onDeleted.mock.calls[0][0] as string;
    expect(said).toMatch(/Deleted the project Bakery\./);
    expect(said).toMatch(/still being removed in the background/);
    expect(said).toMatch(/no guaranteed time/);
    expect(said).not.toMatch(/minutes|soon|shortly/i);
  });

  it('a deleted project whose submissions are not removed shows the support message and removes the card only when closed', async () => {
    deleteProject.mockResolvedValue({
      ok: false,
      gone: true,
      deletedWithWarning: true,
      submissionsNotRemoved: true,
      message: 'The project was deleted, but its form submissions could not be removed and no automatic removal could be arranged. Contact support to have them removed.',
    });
    const onDeleted = open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByText(/Contact support to have them removed/)).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
    // Closing removes the card, and the status line says what is true: deleted, but the submissions are not removed.
    fireEvent.click(screen.getByRole('button', { name: /close|ok|done|got it/i }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onDeleted.mock.calls[0][0]).toMatch(/Its form submissions could not be removed: contact support\./);
  });

  it('a delete refused before anything changed keeps the dialog open with a try-again message and no "deleted" announcement', async () => {
    deleteProject.mockResolvedValue({ ok: false, message: 'Could not delete the project: deleting the project failed; nothing was deleted, try again' });
    const onDeleted = open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/nothing was deleted, try again/);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
