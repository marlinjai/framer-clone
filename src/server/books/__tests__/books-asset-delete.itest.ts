// src/server/books/__tests__/books-asset-delete.itest.ts
//
// Deleting a logo nobody uses (visual template composer plan, phase 4
// decision 9; migration 014_books_asset_delete) against a real provisioned
// tenant schema, the repository connected as commerce_app:
//
//   - what "in use" means: an issued document froze the logo (also after it
//     was cancelled, and its credit note), a live template's current version
//     names it; an older version, an archived template or another company's
//     template does not hold it; `listAssets` reports exactly what the delete
//     guard applies, newest first;
//   - the stateful-flow paths of a logo (stateful-flow-testing.md): forward
//     (upload, use, stop using, delete), backtrack (a template's newer version
//     drops the logo, then names it again: in use again), resume (the list
//     read again shows the stored state), re-entry (the same bytes uploaded
//     after a delete are the same hash again, and a template naming it saves);
//   - the races, each order run with two real transactions on separate
//     pooled connections, the second proven to be waiting on the first's logo
//     lock before the first commits: an issue holding the logo makes a delete
//     wait and then refuse; a delete holding it makes an issue wait and then
//     refuse with LOGO_ASSET_MISSING (no number taken); the same two orders
//     for a template save, a template created naming the logo, an upload of
//     the same file while a delete holds it (it waits, then stores it anew),
//     and an owner's DELETE outside the application (the guard takes the lock
//     too); a delete held up too long gives up with ASSET_BUSY. Without the
//     locks the second transaction never waits, so these tests then fail on
//     the wait helper's bound, not on an assertion about the bad outcome.
// All data is synthetic; images are generated at run time.

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cancelInvoice } from '../cancel';
import { issue } from '../issue';
import { deleteAsset, listAssets, storeLogo } from '../repository/assets';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { getDocument } from '../repository/read';
import { createTemplate, deleteTemplate, updateTemplate } from '../repository/templates';
import type { BooksScope } from '../scope';
import { preset } from '../template/presets';
import type { TemplateDocumentV2 } from '../template/schema';
import { ACTOR, FakeDirectory, initCompany, newCustomer, newTenantId, openBooksEnv, scopeFor, type BooksEnv } from './booksFixtures';
import { makePng } from './testImages';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('books-asset-delete');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function company() {
  const dir = new FakeDirectory();
  const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
  await initCompany(scope, { invoiceNext: 62 });
  const { customer } = await newCustomer(scope, dir);
  return { scope, customerId: customer.id };
}

/** A logo of the company, stored through the real upload path (a distinct image per size). */
async function logo(scope: BooksScope, width: number): Promise<string> {
  return (await storeLogo(scope, makePng(width, 40), 'image/png')).asset.sha256;
}

/** Modern with the logo top right (or none). */
function withLogo(sha256: string | null): TemplateDocumentV2 {
  const doc = preset('modern');
  doc.regions.firstPageHeader = [{ id: 'logo', type: 'logo', style: { align: 'right' }, widthMm: 40, assetSha256: sha256 }];
  return doc;
}

async function draftWith(scope: BooksScope, customerId: string, templateId: string): Promise<string> {
  const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId, templateId });
  await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
  return draft.document.id;
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return String((err as { code?: unknown }).code);
  }
  throw new Error('expected a refusal, the call succeeded');
}

async function counterValue(tenantId: string): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('document_number_counter')
    .select('next_value')
    .where('tenant_id', '=', tenantId)
    .where('doc_type', '=', 'invoice')
    .executeTakeFirstOrThrow();
  return Number(row.next_value);
}

async function inUse(scope: BooksScope): Promise<Record<string, boolean>> {
  return Object.fromEntries((await listAssets(scope)).map((a) => [a.sha256, a.inUse]));
}

/**
 * Wait until a transaction waits for THIS logo's lock in this mode
 * ('ExclusiveLock' for a delete, 'ShareLock' for an issue, a save or an
 * upload), so the test commits the first transaction only once the second
 * really waits for it. Matched on this database and on the lock's own key
 * (repository/assets.ts: company and hash), because other test files running
 * in parallel take advisory locks of their own.
 */
async function waitUntilBlocked(mode: 'ExclusiveLock' | 'ShareLock', scope: BooksScope, sha256: string): Promise<void> {
  const key = `books-asset:${scope.tenantId}:${sha256}`;
  for (let i = 0; i < 1200; i++) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND mode = ${mode}
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND objsubid = 1
         AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`.execute(env.ownerDb);
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no transaction ever waited for the lock of logo ${sha256} (${mode})`);
}

