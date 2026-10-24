// src/lib/forms/definition.ts
//
// What a form IS, read from the component tree (published site essentials,
// decision 4, docs/plans/2026-10-23-published-site-essentials.md). One pure
// module that the editor canvas, the properties panel, the published island
// (src/lib/renderer/forms/FormIsland.tsx) and the submit endpoint
// (src/server/forms/submit.ts) all read, so the browser and the server always
// agree on which fields a form has, what each is called and which rules apply.
//
// A form is a component subtree, not a raw `<form>` tag: three registry kinds
// marked with the `data-form-kind` prop (never `data-component-kind`, which the
// CMS and commerce renderers turn into a "(no binding)" placeholder):
//
//   - `form`         the container (a div in the editor, a real <form> on the
//                    published page). Props: formName, successBehavior,
//                    successMessage, redirectPageId.
//   - `form-field`   one labelled control. Props: fieldType, label, name,
//                    placeholder, required, minLength, maxLength, options.
//   - `form-submit`  the submit button. Props: children (the label),
//                    loadingLabel.
//
// The server never trusts a field list from the request: it reads the PUBLISHED
// page snapshot, finds the form by its component id and collects the fields
// with `collectFormFields`, exactly as the island did when it rendered.
//
// Client-safe: no server imports.

export const FORM_KIND_ATTR = 'data-form-kind';

export const FORM_KINDS = ['form', 'form-field', 'form-submit'] as const;
export type FormKind = (typeof FORM_KINDS)[number];

export const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'checkbox', 'consent'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** True for the two checkbox-like types (a boolean value, the label sits after the box). */
export function isCheckboxType(type: FieldType): boolean {
  return type === 'checkbox' || type === 'consent';
}

/** Hard limits shared by the editor, the island and the endpoint. */
export const FORM_LIMITS = {
  /** Most fields one form collects; fields after this are not rendered as inputs nor accepted. */
  maxFields: 30,
  /** Longest form name. */
  maxFormNameChars: 120,
  /** Longest label (a consent text can be a sentence or two). */
  maxLabelChars: 500,
  /** Most options of a select. */
  maxOptions: 50,
  /** Longest option. */
  maxOptionChars: 200,
  /** Longest field key (the submitted name). */
  maxKeyChars: 64,
  /** Longest success message. */
  maxSuccessMessageChars: 500,
  /** Largest request body the endpoint reads, in bytes. */
  maxBodyBytes: 64 * 1024,
} as const;

/** Default and ceiling of `maxLength` per type (characters). Select and checkboxes have none. */
export const TYPE_LENGTH: Record<FieldType, { default: number; ceiling: number }> = {
  text: { default: 200, ceiling: 1000 },
  email: { default: 254, ceiling: 254 },
  tel: { default: 32, ceiling: 32 },
  textarea: { default: 5000, ceiling: 10000 },
  select: { default: FORM_LIMITS.maxOptionChars, ceiling: FORM_LIMITS.maxOptionChars },
  checkbox: { default: 0, ceiling: 0 },
  consent: { default: 0, ceiling: 0 },
};

/** Names reserved for the transport (hidden inputs); a field may never use them. */
export const RESERVED_KEY_PREFIX = '_';
export const TRANSPORT_FIELDS = {
  formId: '_form',
  honeypot: '_website',
  renderedAt: '_rendered',
} as const;

/** The non-DOM props of each kind: renderers strip these before emitting an element. */
export const FORM_CONFIG_PROPS: ReadonlySet<string> = new Set([
  FORM_KIND_ATTR,
  'formName',
  'successBehavior',
  'successMessage',
  'redirectPageId',
  'fieldType',
  'label',
  'name',
  'placeholder',
  'required',
  'minLength',
  'maxLength',
  'options',
  'loadingLabel',
  'inputBackground',
  'inputBorderColor',
  'inputTextColor',
  'inputRadius',
]);

/** Props without the form configuration (what a renderer may put on a DOM element). */
export function stripFormConfigProps<T extends Record<string, unknown>>(props: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (!FORM_CONFIG_PROPS.has(k)) out[k] = v;
  return out as T;
}

