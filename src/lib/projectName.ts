// src/lib/projectName.ts
//
// The one rule for a project's display name, shared by the rename route
// (PATCH /api/projects/<id>) and both rename UIs (the dashboard card and the
// editor's top bar), so the client refuses exactly what the server refuses.
//
// A name is trimmed, then must be 1 to 100 characters and contain no control
// characters (C0/C1, DEL, and the Unicode line and paragraph separators), which
// would break the single-line places the name is shown.

import { z } from 'zod';

export const PROJECT_NAME_MAX_LENGTH = 100;

const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/u;

export type ProjectNameResult =
  | { ok: true; name: string }
  | { ok: false; message: string };

/** Validate and normalise (trim) a project name typed by a person. */
export function validateProjectName(raw: string): ProjectNameResult {
  const name = raw.trim();
  if (name.length === 0) {
    return { ok: false, message: 'A project needs a name.' };
  }
  // Count code points, not UTF-16 units, so an emoji counts as one character.
  if (Array.from(name).length > PROJECT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `A project name can be at most ${PROJECT_NAME_MAX_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARS.test(name)) {
    return { ok: false, message: 'A project name cannot contain line breaks or control characters.' };
  }
  return { ok: true, name };
}

/** zod form of {@link validateProjectName}: parses to the trimmed name. */
export const projectNameSchema = z.string().transform((raw, ctx) => {
  const result = validateProjectName(raw);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.message });
    return z.NEVER;
  }
  return result.name;
});