describe('deleteAsset and listAssets: what "in use" means', () => {
  it('an issued document holds its logo for good (also cancelled, with its credit note); an unused logo goes', async () => {
    const { scope, customerId } = await company();
    const printed = await logo(scope, 120);
    const spare = await logo(scope, 121);
    const template = await createTemplate(scope, { name: 'Mit Logo', document: withLogo(printed) });
    const id = await draftWith(scope, customerId, template.id);
    await issue(scope, id, { actorUserId: ACTOR });
    // The template stops naming the logo; the issued document still froze it.
    await updateTemplate(scope, template.id, { document: withLogo(null) });
    expect(await inUse(scope)).toEqual({ [printed]: true, [spare]: false });
    expect(await errorCode(deleteAsset(scope, printed))).toBe('ASSET_IN_USE');
    await cancelInvoice(scope, id, { actorUserId: ACTOR, reason: 'Wrong amount' });
    expect(await errorCode(deleteAsset(scope, printed))).toBe('ASSET_IN_USE');

    await deleteAsset(scope, spare);
    expect(await inUse(scope)).toEqual({ [printed]: true });
    expect(await env.ownerDb.selectFrom('books_asset').select('sha256').where('tenant_id', '=', scope.tenantId).execute()).toEqual([
      { sha256: printed },
    ]);
    // The issued document and its credit note still re-render with it (nothing they need is gone).
    const view = await getDocument(scope, id);
    expect(view.document.templateSnapshot).toMatchObject({ v: 2, logo: { sha256: printed } });
  });

  it('a live template holds its current logo: a newer version without it, or archiving the template, lets it go', async () => {
    const { scope } = await company();
    const a = await logo(scope, 130);
    const b = await logo(scope, 131);
    const first = await createTemplate(scope, { name: 'Erste', document: withLogo(a) });
    const second = await createTemplate(scope, { name: 'Zweite', document: withLogo(b) });
    expect(await inUse(scope)).toEqual({ [a]: true, [b]: true });
    expect(await errorCode(deleteAsset(scope, a))).toBe('ASSET_IN_USE');

    // Backtrack: a newer version drops logo A (the older version still names it, and does not count).
    await updateTemplate(scope, first.id, { document: withLogo(null) });
    expect(await inUse(scope)).toEqual({ [a]: false, [b]: true });
    // ... and names it again: in use again.
    await updateTemplate(scope, first.id, { document: withLogo(a) });
    expect(await inUse(scope)).toEqual({ [a]: true, [b]: true });
    await updateTemplate(scope, first.id, { document: withLogo(null) });
    await deleteAsset(scope, a);

    // An archived template prints nothing: its logo may go.
    await deleteTemplate(scope, second.id);
    expect(await inUse(scope)).toEqual({ [b]: false });
    await deleteAsset(scope, b);
    expect(await listAssets(scope)).toEqual([]);
  });

  it("another company's template or document never holds a logo, and another company's logo is not found", async () => {
    const mine = await company();
    const theirs = await company();
    const bytes = makePng(140, 40);
    const shared = (await storeLogo(mine.scope, bytes, 'image/png')).asset.sha256;
    expect((await storeLogo(theirs.scope, bytes, 'image/png')).asset.sha256).toBe(shared);
    const theirTemplate = await createTemplate(theirs.scope, { name: 'Theirs', document: withLogo(shared) });
    await issue(theirs.scope, await draftWith(theirs.scope, theirs.customerId, theirTemplate.id), { actorUserId: ACTOR });

    expect(await inUse(mine.scope)).toEqual({ [shared]: false });
    expect(await inUse(theirs.scope)).toEqual({ [shared]: true });
    await deleteAsset(mine.scope, shared);
    expect(await errorCode(deleteAsset(mine.scope, shared))).toBe('ASSET_NOT_FOUND');
    // Their row is untouched.
    expect(await inUse(theirs.scope)).toEqual({ [shared]: true });

    const onlyTheirs = await logo(theirs.scope, 141);
    expect(await errorCode(deleteAsset(mine.scope, onlyTheirs))).toBe('ASSET_NOT_FOUND');
    expect(await errorCode(deleteAsset(mine.scope, 'f'.repeat(64)))).toBe('ASSET_NOT_FOUND');
    expect(await errorCode(deleteAsset(mine.scope, 'not-a-hash'))).toBe('ASSET_NOT_FOUND');
    expect(await inUse(theirs.scope)).toEqual({ [shared]: true, [onlyTheirs]: false });
  });

  it('lists newest first with the view fields, and re-entry: the same bytes after a delete are the same logo again', async () => {
    const { scope } = await company();
    const older = await logo(scope, 150);
    await new Promise((r) => setTimeout(r, 20));
    const newer = await logo(scope, 151);
    const list = await listAssets(scope);
    expect(list.map((a) => a.sha256)).toEqual([newer, older]);
    expect(list[0]).toEqual({
      sha256: newer,
      contentType: 'image/png',
      byteSize: makePng(151, 40).byteLength,
      widthPx: 151,
      heightPx: 40,
      createdAt: expect.any(Date),
      inUse: false,
    });

    const template = await createTemplate(scope, { name: 'Wieder', document: withLogo(older) });
    await updateTemplate(scope, template.id, { document: withLogo(null) });
    await deleteAsset(scope, older);
    // A save naming the deleted logo is refused by name ...
    const refused = updateTemplate(scope, template.id, { document: withLogo(older) });
    await expect(refused).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      details: { problems: [expect.objectContaining({ code: 'LOGO_ASSET_MISSING', blockId: 'logo' })] },
    });
    // ... until the same file is uploaded again: the same hash, a new row.
    const again = await storeLogo(scope, makePng(150, 40), 'image/png');
    expect(again).toMatchObject({ created: true, asset: { sha256: older } });
    await updateTemplate(scope, template.id, { document: withLogo(older) });
    expect(await inUse(scope)).toEqual({ [older]: true, [newer]: false });
  });
});

