// src/lib/ai/pageGen/promptSections/forms.ts
//
// The page generator's instructions for forms (published site essentials,
// decision 4, docs/plans/2026-10-23-published-site-essentials.md). Part of the
// cached system prefix, placed after the schema docs (so it does not count
// against the design brief's word budget). The props named here are exactly
// what the validator accepts on the form presets (src/lib/forms/generation.ts);
// raw form tags stay forbidden.

export const FORMS_PROMPT = [
  '# Forms',
  '',
  'Use a form only where a visitor sends something: a contact, booking, enquiry, quote or sign-up section.',
  'At most one form per page unless the brief asks for more. Build it only from the form presets, never',
  'from raw form, input, select or textarea tags:',
  '- The container: {"type":"div","preset":"form","props":{"formName":"Booking request","successMessage":"..."},',
  '  "children":[fields..., the submit button]}. It is a flex column; style it like the page (padding,',
  '  background, borderRadius, gap). Fields may sit in a grid div inside it (two short fields side by side',
  '  on desktop, stacked on mobile). Never put a form inside a form.',
  '- Fields: presets formText, formEmail, formPhone, formTextarea, formSelect, formCheckbox, formConsent.',
  '  Props: label (always, a real visible label in the page\'s language), name (a short key such as',
  '  "email" or "preferred_date", unique in the form), placeholder (an example value, never the only',
  '  label), required (true or false), minLength and maxLength (numbers, text fields only), options (an',
  '  array of strings, formSelect only). Optional control colours: inputBackground, inputBorderColor,',
  '  inputTextColor, inputRadius. A field never has children.',
  '- The submit button: preset formSubmit with its label in props.children (an action such as "Send',
  '  request", not "Submit") and loadingLabel (for example "Sending..."). It never has children.',
  '- Ask only for what the business needs: contact needs name, email and message; booking adds phone',
  '  (optional), a preferred date as a text field and the number of people when it fits.',
  '- When the form collects personal data (a name, an email, a phone number or a message), end the',
  '  fields with a required formConsent whose label says, in the page\'s language, that the details are',
  '  used to answer the request and points to the privacy policy.',
  '- Do not set successBehavior or redirectPageId: the owner chooses what happens after sending.',
].join('\n');
