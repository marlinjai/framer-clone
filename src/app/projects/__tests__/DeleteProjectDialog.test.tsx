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
    // The next step is there, with the id the owner can quote (the project is gone, its card is too).
    expect(said).toMatch(/contact support and quote the project id s1/);
  });

  it('uses the server\'s own pending message when it sends one, so the words and the project id are the server\'s', async () => {
    deleteProject.mockResolvedValue({ ok: true, formSubmissionsPending: true, message: 'Its form submissions are still being removed in the background. This has no guaranteed time. Quote project id s1 to support.' });
    const onDeleted = open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onDeleted.mock.calls[0][0]).toBe('Deleted the project Bakery. Its form submissions are still being removed in the background. This has no guaranteed time. Quote project id s1 to support.');
  });

  it('a deleted project whose submissions are not removed shows the support message and removes the card only when closed', async () => {
    deleteProject.mockResolvedValue({
      ok: false,
      gone: true,
      deletedWithWarning: true,
      message: 'The project was deleted, but its form submissions could not be removed and no automatic removal could be arranged. Contact support to have them removed.',
    });
    const onDeleted = open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByText(/Contact support to have them removed/)).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
    // Closing removes the card, and the status line says what is true: deleted, but the submissions are not removed.
    fireEvent.click(screen.getByRole('button', { name: /close|ok|done|got it/i }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    // Announced in the server's own words, identical to what the dialog showed.
    expect(onDeleted.mock.calls[0][0]).toBe('The project was deleted, but its form submissions could not be removed and no automatic removal could be arranged. Contact support to have them removed.');
  });

  it('a cache warning with a pending removal is announced in the server\'s own words too', async () => {
    const message = 'The project was deleted, but its published pages may still be served from cache until the next deploy. Its form submissions are still being removed in the background. This has no guaranteed time, and nothing more is needed. If you need them removed by a certain time, contact support and quote the project id s1.';
    deleteProject.mockResolvedValue({ ok: false, gone: true, deletedWithWarning: true, formSubmissionsPending: true, message });
    const onDeleted = open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByText(message)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(message));
  });

  it('a delete refused before anything changed keeps the dialog open with a try-again message and no "deleted" announcement', async () => {
    deleteProject.mockResolvedValue({ ok: false, message: 'Could not delete the project: deleting the project failed; nothing was deleted, try again' });
    const onDeleted = open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/nothing was deleted, try again/);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
