// src/lib/books/engine/payload.ts
//
// The render input of a draft as GET /api/books/documents/<id>/render-input
// answers it (WYSIWYG invoice editor plan, phase 1), and how the browser reads
// it back: the JSON carries dates as ISO strings, which become dates again
// here (the render model writes the document's `issuedAt` into the PDF's
// metadata, so a string where a date belongs would change the bytes). Light
// on purpose: no engine import, so the editor's page bundle does not carry the
// engine; the worker checks the template in full before drawing. The fields
// of the document and its lines are not checked one by one: a payload the
// editor broke (a quantity that is not an integer) fails in the worker as
// `render_failed` with the engine's message, still a named error and never a
// page drawn differently.

import type { RenderInput } from '@/server/books/render/model';
import { FONT_FILES } from '@/server/books/render/fontPins';
import { richTextSchema, type RichText } from '@/server/books/render/richText';
import type { FontFamily, TemplateDocumentV2 } from '@/server/books/template/schema';

import { BrowserRenderError } from './errors';

/** The wire format's version; a change to the shape is a new number. */
export const RENDER_INPUT_FORMAT = 1;

export interface LogoRef {
  sha256: string;
  contentType: 'image/png' | 'image/jpeg';
}

export interface RenderInputPayload {
  format: typeof RENDER_INPUT_FORMAT;
  documentId: string;
  /** The draft's version when the input was read (the counter every change of the editor carries). */
  documentVersion: number;
  /** The template's font family (the files the browser fetches). */
  fontFamily: FontFamily;
  /** Exactly what the server's draft render reads: the draft's live data. */
  input: RenderInput;
  /** The current version of the draft's template. */
  template: TemplateDocumentV2;
  /** The logos the template names that the company has (a named one missing here is drawn empty, as on the server). */
  logos: LogoRef[];
}

const SHA256 = /^[0-9a-f]{64}$/;

function invalid(path: string): never {
  throw new BrowserRenderError('invalid_input', `The render input is malformed at ${path}.`, { path });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A date from the JSON (an ISO string), or null; anything else is malformed. */
function reviveDate(v: unknown, path: string, nullable: boolean): Date | null {
  if (v instanceof Date) return v;
  if (v === null && nullable) return null;
  if (typeof v !== 'string') invalid(path);
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) invalid(path);
  return d;
}

/** Read the render input JSON: the shape checked, the dates revived. Throws `invalid_input` naming the path. */
export function parseRenderInputPayload(json: unknown): RenderInputPayload {
  if (!isObject(json)) invalid('$');
  if (json.format !== RENDER_INPUT_FORMAT) invalid('format');
  if (typeof json.documentId !== 'string') invalid('documentId');
  if (typeof json.documentVersion !== 'number') invalid('documentVersion');
  if (typeof json.fontFamily !== 'string' || !Object.hasOwn(FONT_FILES, json.fontFamily)) invalid('fontFamily');
  const template = json.template;
  if (!isObject(template) || !isObject(template.theme) || template.theme.fontFamily !== json.fontFamily) invalid('template.theme.fontFamily');
  const input = json.input;
  if (!isObject(input)) invalid('input');
  if (input.draft !== true) invalid('input.draft');
  const doc = input.document;
  if (!isObject(doc)) invalid('input.document');
  if (!Array.isArray(input.lines)) invalid('input.lines');
  if (!Array.isArray(json.logos)) invalid('logos');
  const logos = (json.logos as unknown[]).map((l, i): LogoRef => {
    if (!isObject(l) || typeof l.sha256 !== 'string' || !SHA256.test(l.sha256)) invalid(`logos.${i}.sha256`);
    if (l.contentType !== 'image/png' && l.contentType !== 'image/jpeg') invalid(`logos.${i}.contentType`);
    return { sha256: l.sha256 as string, contentType: l.contentType as LogoRef['contentType'] };
  });
  // The formatted texts the worker draws from: absent or null prints the plain text; anything else must be the
  // run model, checked by the same schema the server writes it with.
  const format = (key: 'introFormat' | 'outroFormat') => {
    const v = doc[key];
    if (v === undefined || v === null) return null;
    const parsed = richTextSchema.safeParse(v);
    if (!parsed.success) invalid(`input.document.${key}`);
    return parsed.data as RichText;
  };
  const document = {
    ...doc,
    introFormat: format('introFormat'),
    outroFormat: format('outroFormat'),
    issuedAt: reviveDate(doc.issuedAt, 'input.document.issuedAt', true),
    createdAt: reviveDate(doc.createdAt, 'input.document.createdAt', false),
    updatedAt: reviveDate(doc.updatedAt, 'input.document.updatedAt', false),
  };
  const lines = (input.lines as unknown[]).map((l, i) => {
    if (!isObject(l)) invalid(`input.lines.${i}`);
    return {
      ...l,
      createdAt: reviveDate(l.createdAt, `input.lines.${i}.createdAt`, false),
      updatedAt: reviveDate(l.updatedAt, `input.lines.${i}.updatedAt`, false),
    };
  });
  return {
    format: RENDER_INPUT_FORMAT,
    documentId: json.documentId as string,
    documentVersion: json.documentVersion as number,
    fontFamily: json.fontFamily as FontFamily,
    input: { ...(input as unknown as RenderInput), document: document as unknown as RenderInput['document'], lines: lines as unknown as RenderInput['lines'] },
    template: template as unknown as TemplateDocumentV2,
    logos,
  };
}
