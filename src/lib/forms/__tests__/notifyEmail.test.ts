// The owner's notification address on the form container: read with bounds, never sent to the browser.
import { describe, expect, it } from 'vitest';

import { FORM_CONFIG_PROPS, NOTIFY_EMAIL_PROP, cleanNotifyEmail, readFormSettings, stripFormConfigProps, withoutPrivateFormProps } from '../definition';

describe('cleanNotifyEmail', () => {
  it('keeps a plain address and trims it', () => {
    expect(cleanNotifyEmail('  owner@bakery.example ')).toBe('owner@bakery.example');
  });
  it.each(['', 'owner', 'owner@', '@bakery.example', 'a b@bakery.example', 'a@b', 'a@b.c', 'x@y.example, z@y.example', 'a"b@y.example', `${'a'.repeat(300)}@y.example`, 42, null])(
    'treats %j as no address',
    (value) => {
      expect(cleanNotifyEmail(value)).toBe('');
    },
  );
  it('is read into the form settings, and an unusable one is empty', () => {
    expect(readFormSettings({ notifyEmail: 'owner@bakery.example' }).notifyEmail).toBe('owner@bakery.example');
    expect(readFormSettings({ notifyEmail: 'nope' }).notifyEmail).toBe('');
    expect(readFormSettings({}).notifyEmail).toBe('');
  });
});

describe('the address is private', () => {
  it('is removed from the node a client island receives, leaving the rest untouched', () => {
    const node = { id: 'form-1', props: { formName: 'Contact', [NOTIFY_EMAIL_PROP]: 'owner@bakery.example' }, children: [] };
    const safe = withoutPrivateFormProps(node);
    expect(JSON.stringify(safe)).not.toContain('owner@bakery.example');
    expect(safe.props).toEqual({ formName: 'Contact' });
    expect(node.props[NOTIFY_EMAIL_PROP]).toBe('owner@bakery.example');
  });
  it('is removed from every form below the node too (a nested form, a form inside another container)', () => {
    const node = {
      id: 'outer',
      props: { notifyEmail: 'outer@bakery.example' },
      children: [{ id: 'box', props: {}, children: [{ id: 'inner', props: { notifyEmail: 'inner@bakery.example', formName: 'Inner' }, children: [] }] }],
    };
    const text = JSON.stringify(withoutPrivateFormProps(node));
    expect(text).not.toContain('bakery.example');
    expect(text).toContain('Inner');
  });
  it('returns the same node when there is nothing to remove', () => {
    const node = { id: 'form-1', props: { formName: 'Contact' } };
    expect(withoutPrivateFormProps(node)).toBe(node);
  });
  it('is a form config prop, so it never becomes a DOM attribute either', () => {
    expect(FORM_CONFIG_PROPS.has(NOTIFY_EMAIL_PROP)).toBe(true);
    expect(stripFormConfigProps({ [NOTIFY_EMAIL_PROP]: 'owner@bakery.example', id: 'x' })).toEqual({ id: 'x' });
  });
});
