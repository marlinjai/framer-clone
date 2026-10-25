'use client';
// src/components/sidebars/right/sections/FormSection.tsx
//
// The properties panel's Form section (published site essentials, decision 4).
// One section for the three form kinds (src/lib/forms/definition.ts):
//
//   - Form: its name (how submissions are grouped), what happens after a
//     successful send (an inline message, or a redirect to a page of this site
//     picked from the site's pages, with "Create thank-you page"), and where
//     the submissions are read.
//   - Field: label, name (the key the value is stored under), placeholder,
//     required, minimum and maximum length (text types), options (select), and
//     the control's colours and corner radius.
//   - Submit button: its label while sending (the label itself is edited on
//     the canvas or here).
//
// Every edit is a props change on the component (setProps), so it is one
// undoable step like any other edit and is saved and published with the page.

import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ClipboardList } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { useStore } from '@/hooks/useStore';
import {
  FORM_LIMITS,
  TYPE_LENGTH,
  collectFormFields,
  formKindOf,
  isCheckboxType,
  normalizeFieldKey,
  readFieldSpec,
  readFormSettings,
  readOptions,
} from '@/lib/forms/definition';
import { isLinkablePageSlug } from '@/lib/forms/paths';
import { CollapsibleSection, ColorInput, PropertyRow, PropertySelect, PropertySwitch, TextInput } from '../primitives';
import { FIELD_CONTROL } from '../primitives/field';

interface FormSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

const HINT = 'text-[11px] leading-snug text-muted-foreground';

const FIELD_TYPE_LABELS: Record<string, string> = {
  text: 'Text input',
  email: 'Email input',
  tel: 'Phone input',
  textarea: 'Textarea',
  select: 'Select',
  checkbox: 'Checkbox',
  consent: 'Consent checkbox',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const FormSettingsControls = observer(({ component }: { component: ComponentInstance }) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const props = component.props as Record<string, unknown>;
  const settings = readFormSettings(props);
  const behavior = props.successBehavior === 'redirect' ? 'redirect' : 'message';
  const pages = project
    ? Array.from(project.pages.values()).filter((p) => isLinkablePageSlug(p.slug))
    : [];
  const target = typeof props.redirectPageId === 'string' ? props.redirectPageId : '';
  const targetMissing = behavior === 'redirect' && target !== '' && !pages.some((p) => p.id === target);
  const fields = collectFormFields(component as unknown as Parameters<typeof collectFormFields>[0]);
  const hasPersonalData = fields.some((f) => f.type === 'email' || f.type === 'tel' || f.type === 'text' || f.type === 'textarea');
  const hasConsent = fields.some((f) => f.type === 'consent');
  const walk = (node: ComponentInstance): boolean =>
    node.children.some((c: ComponentInstance) => formKindOf(c.props as Record<string, unknown>) === 'form-submit' || walk(c));
  const hasSubmit = walk(component);

  const createThankYou = () => {
    if (!project) return;
    const page = project.createThankYouPage();
    component.setProps({ successBehavior: 'redirect', redirectPageId: page.id });
  };

  return (
    <>
      <PropertyRow label="Name" hint="Submissions are grouped by this name">
        <TextInput
          value={str(props.formName)}
          maxLength={FORM_LIMITS.maxFormNameChars}
          placeholder="Contact form"
          onChange={(e) => component.setProps({ formName: e.target.value })}
        />
      </PropertyRow>
      <PropertyRow label="On success">
        <PropertySelect
          label=""
          value={behavior}
          onChange={(v) => component.setProps({ successBehavior: v })}
          options={[
            { value: 'message', label: 'Show a message' },
            { value: 'redirect', label: 'Go to a page' },
          ]}
        />
      </PropertyRow>
      {behavior === 'message' ? (
        <PropertyRow label="Message">
          <TextInput
            value={str(props.successMessage)}
            maxLength={FORM_LIMITS.maxSuccessMessageChars}
            placeholder={settings.successMessage}
            onChange={(e) => component.setProps({ successMessage: e.target.value })}
          />
        </PropertyRow>
      ) : (
        <>
          <PropertyRow label="Page">
            <PropertySelect
              label=""
              value={target}
              placeholder="Choose a page"
              onChange={(v) => component.setProps({ redirectPageId: v || undefined })}
              options={pages.map((p) => ({ value: p.id, label: `${p.metadata.title || 'Untitled'} (/${p.slug})` }))}
            />
          </PropertyRow>
          <button
            type="button"
            onClick={createThankYou}
            className="h-7 w-full rounded-[6px] border border-border bg-background text-[12px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Create thank-you page
          </button>
          {(target === '' || targetMissing) && (
            <p className={HINT} role="note">
              {targetMissing
                ? 'The chosen page no longer exists. Visitors see the message instead until you pick a page.'
                : 'Pick a page, or visitors see the message instead.'}
            </p>
          )}
        </>
      )}
      {!hasSubmit && (
        <p className={HINT} role="note">
          This form has no submit button yet. Drag one in from Forms in the Components panel.
        </p>
      )}
      {hasPersonalData && !hasConsent && (
        <p className={HINT} role="note">
          This form collects personal data. Consider adding a consent checkbox that links to your privacy policy.
        </p>
      )}
      <p className={HINT}>
        Submissions are stored with your company and listed under Form submissions (the inbox button in the top bar).
        Email notifications are not available yet.
      </p>
    </>
  );
});

const OptionsEditor = ({ component }: { component: ComponentInstance }) => {
  const stored = readOptions((component.props as Record<string, unknown>).options);
  const [draft, setDraft] = useState(stored.join('\n'));
  const storedText = stored.join('\n');
  useEffect(() => setDraft(storedText), [storedText, component.id]);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`options-${component.id}`} className="text-[11px] leading-none text-muted-foreground">
        Options (one per line)
      </label>
      <textarea
        id={`options-${component.id}`}
        value={draft}
        rows={4}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => component.setProps({ options: readOptions(draft) })}
        className={`${FIELD_CONTROL} h-auto py-1.5`}
      />
    </div>
  );
};

