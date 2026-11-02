// src/lib/behaviour/names.ts
//
// What the server writes for the runtime to read. A leaf on purpose: the runtime is
// a chunk with a size limit, and everything else in this folder leads to the parser.
//
// PURE and client-safe: no React, no MST.

/** Marks a scope: a node declaring state, a clone root, a placement root. */
export const SCOPE_ATTR = 'data-fc-scope';
/** The node's key: what a reference resolves and what keys the program. */
export const NODE_ATTR = 'data-fc-n';
/** A clone's position in its Collection. */
export const ROW_ATTR = 'data-fc-i';
/** Which of a shared key's program entries this element runs. Absent means the first. */
export const VARIANT_ATTR = 'data-fc-v';
/** The value of one state on its scope. */
export const stateAttribute = (id: string): string => `data-fcs-${id}`;
/** Stands on `html` while state rules apply. */
export const GATE_ATTR = 'data-fc-b';
/** What the boot script leaves for the runtime. */
export const GATE_GLOBAL = '__fcB';
/** An attribute that is there or is not, whatever its text says. */
export const isBooleanAttribute = (name: string): boolean => name === 'inert' || name === 'open' || name === 'disabled';
