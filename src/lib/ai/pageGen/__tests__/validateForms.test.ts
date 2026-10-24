// The page generator and forms: the form presets are accepted with their own
// cleaned props, fields and the submit button never get children, raw form
// tags stay forbidden, a plain div cannot pose as a form, and the prompt
// tells the model the rules.

import { describe, expect, it } from 'vitest';
import { FORM_KIND_ATTR, collectFormFields } from '@/lib/forms/definition';
import { validateGeneration } from '../validate';
import { deriveBreakpointKeys } from '../schema';
import { stableSystemText } from '../prompt';

const breakpoints = deriveBreakpointKeys([
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Mobile', minWidth: 320 },
]);

function run(nodes: unknown[]) {
  let n = 0;
  const out = validateGeneration({ nodes }, { breakpoints, newId: () => `id${(n += 1)}` });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.result;
}

describe('form presets in a generation', () => {
  it('builds a working form from the presets with cleaned props', () => {
    const result = run([
      {
        type: 'div',
        preset: 'form',
        label: 'Booking form',
        props: { formName: 'Booking request', successMessage: 'Danke!', successBehavior: 'redirect', style: { padding: '32px' } },
        children: [
          { type: 'div', preset: 'formText', props: { label: 'Name', name: 'name', required: true, maxLength: 99999 } },
          { type: 'div', preset: 'formEmail', props: { label: 'E-Mail', name: 'email', required: true }, children: [{ type: 'p', props: { children: 'x' } }] },
          { type: 'div', preset: 'formSelect', props: { label: 'Personen', name: 'guests', options: ['1', '2', '3+'] } },
          { type: 'div', preset: 'formConsent', props: { label: 'Ich stimme der Datenschutzerklärung zu.', name: 'consent' } },
          { type: 'button', preset: 'formSubmit', props: { children: 'Anfrage senden', loadingLabel: 'Wird gesendet...' } },
        ],
      },
    ]);
    const form = result.nodes[0];
    const props = form.props as Record<string, unknown>;
    expect(props[FORM_KIND_ATTR]).toBe('form');
    expect(props.formName).toBe('Booking request');
    // The owner decides what happens after sending.
    expect(props.successBehavior).toBe('message');
    const fields = collectFormFields(form as never);
    expect(fields.map((f) => [f.key, f.type, f.required])).toEqual([
      ['name', 'text', true],
      ['email', 'email', true],
      ['guests', 'select', false],
      ['consent', 'consent', true],
    ]);
    expect(fields[0].maxLength).toBe(1000);
    expect(fields[2].options).toEqual(['1', '2', '3+']);
    const email = form.children![1];
    expect(email.children ?? []).toHaveLength(0);
    expect(result.warnings.join('\n')).toMatch(/renders its own content, children dropped/);
    expect(result.warnings.join('\n')).toMatch(/prop "successBehavior" is not allowed/);
    const submit = form.children![4].props as Record<string, unknown>;
    expect(submit.children).toBe('Anfrage senden');
    expect(submit.loadingLabel).toBe('Wird gesendet...');
  });

  it('never emits a raw form tag: "form" reads as the Form preset, raw inputs are dropped, a plain div cannot pose as a form', () => {
    const result = run([
      { type: 'form', children: [{ type: 'input' }, { type: 'textarea' }] },
      { type: 'div', props: { [FORM_KIND_ATTR]: 'form', formName: 'Fake', label: 'x' } },
    ]);
    expect(result.nodes).toHaveLength(2);
    // The registry id "form" is the safe Form preset (a div), never the raw tag.
    expect(result.nodes[0].type).toBe('div');
    expect((result.nodes[0].props as Record<string, unknown>)[FORM_KIND_ATTR]).toBe('form');
    expect(result.nodes[0].children ?? []).toHaveLength(0);
    expect(result.warnings.join('\n')).toMatch(/tag "input" is not allowed/);
    expect(result.warnings.join('\n')).toMatch(/tag "textarea" is not allowed/);
    expect((result.nodes[1].props as Record<string, unknown>)[FORM_KIND_ATTR]).toBeUndefined();
  });

  it('the cached prompt explains forms: presets only, one per page, real labels, consent', () => {
    const text = stableSystemText();
    expect(text).toContain('# Forms');
    expect(text).toContain('At most one form per page');
    expect(text).toContain('a real visible label');
    expect(text).toContain('required formConsent');
    expect(text).toContain('never');
    expect(text).not.toMatch(/[–—]/);
  });
});