/** The look of a field's control, from the field's props (each optional). */
export interface FieldAppearance {
  background?: string;
  borderColor?: string;
  textColor?: string;
  radius?: string;
}

const CSS_VALUE = /^[#(),.%\w\s-]{1,64}$/;

export function readFieldAppearance(props: Record<string, unknown> | null | undefined): FieldAppearance {
  const p = props ?? {};
  const pick = (v: unknown) => (typeof v === 'string' && CSS_VALUE.test(v.trim()) ? v.trim() : undefined);
  return {
    background: pick(p.inputBackground),
    borderColor: pick(p.inputBorderColor),
    textColor: pick(p.inputTextColor),
    radius: pick(p.inputRadius),
  };
}

/** A node as every tree in the app looks: MST instances, snapshots and published ComponentNodes. */
export interface FormTreeNode {
  id?: string;
  props?: Record<string, unknown> | null;
  children?: readonly FormTreeNode[] | null;
}

export type SuccessBehavior = 'message' | 'redirect';

export interface FormSettings {
  name: string;
  successBehavior: SuccessBehavior;
  successMessage: string;
  /** The page a `redirect` form sends the visitor to (resolved to a path by the server). */
  redirectPageId: string | null;
}

export interface FieldSpec {
  /** The field component's id. */
  nodeId: string;
  /** The key the value is submitted and stored under: unique within the form. */
  key: string;
  type: FieldType;
  label: string;
  placeholder: string;
  required: boolean;
  /** Characters; null when the field has no minimum. */
  minLength: number | null;
  /** Characters; 0 for select and checkboxes. */
  maxLength: number;
  /** Select only. */
  options: string[];
}

export const DEFAULT_FORM_NAME = 'Contact form';
export const DEFAULT_SUCCESS_MESSAGE = 'Thank you. Your message has been sent.';

/** The `data-form-kind` of a node, or null when it is not part of a form. */
export function formKindOf(props: Record<string, unknown> | null | undefined): FormKind | null {
  const raw = props?.[FORM_KIND_ATTR];
  return typeof raw === 'string' && (FORM_KINDS as readonly string[]).includes(raw) ? (raw as FormKind) : null;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Control characters never belong in a label, a name or a message.
   
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function intOrNull(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : null;
}

export function fieldTypeOf(value: unknown): FieldType {
  return typeof value === 'string' && (FIELD_TYPES as readonly string[]).includes(value) ? (value as FieldType) : 'text';
}

/** The form container's settings, with every value bounded and defaulted. */
export function readFormSettings(props: Record<string, unknown> | null | undefined): FormSettings {
  const p = props ?? {};
  const redirectPageId = typeof p.redirectPageId === 'string' && p.redirectPageId.trim() ? p.redirectPageId.trim() : null;
  return {
    name: text(p.formName, FORM_LIMITS.maxFormNameChars) || DEFAULT_FORM_NAME,
    successBehavior: p.successBehavior === 'redirect' && redirectPageId ? 'redirect' : 'message',
    successMessage: text(p.successMessage, FORM_LIMITS.maxSuccessMessageChars) || DEFAULT_SUCCESS_MESSAGE,
    redirectPageId,
  };
}

/** Normalize a field name to a safe key (letters, digits, `_` and `-`), or '' when nothing is left. */
export function normalizeFieldKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let key = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, FORM_LIMITS.maxKeyChars);
  // `_form`, `_website` and the like belong to the transport.
  while (key.startsWith(RESERVED_KEY_PREFIX)) key = key.slice(1);
  return key;
}

/** Options of a select: an array of strings, or one option per line. Trimmed, de-duplicated, bounded. */
export function readOptions(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\n') : [];
  const out: string[] = [];
  for (const item of list) {
    const option = text(item, FORM_LIMITS.maxOptionChars);
    if (option && !out.includes(option)) out.push(option);
    if (out.length >= FORM_LIMITS.maxOptions) break;
  }
  return out;
}