/** The outcome of a call as data: 'ok', or the refusal's code and details. */
function settle(p: Promise<unknown>): Promise<'ok' | { code: unknown; details: unknown }> {
  return p.then(
    () => 'ok' as const,
    (e: { code?: unknown; details?: unknown }) => ({ code: e.code, details: e.details }),
  );
}

describe('deleteAsset racing an issue or a template save (both orders, two real transactions)', () => {
  it('an issue holding the logo first: the delete waits for the commit and is then refused', async () => {
    const { scope, customerId } = await company();
    const sha = await logo(scope, 160);
    const template = await createTemplate(scope, { name: 'Race', document: withLogo(sha) });
    const id = await draftWith(scope, customerId, template.id);

    let deletion: Promise<unknown> = Promise.resolve();
    const issued = await issue(scope, id, { actorUserId: ACTOR }, {
      beforeCommit: async () => {
        // The issue has frozen the logo. The template stops naming it, so from here only this
        // uncommitted issue holds it: without the issue's lock the delete would go through.
        await updateTemplate(scope, template.id, { document: withLogo(null) });
        deletion = settle(deleteAsset(scope, sha));
        await waitUntilBlocked('ExclusiveLock', scope, sha);
      },
    });
    expect(issued.document.document.numberValue).toBe(62);
    expect(await deletion).toEqual({ code: 'ASSET_IN_USE', details: { sha256: sha } });
    expect(await inUse(scope)).toEqual({ [sha]: true });
  });

  it('a delete holding the logo first: the issue waits for the commit and is refused by name, taking no number', async () => {
    const { scope, customerId } = await company();
    const sha = await logo(scope, 161);
    const template = await createTemplate(scope, { name: 'Race', document: withLogo(sha) });
    const named = template.currentVersionId;
    const id = await draftWith(scope, customerId, template.id);
    // A newer version drops the logo, so nothing committed holds it and the delete is allowed.
    await updateTemplate(scope, template.id, { document: withLogo(null) });

    let issuing: Promise<unknown> = Promise.resolve();
    await deleteAsset(scope, sha, {
      beforeCommit: async () => {
        // The delete has run and holds the row. The issue starts from a template naming the logo
        // (as an issue that read the template just before the newer version would): the current
        // version is set back directly, because a save naming the logo would itself wait here.
        await env.ownerDb
          .updateTable('document_template')
          .set({ current_version_id: named })
          .where('tenant_id', '=', scope.tenantId)
          .where('id', '=', template.id)
          .execute();
        issuing = settle(issue(scope, id, { actorUserId: ACTOR }));
        await waitUntilBlocked('ShareLock', scope, sha);
      },
    });
    expect(await issuing).toEqual({ code: 'LOGO_ASSET_MISSING', details: { blockIds: ['logo'] } });
    expect((await getDocument(scope, id)).document.status).toBe('draft');
    expect(await counterValue(scope.tenantId)).toBe(62);
    expect(await listAssets(scope)).toEqual([]);
  });

  it('a template save holding the logo first: the delete waits for the commit and is then refused', async () => {
    const { scope } = await company();
    const sha = await logo(scope, 162);
    const template = await createTemplate(scope, { name: 'Race', document: withLogo(null) });

    let deletion: Promise<unknown> = Promise.resolve();
    const saved = await updateTemplate(scope, template.id, { document: withLogo(sha) }, {}, {
      beforeCommit: async () => {
        // The new version names the logo but is not committed: only the save's lock holds it.
        deletion = settle(deleteAsset(scope, sha));
        await waitUntilBlocked('ExclusiveLock', scope, sha);
      },
    });
    expect(saved.version).toBe(2);
    expect(await deletion).toEqual({ code: 'ASSET_IN_USE', details: { sha256: sha } });
    expect(await inUse(scope)).toEqual({ [sha]: true });
  });

  it('a delete holding the logo first: the template save (its gate already passed) waits and is refused on the block', async () => {
    const { scope } = await company();
    const sha = await logo(scope, 163);
    const template = await createTemplate(scope, { name: 'Race', document: withLogo(null) });

    let saving: Promise<unknown> = Promise.resolve();
    await deleteAsset(scope, sha, {
      beforeCommit: async () => {
        // The gate runs before the save's transaction and still sees the uncommitted delete's row.
        saving = settle(updateTemplate(scope, template.id, { document: withLogo(sha) }));
        await waitUntilBlocked('ShareLock', scope, sha);
      },
    });
    expect(await saving).toEqual({
      code: 'TEMPLATE_INVALID',
      details: { problems: [expect.objectContaining({ code: 'LOGO_ASSET_MISSING', blockId: 'logo', region: 'firstPageHeader' })] },
    });
    // Nothing was written: the template is still at its first version.
    const versions = await env.ownerDb
      .selectFrom('document_template_version')
      .select('version')
      .where('tenant_id', '=', scope.tenantId)
      .where('template_id', '=', template.id)
      .execute();
    expect(versions).toEqual([{ version: 1 }]);
  });

  it('a template created naming a logo races a delete the same way (the create path locks too)', async () => {
    const { scope } = await company();
    const sha = await logo(scope, 164);
    let creating: Promise<unknown> = Promise.resolve();
    await deleteAsset(scope, sha, {
      beforeCommit: async () => {
        creating = settle(createTemplate(scope, { name: 'Neu', document: withLogo(sha) }));
        await waitUntilBlocked('ShareLock', scope, sha);
      },
    });
    expect(await creating).toMatchObject({ code: 'TEMPLATE_INVALID' });
    expect(await env.ownerDb.selectFrom('document_template').select('id').where('tenant_id', '=', scope.tenantId).execute()).toEqual([]);
  });

  it('an upload of the same file while a delete holds it waits, then stores it anew (never answers a deleted logo)', async () => {
    const { scope } = await company();
    const bytes = makePng(165, 40);
    const sha = (await storeLogo(scope, bytes, 'image/png')).asset.sha256;
    let uploading: Promise<unknown> = Promise.resolve();
    await deleteAsset(scope, sha, {
      beforeCommit: async () => {
        uploading = storeLogo(scope, bytes, 'image/png');
        await waitUntilBlocked('ShareLock', scope, sha);
      },
    });
    expect(await uploading).toMatchObject({ created: true, asset: { sha256: sha } });
    expect(await inUse(scope)).toEqual({ [sha]: false });
  });

  it("an owner's DELETE outside the application waits for an issue holding the logo, then is refused (the guard locks too)", async () => {
    const { scope, customerId } = await company();
    const sha = await logo(scope, 166);
    const template = await createTemplate(scope, { name: 'Race', document: withLogo(sha) });
    const id = await draftWith(scope, customerId, template.id);

    let deletion: Promise<unknown> = Promise.resolve();
    await issue(scope, id, { actorUserId: ACTOR }, {
      beforeCommit: async () => {
        await updateTemplate(scope, template.id, { document: withLogo(null) });
        deletion = env.ownerDb
          .deleteFrom('books_asset')
          .where('tenant_id', '=', scope.tenantId)
          .where('sha256', '=', sha)
          .execute()
          .then(
            () => 'deleted',
            (e: { code?: string }) => e.code,
          );
        await waitUntilBlocked('ExclusiveLock', scope, sha);
      },
    });
    expect(await deletion).toBe('BK015');
    expect(await inUse(scope)).toEqual({ [sha]: true });
  });

  it('a delete held up longer than its bound gives up with ASSET_BUSY and deletes nothing', async () => {
    const { scope, customerId } = await company();
    const sha = await logo(scope, 167);
    const template = await createTemplate(scope, { name: 'Race', document: withLogo(sha) });
    const id = await draftWith(scope, customerId, template.id);

    let deletion: unknown;
    await issue(scope, id, { actorUserId: ACTOR }, {
      beforeCommit: async () => {
        await updateTemplate(scope, template.id, { document: withLogo(null) });
        // The issue holds the logo for the whole wait: the delete gives up on its own.
        deletion = await settle(deleteAsset(scope, sha));
      },
    });
    expect(deletion).toEqual({ code: 'ASSET_BUSY', details: { sha256: sha } });
    expect(await inUse(scope)).toEqual({ [sha]: true });
  });
});

