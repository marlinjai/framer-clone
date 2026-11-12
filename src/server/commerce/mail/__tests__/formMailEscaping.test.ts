// What Lumitra Mail does with the visitor's words in the owner notice, checked with the REAL merge code, not a fake
// service. The service's worker (email-editor repo, apps/service/src/worker/merge.ts, `mergeHtml` and `mergeSubject`)
// delegates to `personalizeHtml`, `personalizeText` and `resolveValue` of @marlinjai/mail-contract, the very package
// installed here (same version, 0.25.0); `personalization()` below is its `valueOf`/`personalization` over a recipient's
// merge values. Visitor values land only in `summary_text`; the owner's words in `form_name`, `site_name`, `page_path`.
import { describe, expect, it } from 'vitest';
import { MAX_MERGE_DEFAULT_LENGTH, MailingMerge, personalizeHtml, personalizeText, resolveValue, type Personalization } from '@marlinjai/mail-contract';

import { summaryText } from '@/server/forms/notify';
import { templateCreate } from '../templates';

type Block = { id: string; content: string };

/** The template's German body as the compiler emits text blocks: a row whose cell carries the `el-text` class. */
function html(locale: 'de' | 'en'): string {
  const create = templateCreate('form_notification');
  const doc = locale === 'de' ? create.document : create.translations!.en.document!;
  const blocks = (doc as unknown as { sections: { columns: { blocks: Block[] }[] }[] }).sections[0].columns[0].blocks;
  return blocks.map((b) => `<tr><td class="el-text">${b.content}</td></tr>`).join('');
}

function personalization(merge: Record<string, string>): Personalization {
  return {
    insertions: {},
    value: (name, fallback) => {
      if (name === 'unsubscribe_url') return '';
      if (name === 'email') return 'owner@bakery.example';
      return resolveValue(name, fallback, { recipient: merge, mailing: {}, contact: null, workspace: {} }).text;
    },
  };
}

const BASE = {
  site_name: 'Bakery',
  form_name: 'Contact',
  page_path: '/kontakt',
  received_text: '12. November 2026 um 14:05',
  inbox_url: 'https://app.example/projects/site-1',
};

const ATTACKS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'; DROP TABLE form_submission; --",
  '<a href="javascript:alert(1)">click</a>',
  '</td></tr></table><h1>injected</h1>',
  '&lt;already-escaped&gt; & ampersand',
];

describe('the visitor words in the notice, through the real merge code', () => {
  for (const locale of ['de', 'en'] as const) {
    it(`${locale}: every markup character of a visitor value is escaped, so none of it becomes a tag or an attribute`, () => {
      for (const attack of ATTACKS) {
        const summary = summaryText([{ key: 'm', label: 'Message', type: 'textarea', value: attack }], locale);
        const out = personalizeHtml(html(locale), personalization({ ...BASE, summary_text: summary }));
        // Strip the template's own tags: what is left of the value has no < or > at all.
        const own = html(locale).replace(/\{\{[^}]*\}\}/g, '');
        expect(out.includes('<script'), attack).toBe(false);
        expect(out.includes('<img'), attack).toBe(false);
        expect(out.includes('<h1'), attack).toBe(false);
        expect(out.includes('<a href="javascript'), attack).toBe(false);
        // The number of tags is exactly the template's: the value added none.
        expect((out.match(/</g) ?? []).length, attack).toBe((own.match(/</g) ?? []).length);
        expect(out).toContain('Message: ');
      }
    });
  }

  it('a visitor value that reads like a merge field is printed, never filled again (no unsubscribe link, no other value)', () => {
    const summary = summaryText([{ key: 'm', label: 'Message', type: 'text', value: '{{unsubscribe_url}} {{inbox_url}} {{email}} {{site_name}}' }], 'en');
    const out = personalizeHtml(html('en'), personalization({ ...BASE, summary_text: summary }));
    expect(out).toContain('{{unsubscribe_url}} {{inbox_url}} {{email}} {{site_name}}');
    // The real inbox link appears once, in its own block.
    expect(out.match(/https:\/\/app\.example\/projects\/site-1/g)).toHaveLength(1);
  });

  it('the owner-named values (form and site name) are escaped in the body too', () => {
    const out = personalizeHtml(html('en'), personalization({ ...BASE, form_name: '<b>Booking</b>', site_name: 'A & B "Bakery"', summary_text: 'x' }));
    expect(out).not.toContain('<b>Booking</b>');
    expect(out).toContain('&lt;b&gt;Booking&lt;/b&gt;');
    expect(out).toContain('A &amp; B &quot;Bakery&quot;');
  });

  it('the subject cannot carry a header: line breaks in a name become a space', () => {
    const subject = templateCreate('form_notification').subject as string;
    const out = personalizeText(subject, personalization({ ...BASE, form_name: 'Contact\r\nBcc: evil@example.com', summary_text: 'x' }));
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toContain('Contact Bcc: evil@example.com');
  });

  it('the preheader reads the visitor summary and nothing else of the visitor, and is merged as plain text: the service escapes it afterwards', () => {
    const pre = templateCreate('form_notification').preheader as string;
    // Our side of the contract: which values the preheader can carry.
    expect([...pre.matchAll(/\{\{\s*([a-z_]+)/g)].map((m) => m[1])).toEqual(['summary_text']);
    const summary = summaryText([{ key: 'm', label: 'Message', type: 'text', value: '<b>"hi"</b> & <script>x</script>\u0000\r\nBcc: x' }], 'en');
    const out = personalizeText(pre, personalization({ ...BASE, summary_text: summary }));
    // Control characters (a header break) are gone.
    expect(out).not.toMatch(/[\u0000-\u001f]/);
    // personalizeText is NOT an HTML escaper (a header is not HTML): the markup characters arrive as they were typed, so the
    // preview's HTML safety rests on the service escaping the merged preheader before it places it in the hidden element
    // (email-editor apps/service/src/worker/compose.ts `withPreheader`: replaceHiddenPreview(html, escapePreviewText(preheader)),
    // tested in packages/core/src/compiler/__tests__/hiddenPreview.test.ts, `escapePreviewText`). This test fails if the
    // contract ever starts escaping here too (a double escape would print `&amp;lt;` in inboxes), and it names the dependency.
    expect(out).toContain('<b>"hi"</b> & <script>x</script>');
  });

  it('what the shop sends fits the service contract: names, scalar values, the length limit, no service-filled name', () => {
    const merge = { ...BASE, summary_text: summaryText(Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `Field ${i}`, type: 'text' as const, value: '𝒳'.repeat(500) })), 'en') };
    const parsed = MailingMerge.safeParse(merge);
    expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
    for (const value of Object.values(merge)) expect(value.length).toBeLessThanOrEqual(MAX_MERGE_DEFAULT_LENGTH);
    expect(Object.keys(merge)).not.toEqual(expect.arrayContaining(['email', 'unsubscribe_url']));
  });
});
