// src/server/books/http/bodies.ts
//
// Request body shapes shared by more than one Books route. They only check the
// SHAPE (types, known keys); the repository validates the values (ranges,
// formats) and answers INVALID_INPUT / INVALID_LINE with the field names.
// Route modules may only export route handlers, so shared schemas live here.

import { z } from 'zod';

/** The editable fields of a line (add and edit). */
export const lineFieldsBody = {
  kind: z.enum(['service', 'product', 'text']).optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  quantity: z.number().int().optional(),
  unitLabel: z.string().optional(),
  unitPrice: z.number().int().optional(),
  discountBp: z.number().int().optional(),
  taxClass: z.enum(['standard', 'reduced', 'zero']).nullable().optional(),
  taxRateOverride: z.number().int().nullable().optional(),
  expectedVersion: z.number().int().min(0).optional(),
};
