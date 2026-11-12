// What the dashboard tells a person after DELETE /api/projects/<id>: the project's own outcomes kept apart from the cleanup of
// its form submissions (removed, still being removed, or not removed and nothing scheduled), never "deleted" while rows remain.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deleteProject } from '../deleteProject';

function answer(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe('deleteProject', () => {
  it('a plain success is a plain success', async () => {
    answer(200, { siteId: 's', deleted: true });
    expect(await deleteProject('s')).toEqual({ ok: true });
  });

  it('a success while the form submissions are still being removed says so', async () => {
    answer(200, { siteId: 's', deleted: true, formSubmissionsPending: true, message: 'Its form submissions are still being removed in the background. This has no guaranteed time, and nothing more is needed.' });
    expect(await deleteProject('s')).toEqual({
      ok: true,
      formSubmissionsPending: true,
      message: 'Its form submissions are still being removed in the background. This has no guaranteed time, and nothing more is needed.',
    });
  });

  it('a success body that is not JSON is still a success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    expect(await deleteProject('s')).toEqual({ ok: true });
  });

  it('a cache warning is a deleted project, and carries the pending removal when there is one', async () => {
    answer(500, { error: { code: 'delete_cache_failed', message: 'The project was deleted, but cache. Its form submissions are still being removed in the background.', formSubmissionsPending: true } });
    expect(await deleteProject('s')).toMatchObject({ ok: false, gone: true, deletedWithWarning: true, formSubmissionsPending: true });
    answer(500, { error: { code: 'delete_cache_failed', message: 'The project was deleted, but cache.' } });
    expect(await deleteProject('s')).toMatchObject({ ok: false, gone: true, deletedWithWarning: true, formSubmissionsPending: false });
  });

  it('submissions not removed and nothing scheduled: the project IS deleted, support is the next step, and it never says "could not delete"', async () => {
    answer(500, { error: { code: 'delete_submissions_failed', message: 'The project was deleted, but its form submissions could not be removed and no automatic removal could be arranged. Contact support to have them removed.' } });
    const result = await deleteProject('s');
    expect(result).toMatchObject({ ok: false, gone: true, deletedWithWarning: true, submissionsNotRemoved: true });
    expect((result as { message: string }).message).toMatch(/Contact support/);
    expect((result as { message: string }).message).not.toMatch(/^Could not delete/);
  });

  it('a delete refused before anything changed (the purge could not be written) is NOT gone and says nothing was deleted', async () => {
    answer(500, { error: { code: 'delete_failed', message: 'deleting the project failed; nothing was deleted, try again' } });
    const result = await deleteProject('s');
    expect(result).toMatchObject({ ok: false });
    expect((result as { gone?: boolean }).gone).toBeUndefined();
    expect((result as { message: string }).message).toMatch(/nothing was deleted, try again/);
  });
});
