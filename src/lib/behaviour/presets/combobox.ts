// src/lib/behaviour/presets/combobox.ts
//
// A combobox with a list: typing filters the options, Down and Up move through what is left
// with the focus staying in the field, Enter copies the active option into it, Escape closes
// the list. See docs/plans/2026-11-02-behaviour-model.md, "Presets" and "Prototyped before
// freezing".
//
// The group is virtual, so the field keeps the focus and names the active option in
// `aria-activedescendant`. Typing clears the active option first, since one a filter hid
// could otherwise stay chosen. Without a script it is a plain text field and the list shows.
//
// PURE: no React, no MST.

import { assertSeed, derived, el, onKeys, propsOf, stateIdOn, type PresetNode } from './nodes';

export const COMBOBOX_VERSION = 1;

export interface ComboboxOptions {
  seed: string;
  label?: string;
  options?: string[];
}

const FIELD_STYLE = { width: '100%', minHeight: '44px', padding: '8px 12px', border: '1px solid #d4d4d4', borderRadius: '6px', font: 'inherit', boxSizing: 'border-box' };
const LIST_STYLE = { margin: '4px 0 0', padding: '4px', listStyle: 'none', border: '1px solid #e5e5e5', borderRadius: '8px', background: '#fff' };
const OPTION_STYLE = { padding: '8px 12px', minHeight: '44px', boxSizing: 'border-box', cursor: 'pointer' };

const isList = (node: PresetNode): boolean => propsOf(node).role === 'listbox';

/** Writes every generated entry on the root, its field and its list. */
export function deriveCombobox(root: PresetNode): PresetNode {
  const children = root.children ?? [];
  const list = children.find(isList);
  const field = children.find((child) => propsOf(child).role === 'combobox');
  if (!list || !field) return root;
  const open = stateIdOn(root, 'open');
  const go = (move: 'next' | 'prev' | 'clear') => ({ rove: list.id, move });
  const set = (value: boolean) => ({ set: open, value });

  return derived({
    ...root,
    children: children.map((child) => {
      if (child === list) {
        // A press on an option copies its own text, which derive reads from it, so a pointer chooses as Enter does.
        // It chooses on the pointer's release, not on `click`: a touch on a list item that is not a control does
        // not always become a click (Linux WebKit drops it), while a release comes from every pointer, and a pan
        // ends in `pointercancel` instead, so scrolling the list chooses nothing. The click, where there is one,
        // gives the field its focus back, which only a press may do.
        const option = (node: PresetNode): PresetNode => (propsOf(node).role === 'option' && typeof propsOf(node).children === 'string'
          ? derived(node, {
              on: [
                { id: 'choose', on: 'pointerup', do: [{ setProp: field.id, prop: 'value', value: propsOf(node).children as string }, set(false)] },
                { id: 'refocus', on: 'click', do: [{ focus: field.id }] },
              ],
            })
          : node);
        return {
          ...derived(child, { showWhen: { state: open, eq: true }, group: { role: 'option', axis: 'line', wrap: true, virtual: { owner: field.id } } }),
          children: child.children?.map(option),
        };
      }
      if (child !== field) return child;
      return derived({ ...child, props: { ...child.props, 'aria-controls': list.id, 'aria-autocomplete': 'list' } as PresetNode['props'] }, {
        bind: [{ attr: 'aria-expanded', from: { get: open } }],
        on: [
          { id: 'type', on: 'input', do: [go('clear'), { filter: list.id, role: 'option', text: { event: 'value' } }, set(true)] },
          onKeys('down', ['ArrowDown'], set(true), go('next')),
          onKeys('up', ['ArrowUp'], set(true), go('prev')),
          { ...onKeys('choose', ['Enter'], { setProp: field.id, prop: 'value', value: { active: list.id } }, set(false)), if: { state: open, eq: true } },
          { id: 'close', on: 'keydown', keys: ['Escape'], do: [set(false)] },
        ],
      });
    }),
  }, {
    state: [{ id: open, name: 'List open', type: 'boolean', initial: false }],
    preset: { kind: 'combobox', version: COMBOBOX_VERSION },
  });
}

export function combobox({ seed, label = 'City', options = ['Bern', 'Zurich', 'Basel', 'Geneva'] }: ComboboxOptions): PresetNode {
  assertSeed(seed);
  const list = `${seed}-list`;
  return deriveCombobox(
    el(seed, 'div', { style: { maxWidth: '320px' } },
      el(`${seed}-label`, 'label', { htmlFor: `${seed}-field`, children: label }),
      el(`${seed}-field`, 'input', { id: `${seed}-field`, type: 'text', role: 'combobox', autoComplete: 'off', style: FIELD_STYLE }),
      el(list, 'ul', { id: list, role: 'listbox', 'aria-label': label, style: LIST_STYLE },
        ...options.map((text, index) => el(`${seed}-option-${index}`, 'li', { id: `${seed}-option-${index}`, role: 'option', children: text, style: OPTION_STYLE })))),
  );
}
