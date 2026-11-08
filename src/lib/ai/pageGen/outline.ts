// src/lib/ai/pageGen/outline.ts
//
// The outline of a running generation: one entry per section the model is
// about to write, so the canvas draws a skeleton in each place before the first
// section is complete (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 3, "In-editor Generate: an outline first").
//
// Two sources, merged per position in "nodes" (the slot):
//   - the "outline" the prompt asks the model to write first (emit_page's first
//     property), read by the scanner the moment its array closes;
//   - the fallback for a model that writes the nodes first, or no outline: an
//     entry per element the moment it opens and its label or type was read.
// A declared entry wins at its slot; an opened element fills the slots the
// outline does not cover (and the slots past its end).
//
// A preview hint only: the outline never reaches validation (withoutOutline),
// the result or the saved page. Client-safe: the editor's draft keeps the
// payload as it comes, and a caller can forward it unchanged (the MCP
// generate_page sends it to the site's open editors, src/server/sites/liveGeneration.ts).

import { PLAN_LIMITS, PLAN_SECTION_KINDS, sanitizePlanTitle, type PlanSectionKind } from '@/lib/projects/liveEvents';
import type { OpenedElement } from './sectionStream';

/** One planned section: what the skeleton says and the shape it takes. */
export interface OutlineEntry {
  /** Sanitised and capped (sanitizePlanTitle); empty when the model gave none. */
  title: string;
  kind: PlanSectionKind;
}

/** Entries one outline carries at most (as many as a skeleton plan of an agent). */
export const OUTLINE_MAX_ENTRIES = PLAN_LIMITS.sectionsPerPlan;

const KINDS = new Set<string>(PLAN_SECTION_KINDS);

/** A kind the model wrote, or generic. */
function kindOf(value: unknown): PlanSectionKind {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return KINDS.has(text) ? (text as PlanSectionKind) : 'generic';
}

/** One entry of the model's outline, whatever it holds. A position is never dropped: the slots must line up with the sections. */
function entryOf(raw: unknown): OutlineEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { title: '', kind: 'generic' };
  const entry = raw as { title?: unknown; kind?: unknown };
  return { title: sanitizePlanTitle(entry.title) ?? '', kind: kindOf(entry.kind) };
}

/** The model's outline as entries, at most OUTLINE_MAX_ENTRIES. */
export function normalizeOutline(raw: readonly unknown[]): OutlineEntry[] {
  return raw.slice(0, OUTLINE_MAX_ENTRIES).map(entryOf);
}

// Words in a section's layer name (or its tag) that say which shape it has,
// checked in this order (a "pricing faq" is pricing). English and German, the
// languages the generator writes most; anything else is generic.
const KIND_WORDS: ReadonlyArray<[PlanSectionKind, RegExp]> = [
  ['footer', /\bfoot(er)?\b|fußzeile|fusszeile|impressum/],
  ['hero', /\bhero\b|\bintro\b|\bheader\b|\bbanner\b|\babove the fold\b/],
  ['pricing', /\bpric(e|es|ing)\b|\bplans?\b|\btarif|\bpreise?\b/],
  ['faq', /\bfaqs?\b|\bquestions?\b|\bfragen\b/],
  ['testimonials', /testimonial|\breviews?\b|\bquotes?\b|\bstimmen\b|\bkundenstimmen\b|\bbewertung/],
  ['gallery', /\bgallery\b|\bgalerie\b|\bportfolio\b|\bphotos\b|\bimages\b|\bbilder\b/],
  ['form', /\bform\b|\bcontact\b|\bkontakt|\bformular\b|\bnewsletter\b|\bsignup\b|\bsign up\b|\banmeld/],
  ['cta', /\bcta\b|call to action|\bget started\b|\bclosing\b|\babschluss\b/],
  ['features', /\bfeatures?\b|\bservices?\b|\bbenefits?\b|\bofferings?\b|\bleistungen\b|\bvorteile\b|\bangebot\b/],
];

/** The shape a section probably has, from its layer name, its tag and its preset. */
export function kindFromElement(label: string | undefined, type: string | undefined, preset?: string): PlanSectionKind {
  const tag = (type ?? '').trim().toLowerCase();
  if (tag === 'footer') return 'footer';
  // A generated form is a div with the form preset (promptSections/forms.ts).
  if (tag === 'form' || (preset ?? '').trim().toLowerCase() === 'form') return 'form';
  const text = `${label ?? ''} ${tag === 'header' ? 'header' : ''}`.toLowerCase();
  for (const [kind, words] of KIND_WORDS) if (words.test(text)) return kind;
  return 'generic';
}

/**
 * The outline of one attempt, built up as the scanner reports. `declare` and
 * `open` say whether the merged entries changed (so a caller sends an update
 * only when there is something new); `entries` is the merged outline.
 */
export interface OutlineBuilder {
  declare(raw: readonly unknown[]): boolean;
  open(element: OpenedElement): boolean;
  entries(): OutlineEntry[];
}

export function createOutlineBuilder(): OutlineBuilder {
  let declared: OutlineEntry[] | undefined;
  const opened = new Map<number, { label?: string; type?: string; preset?: string }>();
  let last = '[]';

  const merged = (): OutlineEntry[] => {
    const known = declared ?? [];
    let length = known.length;
    for (const slot of opened.keys()) length = Math.max(length, slot + 1);
    length = Math.min(length, OUTLINE_MAX_ENTRIES);
    const out: OutlineEntry[] = [];
    for (let slot = 0; slot < length; slot += 1) {
      if (slot < known.length) {
        out.push(known[slot]);
        continue;
      }
      // A slot past the outline: what its element said so far, or a generic
      // block for an element that opened without a readable label or type.
      const element = opened.get(slot);
      out.push({ title: sanitizePlanTitle(element?.label) ?? '', kind: kindFromElement(element?.label, element?.type, element?.preset) });
    }
    return out;
  };

  const changed = (): boolean => {
    const next = JSON.stringify(merged());
    if (next === last) return false;
    last = next;
    return true;
  };

  return {
    declare(raw) {
      // The first outline counts; the scanner reports one at most anyway.
      if (declared !== undefined) return false;
      declared = normalizeOutline(raw);
      return changed();
    },
    open(element) {
      if (!Number.isInteger(element.slot) || element.slot < 0 || element.slot >= OUTLINE_MAX_ENTRIES) return false;
      const entry = opened.get(element.slot) ?? {};
      if (entry[element.key] !== undefined) return false;
      opened.set(element.slot, { ...entry, [element.key]: element.value });
      return changed();
    },
    entries: merged,
  };
}

/**
 * The tool input without its outline: what validation and everything after it
 * see. The outline is a preview hint and must never count toward the size
 * limit, reach the result or be saved.
 */
export function withoutOutline(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('outline' in input)) return input;
  const rest = { ...(input as Record<string, unknown>) };
  delete rest.outline;
  return rest;
}
