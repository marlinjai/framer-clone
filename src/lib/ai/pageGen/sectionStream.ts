// src/lib/ai/pageGen/sectionStream.ts
//
// Reads the page generator's tool input while the model is still writing it,
// for the preview on the canvas. The input streams as raw JSON text in
// fragments that may end anywhere: inside a string, inside an escape, between a
// key and its colon. The scanner keeps just enough state to know where it is
// (inside a string or not, the escape state, the bracket stack, the last key of
// the root object and of the element being written) and reports three things:
//
//   - the root object's "outline" array, parsed, the moment it closes (the
//     short plan of the page the prompt asks for first: the canvas draws a
//     skeleton per entry before any section is complete);
//   - each element of the root "nodes" array the moment it OPENS and its own
//     "label" or "type" string has been read (the fallback for a model that
//     writes the nodes before, or without, an outline: the slot still gets a
//     skeleton as soon as the model starts writing it);
//   - each element of "nodes" the moment its closing brace arrives, parsed.
//
// Elements are numbered by their position in "nodes" (`slot`), the same number
// for the opening and the completed element, and the same number the outline
// entry at that position has.
//
// It is a preview helper, never the source of truth: the final tool input is
// still parsed and validated whole (runPageGeneration), and the outline is
// dropped before that. So on anything it does not understand (a root that is
// not an object, a bracket that does not match, an element that does not
// parse) it stops reporting and never throws. Only object elements are
// reported; anything else in the array is skipped (a nested array still takes
// a slot, a bare value does not).

/** One element of "nodes", complete and parsed. */
export interface ScannedSection {
  /** Its position among the elements of "nodes", from 0. */
  slot: number;
  value: unknown;
}

/** One element of "nodes" that just opened: its own "label" or "type" was read. */
export interface OpenedElement {
  slot: number;
  /** The key that was read; an element reports each of the two at most once. */
  key: 'label' | 'type';
  value: string;
}

/** What one fragment completed, in input order within each list. */
export interface ScanStep {
  sections: ScannedSection[];
  /** The root "outline" array, once, the moment it closed (only when it parsed as an array). */
  outline?: unknown[];
  opened: OpenedElement[];
}

/** Incremental scanner over one tool input. Feed it every fragment, in order. */
export interface SectionScanner {
  /** Feed the next fragment; returns what it completed. */
  push(fragment: string): ScanStep;
  /** Elements of "nodes" completed so far (including skipped ones that did not parse). */
  readonly seen: number;
  /** True once the input stopped making sense; nothing more is reported. */
  readonly broken: boolean;
}

type Container = '{' | '[';

/** Where the scanner is relative to one root key whose value it wants ("nodes" or "outline"). */
type KeyState =
  /** Not seen yet (or seen with a value of the wrong type). */
  | 'before'
  /** The key and its colon were read; the value comes next. */
  | 'awaitValue'
  /** Inside the array. */
  | 'inside'
  /** The array closed (or was given up): nothing more to find. */
  | 'done';

/** What the string being read is, when the scanner keeps its text. */
type Capture = 'rootKey' | 'elementKey' | 'elementValue';

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/**
 * Bounds on the text kept while scanning, so hostile input cannot make the
 * preview hold more than this: an outline longer than this is not drawn (the
 * prompt asks for a few dozen tokens), a key or a label longer than this is not
 * read. The final result is never affected.
 */
export const SCAN_LIMITS = {
  outlineChars: 8_000,
  keyChars: 64,
  valueChars: 512,
} as const;

const ELEMENT_KEYS = new Set(['label', 'type']);

