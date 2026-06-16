// src/server/cms/columnTypeMap.ts
//
// The LOSSY 13 -> 8 column-type map. adapter-prisma has thirteen column types;
// the binding layer (src/lib/bindings/dataSource/types.ts) has eight. This
// function is the single, documented place where the difference is collapsed.
//
// Pure and React-free; no `server-only` guard so the build-time hydrator and
// any Node caller can reuse it freely.

import type { ColumnType as BindingColumnType } from '@/lib/bindings/dataSource/types';
import type { DataTableColumnType } from './types';

/**
 * Map an adapter-prisma column type to the binding-layer `ColumnType`.
 *
 * Lossless (8 of 13):
 *   text -> text, number -> number, date -> date, boolean -> boolean,
 *   select -> select, relation -> relation, file -> file,
 *   multi_select -> 'multi-select'  (underscore normalized to hyphen).
 *
 * Lossy fallbacks (5 of 13), best-effort and documented:
 *   url      -> text   (no url binding type; the href renders as text)
 *   formula  -> text   (computed value; surfaced as its text projection)
 *   rollup   -> text   (computed aggregate; surfaced as its text projection)
 *   created_time     -> date  (timestamp narrowed to a date binding)
 *   last_edited_time -> date  (timestamp narrowed to a date binding)
 */
export function mapDataTableColumnType(
  dt: DataTableColumnType,
): BindingColumnType {
  switch (dt) {
    // Lossless 1:1 mappings.
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'boolean':
      return 'boolean';
    case 'select':
      return 'select';
    case 'relation':
      return 'relation';
    case 'file':
      return 'file';

    // Underscore to hyphen normalization.
    case 'multi_select':
      return 'multi-select';

    // Lossy fallbacks to text (documented best-effort).
    case 'url':
      return 'text';
    case 'formula':
      return 'text';
    case 'rollup':
      return 'text';

    // Lossy fallbacks: timestamps narrowed to date.
    case 'created_time':
      return 'date';
    case 'last_edited_time':
      return 'date';

    default: {
      // Exhaustiveness guard: if adapter-prisma adds a 14th type, this fails to
      // compile. At runtime an unexpected value throws rather than silently
      // returning a wrong binding type.
      const exhaustive: never = dt;
      throw new Error(
        `mapDataTableColumnType: unsupported adapter-prisma column type ${String(exhaustive)}`,
      );
    }
  }
}
