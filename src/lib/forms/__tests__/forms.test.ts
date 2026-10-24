// The form definition, the shared validation rules, the CSV export and the
// generator's form props: pure modules the island, the endpoint and the editor
// all read.

import { describe, expect, it } from 'vitest';
import {
  FORM_KIND_ATTR,
  collectFormFields,
  fieldsSignature,
  findFormNode,
  normalizeFieldKey,
  readFieldSpec,
  readFormSettings,
  stripFormConfigProps,
  type FormTreeNode,
} from '../definition';
import { localeFromAcceptLanguage, validateSubmission, validateValue, normalizeValue, toStoredFields } from '../validation';
import { csvCell, submissionsToCsv } from '../csv';
import { formPropKeysFor, sanitizeGeneratedFormProps } from '../generation';
import { linkPathOfSlug, isLinkablePageSlug } from '../paths';
import { FORM_COMPONENTS } from '@/lib/componentRegistry';

const field = (id: string, props: Record<string, unknown>): FormTreeNode => ({
  id,
  props: { [FORM_KIND_ATTR]: 'form-field', ...props },
});

const form = (children: FormTreeNode[], props: Record<string, unknown> = {}): FormTreeNode => ({
  id: 'form-1',
  props: { [FORM_KIND_ATTR]: 'form', ...props },
  children,
});

describe('collectFormFields', () => {
  it('collects fields depth first through layout divs, with unique keys', () => {
    const tree = form([
      { id: 'row', props: { style: { display: 'grid' } }, children: [field('a', { fieldType: 'text', name: 'name', label: 'Name' }), field('b', { fieldType: 'email', name: 'name', label: 'Email' })] },
      field('c', { fieldType: 'textarea', name: '', label: 'Your message' }),
      field('d', { fieldType: 'text', name: '_form', label: 'X' }),
    ]);
    const fields = collectFormFields(tree);
    expect(fields.map((f) => [f.nodeId, f.key, f.type])).toEqual([
      ['a', 'name', 'text'],
      ['b', 'name_2', 'email'],
      ['c', 'Your_message', 'textarea'],
      ['d', 'form', 'text'],
    ]);
  });

  it('does not descend into a nested form', () => {
    const tree = form([field('a', { name: 'a' }), form([field('inner', { name: 'inner' })])]);
    expect(collectFormFields(tree).map((f) => f.key)).toEqual(['a']);
  });

  it('stops at the field limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => field(`f${i}`, { name: `f${i}` }));
    expect(collectFormFields(form(many))).toHaveLength(30);
  });

  it('a consent box is required unless made optional, lengths clamp to the type ceiling', () => {
    expect(readFieldSpec(field('c', { fieldType: 'consent' }), 0).required).toBe(true);
    expect(readFieldSpec(field('c', { fieldType: 'consent', required: false }), 0).required).toBe(false);
    const email = readFieldSpec(field('e', { fieldType: 'email', maxLength: 9999, minLength: 3 }), 0);
    expect(email.maxLength).toBe(254);
    expect(email.minLength).toBe(3);
    const select = readFieldSpec(field('s', { fieldType: 'select', options: ['A', ' A ', '', 'B'] }), 0);
    expect(select.options).toEqual(['A', 'B']);
  });

  it('the fields signature changes with the rules, so a stale draft is detectable', () => {
    const a = collectFormFields(form([field('a', { name: 'a', required: true })]));
    const b = collectFormFields(form([field('a', { name: 'a', required: false })]));
    expect(fieldsSignature(a)).not.toBe(fieldsSignature(b));
  });
});

describe('form settings and helpers', () => {
  it('a redirect without a page falls back to the message', () => {
    expect(readFormSettings({ successBehavior: 'redirect' }).successBehavior).toBe('message');
    expect(readFormSettings({ successBehavior: 'redirect', redirectPageId: 'p2' })).toMatchObject({ successBehavior: 'redirect', redirectPageId: 'p2' });
    expect(readFormSettings({}).name).toBe('Contact form');
  });

  it('finds a form by id and strips config props before the DOM', () => {
    const tree: FormTreeNode = { id: 'root', props: {}, children: [form([field('a', {})])] };
    expect(findFormNode(tree, 'form-1')?.id).toBe('form-1');
    expect(findFormNode(tree, 'a')).toBeNull();
    expect(stripFormConfigProps({ [FORM_KIND_ATTR]: 'form', formName: 'x', style: { color: 'red' } })).toEqual({ style: { color: 'red' } });
  });

  it('normalizes field keys to letters, digits, _ and -', () => {
    expect(normalizeFieldKey('Größe der Gruppe')).toBe('Groe_der_Gruppe');
    expect(normalizeFieldKey('__x')).toBe('x');
  });

  it('builds a safe link path and refuses dynamic pages', () => {
    expect(linkPathOfSlug('')).toBe('/');
    expect(linkPathOfSlug('danke')).toBe('/danke');
    expect(linkPathOfSlug('a b/c')).toBe('/a%20b/c');
    expect(linkPathOfSlug('products/:handle')).toBeNull();
    expect(isLinkablePageSlug('../x')).toBe(false);
  });
});

