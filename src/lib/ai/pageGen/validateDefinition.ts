// src/lib/ai/pageGen/validateDefinition.ts
//
// A component the generator writes for structure it repeats, checked before it can
// reach a site (see "AI generation" in docs/plans/2026-11-02-reusable-components.md).
// The model writes, beside `nodes`,
//
//   "definitions": [{ "name": "Pricing card", "description": "...",
//     "inputs": [{ "id": "title", "name": "Title", "type": "text" }],
//     "root": { "type": "article", "children": [
//       { "type": "h3", "bindings": { "children": "{{input.title}}" } } ] } }]
//
// and places each by name, as it places the site's own. What this module decides:
//
//   - At most GENERATED_DEFINITIONS_MAX per generation, each named uniquely across the
//     site and the generation, with inputs as a stored definition may hold them.
//   - Its root goes through the generator's own node check, the one every node
//     passes, so a definition holds nothing a page could not. Its root is an element.
//   - The only bindings a generated node may hold are a definition's own inputs, read
//     into a slot that suits the input's type: text into `children`, a toggle into
//     `visible`, an image into `src` and `alt`, a link into `href`, a colour or a
//     number into a style. Everything else is a person's connection to make.
//   - A definition is for structure repeated at least twice: one placed once is
//     refused, so the model writes that content in place.
//
// PURE: no React, no MST. Client and server safe.

import { inputDefinitionRefusal, mayBindToSlot, type InputDefinition, type InputType } from '@/lib/components/inputs';
import { isAcceptedStyleKey } from './schema';
import { sitePathsOnly } from './validatePlacement';

/** At most this many components in one generation. */
export const GENERATED_DEFINITIONS_MAX = 6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The slots each input type may fill on a generated node. `style.*` stands for any accepted style key. */
const SLOTS_FOR: Readonly<Partial<Record<InputType, readonly string[]>>> = {
  text: ['children', 'alt', 'title', 'aria-label'],
  richtext: ['children'],
  number: ['children', 'style.*'],
  toggle: ['visible'],
  image: ['src', 'alt'],
  link: ['href'],
  file: ['href'],
  color: ['style.*'],
  border: ['style.*'],
  shadow: ['style.*'],
  transition: ['style.*'],
  cursor: ['style.*'],
};

const EXPRESSION = /^\{\{\s*input\.([A-Za-z0-9_-]{1,64})(?:\.(src|alt))?\s*\}\}$/;

/** One generated binding: the stored entry, or why it is dropped. */
export function checkBinding(
  slot: string,
  raw: unknown,
  inputs: readonly InputDefinition[],
): { ok: true; entry: { mode: 'read'; expression: string } } | { ok: false; reason: string } {
  const text = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw.expression === 'string' ? raw.expression : undefined;
  const match = text ? EXPRESSION.exec(text.trim()) : null;
  if (!match) return { ok: false, reason: `binding ${slot} must read one of the component's inputs, as "{{input.<id>}}"` };
  const input = inputs.find((candidate) => candidate.id === match[1]);
  if (!input) return { ok: false, reason: `binding ${slot} reads an input the component does not have: ${match[1]}` };
  if (match[2] && input.type !== 'image') return { ok: false, reason: `binding ${slot}: only an image has .${match[2]}` };
  if (input.type === 'image' && !match[2]) return { ok: false, reason: `binding ${slot}: an image is read as .src or .alt` };
  const allowed = SLOTS_FOR[input.type] ?? [];
  const isStyle = slot.startsWith('style.') && isAcceptedStyleKey(slot.slice('style.'.length));
  const fits = allowed.includes(slot) || (isStyle && allowed.includes('style.*'));
  if (!fits || !mayBindToSlot(input.type, slot)) return { ok: false, reason: `binding ${slot} cannot take a ${input.type} input` };
  if (input.type === 'image' && match[2] !== slot) return { ok: false, reason: `binding ${slot} reads the image's ${match[2]}, not its ${slot}` };
  return { ok: true, entry: { mode: 'read', expression: `{{input.${input.id}${match[2] ? `.${match[2]}` : ''}}}` } };
}

/** The bindings a generated node keeps, and a reason for each it does not. */
export function checkBindings(raw: unknown, inputs: readonly InputDefinition[]): { bindings: Record<string, { mode: 'read'; expression: string }>; problems: string[] } {
  const bindings: Record<string, { mode: 'read'; expression: string }> = {};
  const problems: string[] = [];
  if (!isRecord(raw)) return { bindings, problems: ['bindings must be an object, ignored'] };
  for (const [slot, entry] of Object.entries(raw)) {
    const checked = checkBinding(slot, entry, inputs);
    if (checked.ok) bindings[slot] = checked.entry;
    else problems.push(`${checked.reason}, dropped`);
  }
  return { bindings, problems };
}

/** A generated definition's head: everything but its root, or why it is refused. */
export function checkDefinitionHead(
  raw: unknown,
  taken: ReadonlySet<string>,
): { ok: true; name: string; description?: string; inputs: InputDefinition[] } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'a definition is an object with name, inputs and root' };
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 120) return { ok: false, reason: 'a definition needs a name of at most 120 characters' };
  if (taken.has(name.toLowerCase())) return { ok: false, reason: `the site or this generation already has a component named ${name}` };
  const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 300) : undefined;
  const rawInputs = raw.inputs === undefined ? [] : raw.inputs;
  if (!Array.isArray(rawInputs) || rawInputs.length > 40) return { ok: false, reason: `${name}: inputs is a list of at most 40` };
  const inputs: InputDefinition[] = [];
  for (const input of rawInputs) {
    const refusal = inputDefinitionRefusal(input);
    if (refusal) return { ok: false, reason: `${name}: ${refusal}` };
    const checked = input as InputDefinition;
    if (inputs.some((other) => other.id === checked.id)) return { ok: false, reason: `${name}: input ${checked.id} appears twice` };
    // A default picture or file from another host is not the owner's: the input starts empty.
    if (checked.default !== undefined && !sitePathsOnly(checked.type, checked.default)) {
      const { default: _dropped, ...rest } = checked;
      inputs.push(rest);
      continue;
    }
    inputs.push(checked);
  }
  if (!isRecord(raw.root)) return { ok: false, reason: `${name}: a definition needs a root element` };
  return { ok: true, name, ...(description ? { description } : {}), inputs };
}