export function createSectionScanner(): SectionScanner {
  const stack: Container[] = [];
  let inString = false;
  let escape = false;
  let broken = false;
  let started = false;
  let seen = 0;

  // The string being kept (a key, or an element's label or type), its raw text,
  // and whether it outgrew its bound.
  let capture: Capture | null = null;
  let captureRaw = '';
  let captureOver = false;

  // The root object's keys.
  let expectKey = false;
  let lastKey: string | undefined;
  let nodes: KeyState = 'before';
  let outline: KeyState = 'before';
  let outlineText = '';

  // The element of "nodes" being collected: its text so far, or null between elements.
  let element: string | null = null;
  // Depth of the array itself (the stack length while inside it, outside any element).
  let arrayDepth = 0;
  // Slots handed out to elements so far (objects and nested arrays).
  let slots = 0;
  let slot = -1;
  // The element's own keys (directly inside its object, never a child's).
  let elementExpectKey = false;
  let elementLastKey: string | undefined;
  let elementAwait: 'label' | 'type' | null = null;
  let elementReported = new Set<string>();

  const decode = (raw: string): string | undefined => {
    try {
      const value: unknown = JSON.parse(`"${raw}"`);
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const startCapture = (kind: Capture) => {
    capture = kind;
    captureRaw = '';
    captureOver = false;
  };

  const push = (fragment: string): ScanStep => {
    const out: ScanStep = { sections: [], opened: [] };
    if (broken || typeof fragment !== 'string' || fragment.length === 0) return out;
    try {
      // The part of this fragment that belongs to the element being collected.
      let elementFrom = element !== null ? 0 : -1;
      for (let i = 0; i < fragment.length; i += 1) {
        const ch = fragment[i];

        if (outline === 'inside') {
          outlineText += ch;
          // Too long to be the short plan the prompt asks for: not drawn.
          if (outlineText.length > SCAN_LIMITS.outlineChars) {
            outline = 'done';
            outlineText = '';
          }
        }

        if (inString) {
          if (escape) {
            escape = false;
            if (capture) captureRaw += ch;
          } else if (ch === '\\') {
            escape = true;
            if (capture) captureRaw += ch;
          } else if (ch === '"') {
            inString = false;
            if (capture) {
              const kind = capture;
              const text = captureOver ? undefined : decode(captureRaw);
              capture = null;
              captureRaw = '';
              if (kind === 'rootKey') {
                lastKey = text;
                expectKey = false;
              } else if (kind === 'elementKey') {
                elementLastKey = text;
                elementExpectKey = false;
              } else {
                const key = elementAwait;
                elementAwait = null;
                if (key && text !== undefined && !elementReported.has(key)) {
                  elementReported.add(key);
                  out.opened.push({ slot, key, value: text });
                }
              }
            }
          } else if (capture) {
            captureRaw += ch;
          }
          if (capture && !captureOver) {
            const max = capture === 'elementValue' ? SCAN_LIMITS.valueChars : SCAN_LIMITS.keyChars;
            if (captureRaw.length > max) {
              captureOver = true;
              captureRaw = '';
            }
          }
          continue;
        }

        if (WHITESPACE.has(ch)) continue;

        if (!started) {
          // The tool input is an object; anything else is not ours to read.
          if (ch !== '{') {
            broken = true;
            return out;
          }
          started = true;
        }

        const depth = stack.length;
        const atElementRoot = element !== null && depth === arrayDepth + 1;

        // The value after "nodes" or "outline": must be an array, or the key is ignored.
        if (nodes === 'awaitValue') {
          if (ch === '[' && depth === 1) {
            nodes = 'inside';
            stack.push('[');
            arrayDepth = stack.length;
            continue;
          }
          nodes = 'before';
        }
        if (outline === 'awaitValue') {
          if (ch === '[' && depth === 1) {
            outline = 'inside';
            outlineText = '[';
            stack.push('[');
            continue;
          }
          outline = 'before';
        }
        // An element's label or type must be a string; any other value ends the wait.
        if (atElementRoot && elementAwait && ch !== '"') elementAwait = null;

        switch (ch) {
          case '"':
            inString = true;
            if (depth === 1 && expectKey) startCapture('rootKey');
            else if (atElementRoot && elementExpectKey) startCapture('elementKey');
            else if (atElementRoot && elementAwait) startCapture('elementValue');
            break;
          case '{':
          case '[':
            if (nodes === 'inside' && depth === arrayDepth && element === null) {
              if (ch === '{') {
                element = '';
                elementFrom = i;
                slot = slots;
                slots += 1;
                elementExpectKey = true;
                elementLastKey = undefined;
                elementAwait = null;
                elementReported = new Set();
              } else {
                // A nested array as an element: not a section, skipped (it keeps its slot).
                seen += 1;
                slots += 1;
              }
            }
            stack.push(ch);
            if (stack.length === 1) expectKey = true;
            break;
          case '}':
          case ']': {
            const open = stack.pop();
            if (open === undefined || (ch === '}' ? open !== '{' : open !== '[')) {
              broken = true;
              return out;
            }
            if (nodes === 'inside' && element !== null && stack.length === arrayDepth) {
              const text = element + fragment.slice(elementFrom, i + 1);
              element = null;
              elementFrom = -1;
              seen += 1;
              try {
                out.sections.push({ slot, value: JSON.parse(text) });
              } catch {
                // Not valid on its own (cannot happen for balanced JSON, but never trusted).
              }
            } else if (nodes === 'inside' && element === null && stack.length === arrayDepth - 1) {
              nodes = 'done';
            } else if (outline === 'inside' && stack.length === 1) {
              outline = 'done';
              try {
                const parsed: unknown = JSON.parse(outlineText);
                if (Array.isArray(parsed)) out.outline = parsed;
              } catch {
                // Not valid on its own: no outline, the fallback still draws skeletons.
              }
              outlineText = '';
            }
            break;
          }
          case ':':
            if (depth === 1 && nodes === 'before' && lastKey === 'nodes') nodes = 'awaitValue';
            else if (depth === 1 && outline === 'before' && lastKey === 'outline') outline = 'awaitValue';
            else if (atElementRoot && elementLastKey !== undefined && ELEMENT_KEYS.has(elementLastKey)) {
              elementAwait = elementLastKey as 'label' | 'type';
            }
            break;
          case ',':
            if (depth === 1) {
              expectKey = true;
              lastKey = undefined;
            } else if (atElementRoot) {
              elementExpectKey = true;
              elementLastKey = undefined;
            }
            break;
          default:
            // A bare value (number, true, false, null): nothing to read.
            break;
        }
      }
      if (element !== null && elementFrom >= 0) element += fragment.slice(elementFrom);
    } catch {
      broken = true;
    }
    return out;
  };

  return {
    push,
    get seen() {
      return seen;
    },
    get broken() {
      return broken;
    },
  };
}