/** One field's spec from its props (the key is made unique by collectFormFields). */
export function readFieldSpec(node: FormTreeNode, index: number): FieldSpec {
  const p = node.props ?? {};
  const type = fieldTypeOf(p.fieldType);
  const limits = TYPE_LENGTH[type];
  const lengthLimited = limits.ceiling > 0 && type !== 'select';
  const max = intOrNull(p.maxLength);
  const min = intOrNull(p.minLength);
  const maxLength = lengthLimited
    ? Math.min(limits.ceiling, max !== null && max > 0 ? max : limits.default)
    : type === 'select'
      ? FORM_LIMITS.maxOptionChars
      : 0;
  const minLength = lengthLimited && min !== null && min > 0 ? Math.min(min, maxLength) : null;
  const label = text(p.label, FORM_LIMITS.maxLabelChars);
  return {
    nodeId: typeof node.id === 'string' ? node.id : `field-${index + 1}`,
    key: normalizeFieldKey(p.name) || normalizeFieldKey(label) || `field_${index + 1}`,
    type,
    label: label || defaultLabel(type),
    placeholder: isCheckboxType(type) ? '' : text(p.placeholder, FORM_LIMITS.maxLabelChars),
    // A consent box is required unless the owner explicitly made it optional.
    required: p.required === true || p.required === 'true' || (type === 'consent' && p.required === undefined),
    minLength,
    maxLength,
    options: type === 'select' ? readOptions(p.options) : [],
  };
}

function defaultLabel(type: FieldType): string {
  switch (type) {
    case 'email':
      return 'Email';
    case 'tel':
      return 'Phone';
    case 'textarea':
      return 'Message';
    case 'select':
      return 'Choose one';
    case 'consent':
      return 'I agree that my details are stored to answer my request.';
    case 'checkbox':
      return 'Yes';
    default:
      return 'Text';
  }
}

/**
 * The fields of a form, in tree order (depth first), each with a key unique
 * within the form: a repeated name gets `_2`, `_3`. A form nested inside the
 * form is not descended into (its fields belong to it). At most
 * FORM_LIMITS.maxFields fields.
 */
export function collectFormFields(form: FormTreeNode): FieldSpec[] {
  const fields: FieldSpec[] = [];
  const used = new Set<string>();
  const walk = (node: FormTreeNode) => {
    for (const child of node.children ?? []) {
      if (fields.length >= FORM_LIMITS.maxFields) return;
      const kind = formKindOf(child.props);
      if (kind === 'form') continue;
      if (kind === 'form-field') {
        const spec = readFieldSpec(child, fields.length);
        let key = spec.key;
        let n = 2;
        while (used.has(key)) key = `${spec.key}_${n++}`;
        used.add(key);
        fields.push({ ...spec, key });
        continue;
      }
      walk(child);
    }
  };
  walk(form);
  return fields;
}

/** Depth-first search for the form container with this id. */
export function findFormNode<T extends FormTreeNode>(root: T | null | undefined, formId: string): T | null {
  if (!root) return null;
  const stack: FormTreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === formId && formKindOf(node.props) === 'form') return node as T;
    for (const child of node.children ?? []) stack.push(child);
  }
  return null;
}

/** Every form container in a tree, in tree order. */
export function listFormNodes<T extends FormTreeNode>(root: T | null | undefined): T[] {
  const out: T[] = [];
  const walk = (node: FormTreeNode) => {
    if (formKindOf(node.props) === 'form') out.push(node as T);
    for (const child of node.children ?? []) walk(child);
  };
  if (root) walk(root);
  return out;
}

/**
 * A stable signature of a form's fields (keys, types and rules). A draft the
 * island kept for a form whose published definition has since changed is
 * discarded on load, never filled into different fields.
 */
export function fieldsSignature(fields: readonly FieldSpec[]): string {
  return fields
    .map((f) => [f.key, f.type, f.required ? 1 : 0, f.minLength ?? '', f.maxLength, f.options.join('\u001f')].join(':'))
    .join('|');
}

/** DOM ids of one field's parts, unique on the page (component ids are unique). */
export function fieldDomIds(formId: string, field: Pick<FieldSpec, 'nodeId'>): { control: string; error: string; hint: string } {
  const base = `f-${safeId(formId)}-${safeId(field.nodeId)}`;
  return { control: base, error: `${base}-error`, hint: `${base}-hint` };
}

function safeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '');
}