describe('validation (one implementation for the island and the server)', () => {
  const [name, email, phone, message, topic, consent] = collectFormFields(
    form([
      field('n', { fieldType: 'text', name: 'name', required: true, minLength: 2, maxLength: 10 }),
      field('e', { fieldType: 'email', name: 'email', required: true }),
      field('p', { fieldType: 'tel', name: 'phone' }),
      field('m', { fieldType: 'textarea', name: 'message', required: true }),
      field('t', { fieldType: 'select', name: 'topic', options: ['Booking', 'Other'] }),
      field('c', { fieldType: 'consent', name: 'consent' }),
    ]),
  );

  it('checks required, lengths, email, phone, options and consent', () => {
    expect(validateValue(name, '')?.code).toBe('required');
    expect(validateValue(name, 'A')?.code).toBe('too_short');
    expect(validateValue(name, 'A'.repeat(11))?.code).toBe('too_long');
    expect(validateValue(name, 'Ana')).toBeNull();
    expect(validateValue(email, 'not-an-email')?.code).toBe('email');
    expect(validateValue(email, 'a@b.de')).toBeNull();
    expect(validateValue(phone, '')).toBeNull();
    expect(validateValue(phone, '12')?.code).toBe('tel');
    expect(validateValue(phone, '+49 (30) 123-456')).toBeNull();
    expect(validateValue(topic, 'Hack')?.code).toBe('option');
    expect(validateValue(consent, false)?.code).toBe('consent');
    expect(validateValue(consent, true)).toBeNull();
    expect(validateValue(message, 'x')).toBeNull();
  });

  it('counts characters as people do (an emoji is one)', () => {
    expect(validateValue(name, '😀😀')).toBeNull();
  });

  it('normalizes values: trims, strips control characters, keeps textarea line breaks, reads checkboxes', () => {
    expect(normalizeValue(name, '  Ana\u0000 ')).toBe('Ana');
    expect(normalizeValue(message, ' a\r\nb ')).toBe('a\nb');
    expect(normalizeValue(consent, 'on')).toBe(true);
    expect(normalizeValue(consent, undefined)).toBe(false);
  });

  it('validates a whole submission, ignores keys the form does not have, speaks German on request', () => {
    const check = validateSubmission([name, email, consent], { name: 'Ana', email: 'x', extra: 'evil' }, 'de');
    expect(check.ok).toBe(false);
    expect(Object.keys(check.errors).sort()).toEqual(['consent', 'email']);
    expect(check.errors.email.message).toMatch(/E-Mail-Adresse/);
    expect(check.values).not.toHaveProperty('extra');
    expect(toStoredFields([name], check.values)).toEqual([{ key: 'name', label: 'Text', type: 'text', value: 'Ana' }]);
    expect(localeFromAcceptLanguage('de-AT,de;q=0.9,en;q=0.5')).toBe('de');
    expect(localeFromAcceptLanguage(null)).toBe('en');
  });
});

describe('CSV export', () => {
  it('quotes, neutralizes formulas and adds one column per field key', () => {
    const csv = submissionsToCsv([
      {
        createdAt: new Date('2026-10-24T10:00:00Z'),
        formName: 'Contact',
        pagePath: '/kontakt',
        readAt: null,
        fields: [
          { key: 'name', label: 'Name', type: 'text', value: '=HYPERLINK("x")' },
          { key: 'consent', label: 'Consent', type: 'consent', value: true },
        ],
      },
      {
        createdAt: new Date('2026-10-23T10:00:00Z'),
        formName: 'Contact',
        pagePath: '/kontakt',
        readAt: new Date(),
        fields: [{ key: 'message', label: 'Message', type: 'textarea', value: 'a, "b"\nc' }],
      },
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('Submitted at (UTC),Form,Page,Read,Name,Consent,Message');
    expect(lines[1]).toBe(`2026-10-24T10:00:00.000Z,Contact,/kontakt,no,"'=HYPERLINK(""x"")",yes,`);
    expect(csv).toContain('"a, ""b""\nc"');
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });
});

describe('generator form props', () => {
  it('accepts only the documented props per form preset, cleaned', () => {
    expect(formPropKeysFor(FORM_COMPONENTS.form.defaultProps)).toEqual(['formName', 'successMessage']);
    expect(formPropKeysFor({ style: {} })).toEqual([]);
    const warnings: string[] = [];
    const out = sanitizeGeneratedFormProps(
      FORM_COMPONENTS.formEmail.defaultProps,
      { label: ' E-Mail ', name: 'E Mail!', required: 'yes', maxLength: 9999, minLength: 5, options: ['a'], inputRadius: 'url(x);' },
      (m) => warnings.push(m),
    );
    expect(out).toEqual({ label: 'E-Mail', name: 'E_Mail', maxLength: 254, minLength: 5 });
    expect(warnings.join('\n')).toMatch(/required/);
    expect(warnings.join('\n')).toMatch(/options/);
    expect(warnings.join('\n')).toMatch(/inputRadius/);
  });
});
