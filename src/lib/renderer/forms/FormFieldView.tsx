// src/lib/renderer/forms/FormFieldView.tsx
//
// One form field as markup: a real `<label for>`, the control, and the error
// line the control names in `aria-describedby` (with `aria-invalid` while the
// value is wrong). The SAME markup on the editor canvas (static: the controls
// do not take focus or input, a click selects the field component) and on the
// published page (the island passes the value, the error and the handlers).
//
// No hooks, no 'use client': renderable on the server and the client alike.
// Styles are inline because a published page carries no stylesheet for them;
// the wrapper keeps the component's own style (the properties panel's spacing,
// width, typography), the control inherits the font and colour and takes the
// field's appearance props (src/lib/forms/definition.ts, readFieldAppearance).

import React from 'react';
import {
  fieldDomIds,
  isCheckboxType,
  type FieldAppearance,
  type FieldSpec,
} from '@/lib/forms/definition';
import type { FieldValue } from '@/lib/forms/validation';

export interface FormFieldViewProps {
  formId: string;
  field: FieldSpec;
  appearance: FieldAppearance;
  /** The wrapper's DOM props (style, identity attributes, editor handlers). */
  wrapperProps: Record<string, unknown>;
  value?: FieldValue;
  error?: string | null;
  /** 'editor': static canvas preview; 'live': the published, interactive field. */
  mode: 'editor' | 'live';
  disabled?: boolean;
  onChange?: (value: FieldValue) => void;
  onBlur?: () => void;
}

const ERROR_COLOR = '#b91c1c';
const ERROR_BORDER = '#dc2626';

function controlStyle(appearance: FieldAppearance, invalid: boolean, editor: boolean): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    font: 'inherit',
    fontSize: '1em',
    lineHeight: 1.4,
    color: appearance.textColor ?? 'inherit',
    background: appearance.background ?? '#ffffff',
    border: `1px solid ${invalid ? ERROR_BORDER : appearance.borderColor ?? '#d1d5db'}`,
    borderRadius: appearance.radius ?? '8px',
    ...(editor ? { pointerEvents: 'none' as const } : {}),
  };
}

const LABEL_STYLE: React.CSSProperties = { display: 'block', fontWeight: 500, marginBottom: '6px' };
const ERROR_STYLE: React.CSSProperties = { color: ERROR_COLOR, fontSize: '0.875em', margin: '6px 0 0' };

export function FormFieldView({
  formId,
  field,
  appearance,
  wrapperProps,
  value,
  error,
  mode,
  disabled,
  onChange,
  onBlur,
}: FormFieldViewProps) {
  const ids = fieldDomIds(formId, field);
  const editor = mode === 'editor';
  const invalid = !!error;
  const describedBy = invalid ? ids.error : undefined;
  const common = {
    id: ids.control,
    name: field.key,
    required: field.required,
    'aria-required': field.required || undefined,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    disabled: disabled || undefined,
    // On the canvas the control is a picture of itself: no focus, no typing.
    ...(editor ? { tabIndex: -1, readOnly: true } : {}),
    onBlur: editor ? undefined : onBlur,
  };
  const textValue = typeof value === 'string' ? value : '';
  const required = field.required ? (
    <span aria-hidden="true" style={{ color: ERROR_COLOR, marginLeft: '2px' }}>
      *
    </span>
  ) : null;

  let control: React.ReactNode;
  if (isCheckboxType(field.type)) {
    const checked = value === true;
    control = (
      <label htmlFor={ids.control} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: editor ? undefined : 'pointer' }}>
        <input
          {...common}
          type="checkbox"
          value="on"
          {...(editor ? { checked: false, onChange: () => {} } : { checked, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.checked) })}
          style={{ width: '18px', height: '18px', margin: '2px 0 0', flex: 'none', accentColor: appearance.borderColor, ...(editor ? { pointerEvents: 'none' as const } : {}) }}
        />
        <span>
          {field.label}
          {required}
        </span>
      </label>
    );
  } else {
    const style = controlStyle(appearance, invalid, editor);
    const handlers = editor
      ? { value: '', onChange: () => {} }
      : { value: textValue, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange?.(e.target.value) };
    let input: React.ReactNode;
    if (field.type === 'textarea') {
      input = (
        <textarea
          {...common}
          {...handlers}
          rows={5}
          placeholder={field.placeholder || undefined}
          maxLength={field.maxLength > 0 ? field.maxLength : undefined}
          minLength={field.minLength ?? undefined}
          style={{ ...style, resize: 'vertical', minHeight: '120px' }}
        />
      );
    } else if (field.type === 'select') {
      input = (
        <select {...common} {...handlers} style={style}>
          <option value="">{field.placeholder}</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    } else {
      input = (
        <input
          {...common}
          {...handlers}
          type={field.type}
          placeholder={field.placeholder || undefined}
          maxLength={field.maxLength > 0 ? field.maxLength : undefined}
          minLength={field.minLength ?? undefined}
          autoComplete={field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : undefined}
          inputMode={field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : undefined}
          style={style}
        />
      );
    }
    control = (
      <>
        <label htmlFor={ids.control} style={LABEL_STYLE}>
          {field.label}
          {required}
        </label>
        {input}
      </>
    );
  }

  return React.createElement(
    'div',
    { ...wrapperProps, 'data-form-field': field.type },
    control,
    // Always in the tree, so a screen reader hears an error the moment it appears.
    <p id={ids.error} aria-live="polite" style={{ ...ERROR_STYLE, ...(invalid ? {} : { margin: 0 }) }}>
      {error ?? ''}
    </p>,
  );
}

export default FormFieldView;