function lengthValue(raw: unknown): string {
  return typeof raw === 'number' && raw > 0 ? String(raw) : '';
}

function parseLength(raw: string, ceiling: number): number | undefined {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, ceiling);
}

const FieldControls = observer(({ component }: { component: ComponentInstance }) => {
  const props = component.props as Record<string, unknown>;
  const spec = readFieldSpec(component as unknown as Parameters<typeof readFieldSpec>[0], 0);
  const checkbox = isCheckboxType(spec.type);
  const lengthLimited = !checkbox && spec.type !== 'select';
  const ceiling = TYPE_LENGTH[spec.type].ceiling;
  const nameKey = normalizeFieldKey(props.name);

  return (
    <>
      <p className={HINT}>{FIELD_TYPE_LABELS[spec.type]}</p>
      <PropertyRow label={checkbox ? 'Text' : 'Label'} hint={checkbox ? 'The text next to the box' : 'Shown above the field'}>
        <TextInput
          value={str(props.label)}
          maxLength={FORM_LIMITS.maxLabelChars}
          onChange={(e) => component.setProps({ label: e.target.value })}
        />
      </PropertyRow>
      <PropertyRow label="Name" hint="The key the value is stored and exported under">
        <TextInput
          value={str(props.name)}
          maxLength={FORM_LIMITS.maxKeyChars}
          mono
          onChange={(e) => component.setProps({ name: e.target.value })}
        />
      </PropertyRow>
      {str(props.name) !== '' && nameKey !== str(props.name) && (
        <p className={HINT} role="note">
          Stored as <code>{nameKey || spec.key}</code> (letters, digits, _ and - only).
        </p>
      )}
      {!checkbox && (
        <PropertyRow label="Placeholder">
          <TextInput
            value={str(props.placeholder)}
            maxLength={FORM_LIMITS.maxLabelChars}
            onChange={(e) => component.setProps({ placeholder: e.target.value })}
          />
        </PropertyRow>
      )}
      <PropertyRow label="Required">
        <PropertySwitch checked={spec.required} onCheckedChange={(on) => component.setProps({ required: on })} />
      </PropertyRow>
      {lengthLimited && (
        <>
          <PropertyRow label="Min length" hint="Fewest characters accepted">
            <TextInput
              inputMode="numeric"
              value={lengthValue(props.minLength)}
              placeholder="none"
              onChange={(e) => component.setProps({ minLength: parseLength(e.target.value, ceiling) })}
            />
          </PropertyRow>
          <PropertyRow label="Max length" hint={`Most characters accepted (at most ${ceiling})`}>
            <TextInput
              inputMode="numeric"
              value={lengthValue(props.maxLength)}
              placeholder={String(TYPE_LENGTH[spec.type].default)}
              onChange={(e) => component.setProps({ maxLength: parseLength(e.target.value, ceiling) })}
            />
          </PropertyRow>
        </>
      )}
      {spec.type === 'select' && <OptionsEditor component={component} />}
      {spec.type === 'select' && spec.options.length === 0 && (
        <p className={HINT} role="note">
          Add at least one option, or visitors cannot choose anything.
        </p>
      )}
      <PropertyRow label="Field fill">
        <ColorInput label="" value={str(props.inputBackground) || '#ffffff'} onChange={(v) => component.setProps({ inputBackground: v })} />
      </PropertyRow>
      <PropertyRow label="Border">
        <ColorInput label="" value={str(props.inputBorderColor) || '#d1d5db'} onChange={(v) => component.setProps({ inputBorderColor: v })} />
      </PropertyRow>
      {!checkbox && (
        <>
          <PropertyRow label="Field text">
            <ColorInput label="" value={str(props.inputTextColor) || '#111827'} onChange={(v) => component.setProps({ inputTextColor: v })} />
          </PropertyRow>
          <PropertyRow label="Radius">
            <TextInput
              value={str(props.inputRadius)}
              placeholder="8px"
              onChange={(e) => component.setProps({ inputRadius: e.target.value.trim() || undefined })}
            />
          </PropertyRow>
        </>
      )}
    </>
  );
});

const SubmitControls = observer(({ component }: { component: ComponentInstance }) => {
  const props = component.props as Record<string, unknown>;
  return (
    <>
      {/* The button's own label is edited in the Text section at the top of
          the panel (TextContentSection), like every text: one undo step per
          edit, and the field that works on a phone. */}
      <PropertyRow label="Sending" hint="Shown on the button while the form is being sent">
        <TextInput
          value={str(props.loadingLabel)}
          placeholder="Sending..."
          onChange={(e) => component.setProps({ loadingLabel: e.target.value })}
        />
      </PropertyRow>
      <p className={HINT}>On the published page the button is disabled while sending, so a form is never sent twice.</p>
    </>
  );
});

export const FormSection = observer(({ component }: FormSectionProps) => {
  const kind = formKindOf(component.props as Record<string, unknown>);
  if (!kind) return null;
  const title = kind === 'form' ? 'Form' : kind === 'form-field' ? 'Field' : 'Submit button';
  return (
    <CollapsibleSection title={title} icon={<ClipboardList size={14} />}>
      {kind === 'form' && <FormSettingsControls component={component} />}
      {kind === 'form-field' && <FieldControls component={component} />}
      {kind === 'form-submit' && <SubmitControls component={component} />}
    </CollapsibleSection>
  );
});

FormSection.displayName = 'FormSection';
