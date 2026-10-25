// Form components in the editor: the registry drop (a Form arrives with its
// fields and submit button), the static canvas rendering (accessible markup,
// never submitting), the properties panel's Form section (field settings, the
// success target with the site's pages and "Create thank-you page").

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { FORM_KIND_ATTR, collectFormFields } from '@/lib/forms/definition';
import { createComponentElement } from '@/lib/renderer/createComponentElement';
import { SECTION_MAP, getComponentCategory } from '../sectionConfig';

let currentProject: ProjectModelType | null = null;
vi.mock('@/hooks/useStore', () => ({
  useStore: () => ({ editorUI: { currentProject } }),
}));

import { FormSection } from '../sections/FormSection';

afterEach(() => {
  cleanup();
  currentProject = null;
});

function setup() {
  const project = ProjectModel.create({ id: 'proj', metadata: { title: 'Bakery' }, pages: {} });
  const home = project.createPage('Home');
  home.setSlug('');
  const formComponent = home.insertRegistryComponent('form', { kind: 'appTree' })!;
  currentProject = project;
  return { project, home, form: formComponent };
}

const kindOf = (c: ComponentInstance) => (c.props as Record<string, unknown>)[FORM_KIND_ATTR];

describe('dropping a Form', () => {
  it('arrives with name, email, message, consent and a submit button, each with its own id', () => {
    const { form } = setup();
    expect(kindOf(form)).toBe('form');
    expect(form.children.map((c: ComponentInstance) => (c.props as Record<string, unknown>).fieldType ?? kindOf(c))).toEqual([
      'text',
      'email',
      'textarea',
      'consent',
      'form-submit',
    ]);
    expect(new Set(form.children.map((c: ComponentInstance) => c.id)).size).toBe(5);
    expect(form.children.every((c: ComponentInstance) => c.parentId === form.id)).toBe(true);
    expect(collectFormFields(form as never).map((f) => f.key)).toEqual(['name', 'email', 'message', 'consent']);
  });

  it('the form, its fields and its button get the Form section first', () => {
    const { form } = setup();
    expect(getComponentCategory(form)).toBe('form');
    expect(getComponentCategory(form.children[0])).toBe('formField');
    expect(getComponentCategory(form.children[4])).toBe('formSubmit');
    expect(SECTION_MAP.form[0]).toBe('form');
    expect(SECTION_MAP.form).toContain('layout');
  });
});

describe('on the canvas', () => {
  it('renders a static form: a real label for each control, no focus, no submit', () => {
    const { form } = setup();
    const field = form.children[1];
    const submit = form.children[4];
    const onSubmit = vi.fn();
    const { container } = render(
      <div onSubmit={onSubmit}>
        {createComponentElement(form, { style: {} }, [
          <React.Fragment key="f">{createComponentElement(field, { style: {} }, [], undefined, { identity: { breakpointId: 'bp', componentId: field.id } })}</React.Fragment>,
          <React.Fragment key="s">{createComponentElement(submit, { style: {} }, [], 'Send')}</React.Fragment>,
        ])}
      </div>,
    );
    const input = screen.getByLabelText(/^Email/) as HTMLInputElement;
    expect(input.type).toBe('email');
    expect(input.tabIndex).toBe(-1);
    expect(input.readOnly).toBe(true);
    expect(container.querySelector(`[data-inner-component-id="${field.id}"]`)).not.toBeNull();
    const button = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(button.type).toBe('button');
    fireEvent.submit(container.querySelector('form')!);
    expect(container.querySelector('form')!.noValidate).toBe(true);
    // Form configuration never reaches the canvas DOM.
    expect(container.innerHTML).not.toContain('formName');
  });
});

describe('the Form section', () => {
  it('edits a field: label, name, required, max length', () => {
    const { form } = setup();
    const field = form.children[0];
    render(<FormSection component={field} />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Full name' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'full name' } });
    fireEvent.change(screen.getByLabelText('Max length'), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('switch'));
    const props = field.props as Record<string, unknown>;
    expect(props.label).toBe('Full name');
    expect(props.name).toBe('full name');
    expect(props.maxLength).toBe(1000);
    expect(props.required).toBe(false);
    expect(screen.getByText(/Stored as/).textContent).toContain('full_name');
  });

  it('a redirect form picks one of the site pages, or creates a thank-you page and points at it', () => {
    const { project, form } = setup();
    render(<FormSection component={form} />);
    fireEvent.change(screen.getByLabelText('On success'), { target: { value: 'redirect' } });
    expect((form.props as Record<string, unknown>).successBehavior).toBe('redirect');
    expect(screen.getByText(/Pick a page/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create thank-you page' }));
    const pageId = (form.props as Record<string, unknown>).redirectPageId as string;
    const page = project.pages.get(pageId)!;
    expect(page.slug).toBe('thank-you');
    const texts = page.appComponentTree.children.map((c: ComponentInstance) => (c.props as Record<string, unknown>).children);
    expect(texts[0]).toBe('Thank you!');
    expect((page.appComponentTree.children[2].props as Record<string, unknown>).href).toBe('/');
    // The picker offers the new page.
    expect(screen.getByRole('option', { name: /Thank you \(\/thank-you\)/ })).toBeTruthy();
  });

  it('warns when personal data is collected without a consent box, and when the button is missing', () => {
    const { form } = setup();
    form.removeChild(form.children[3].id);
    form.removeChild(form.children[3].id);
    render(<FormSection component={form} />);
    expect(screen.getByText(/consent checkbox/)).toBeTruthy();
    expect(screen.getByText(/no submit button/)).toBeTruthy();
    expect(screen.getByText(/Email notifications are not available yet/)).toBeTruthy();
  });

  it('edits the submit button sending label; its own label lives in the Text section', () => {
    const { form } = setup();
    const submit = form.children[4];
    render(<FormSection component={submit} />);
    expect(screen.queryByLabelText('Label')).toBeNull();
    fireEvent.change(screen.getByLabelText('Sending'), { target: { value: 'Booking...' } });
    expect((submit.props as Record<string, unknown>).loadingLabel).toBe('Booking...');
  });
});
