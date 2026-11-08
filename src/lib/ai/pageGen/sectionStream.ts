// src/lib/ai/pageGen/sectionStream.ts
//
// Finds the complete top-level sections inside the page generator's tool input
// while the model is still writing it. The input streams as raw JSON text in
// fragments that may end anywhere: inside a string, inside an escape, between
// a key and its colon. The scanner keeps just enough state to know where it is
// (inside a string or not, the escape state, the bracket stack, the last key
// of the root object), finds the root object's "nodes" array, and hands back
// each element of it the moment its closing brace arrives, parsed.
//
// It is a preview helper, never the source of truth: the final tool input is
// still parsed and validated whole (runPageGeneration). So on anything it does
// not understand (a root that is not an object, a bracket that does not match,
// an element that does not parse) it stops yielding and never throws. Only
// object elements are yielded; anything else in the array is skipped.

/** Incremental scanner over one tool input. Feed it every fragment, in order. */
export interface SectionScanner {
  /** Feed the next fragment; returns the elements of "nodes" completed by it, in order. */
  push(fragment: string): unknown[];
  /** Elements yielded so far (including skipped ones that did not parse). */
  readonly seen: number;
  /** True once the input stopped making sense; nothing more is yielded. */
  readonly broken: boolean;
}

type Container = '{' | '[';

/** The scanner's position relative to the root object's "nodes" key. */
type NodesState =
  /** Not seen yet (or seen with a non-array value). */
  | 'before'
  /** The key "nodes" and its colon were read; the value comes next. */
  | 'awaitValue'
  /** Inside the array. */
  | 'inside'
  /** The array closed: nothing more to find. */
  | 'done';

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

export function createSectionScanner(): SectionScanner {
  const stack: Container[] = [];
  let inString = false;
  let escape = false;
  let broken = false;
  let started = false;
  let seen = 0;

  // The root object's keys: whether the next string at depth 1 is a key, and its raw text.
  let expectKey = false;
  let readingKey = false;
  let keyRaw = '';
  let lastKey: string | undefined;
  let nodes: NodesState = 'before';

  // The element of "nodes" being collected: its text so far, or null between elements.
  let element: string | null = null;
  // Depth of the array itself (the stack length while inside it, outside any element).
  let arrayDepth = 0;

  const decodeKey = (raw: string): string | undefined => {
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return undefined;
    }
  };

  const push = (fragment: string): unknown[] => {
    const out: unknown[] = [];
    if (broken || typeof fragment !== 'string' || fragment.length === 0) return out;
    try {
      // The part of this fragment that belongs to the element being collected.
      let elementFrom = element !== null ? 0 : -1;
      for (let i = 0; i < fragment.length; i += 1) {
        const ch = fragment[i];

        if (inString) {
          if (readingKey && !(ch === '"' && !escape)) keyRaw += ch;
          if (escape) escape = false;
          else if (ch === '\\') escape = true;
          else if (ch === '"') {
            inString = false;
            if (readingKey) {
              readingKey = false;
              lastKey = decodeKey(keyRaw);
              expectKey = false;
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

        // The value after "nodes": must be an array, or the key is ignored.
        if (nodes === 'awaitValue') {
          if (ch === '[' && depth === 1) {
            nodes = 'inside';
            stack.push('[');
            arrayDepth = stack.length;
            continue;
          }
          nodes = 'before';
        }

        switch (ch) {
          case '"':
            inString = true;
            if (depth === 1 && expectKey) {
              readingKey = true;
              keyRaw = '';
            }
            break;
          case '{':
          case '[':
            if (nodes === 'inside' && depth === arrayDepth && element === null) {
              if (ch === '{') {
                element = '';
                elementFrom = i;
              } else {
                // A nested array as an element: not a section, skipped.
                seen += 1;
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
                out.push(JSON.parse(text));
              } catch {
                // Not valid on its own (cannot happen for balanced JSON, but never trusted).
              }
            } else if (nodes === 'inside' && stack.length === arrayDepth - 1) {
              nodes = 'done';
            }
            break;
          }
          case ':':
            if (depth === 1 && lastKey === 'nodes' && nodes === 'before') nodes = 'awaitValue';
            break;
          case ',':
            if (depth === 1) {
              expectKey = true;
              lastKey = undefined;
            }
            break;
          default:
            // A bare value (number, true, false, null) inside the array is not a section.
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
