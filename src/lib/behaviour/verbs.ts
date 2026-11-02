// src/lib/behaviour/verbs.ts
//
// The actions that touch the page beyond state. A chunk of its own beside the runtime,
// fetched only by a program that uses one, so a page of plain toggles stays at the core.
// See docs/plans/2026-11-02-behaviour-model.md, "Actions".
//
// The parser decides which of these may run from what. What only exists at run time is
// held here: a `showModal` no press asked for runs once per page load, and Escape closes
// it whatever was stored.
//
// A stored mistake the browser refuses, such as `showModal` on a connected element that
// is already open, costs that verb alone: it warns, and the sequence goes on.
//
// PURE and client-safe: no React, no MST.

import type { Action } from './format';
import { setAttr } from './dom';
import type { CreateVerbs, Kit, Run } from './program';

export { isTextEntry, keysAnswer } from './keys';

const PRESSES: ReadonlySet<string> = new Set(['click', 'keydown', 'keyup']);

/** Documents where a `showModal` that no press asked for has run. Outlives a restart. */
const modalShown = new WeakSet<Document>();

export const createVerbs: CreateVerbs = (kit: Kit) => {
  const refuse = (run: Run) => (error: unknown): void => {
    kit.warn(`the browser refused this: ${(error as Error).name}`, run.trigger.id);
  };

  const openModal = (dialog: HTMLDialogElement, run: Run): void => {
    if (dialog.open) return;
    // A press can open a modal any number of times. Nothing else opens one twice, so
    // no cycle through `close` can hold the page, and the consent banner, inert.
    if (!PRESSES.has(run.trigger.on)) {
      if (kit.surface === 'canvas' || modalShown.has(kit.doc)) return;
      modalShown.add(kit.doc);
      // Nobody asked for this one, so Escape always closes it, whatever was stored.
      setAttr(dialog, 'closedby', 'closerequest');
    }
    dialog.showModal();
  };

  const dialogVerb = (dialog: HTMLDialogElement, op: Extract<Action, { dialog: string }>['op'], run: Run): void => {
    if (op === 'showModal') openModal(dialog, run);
    else if (op === 'close' || (op === 'toggle' && dialog.open)) dialog.close();
    else if (!dialog.open) dialog.show();
  };

  return (action, run) => {
    kit.settle();
    if (!('dialog' in action)) {
      kit.warn('this action does not run here', run.trigger.id);
      return;
    }
    const target = kit.find(action.dialog, run.el);
    if (!target) {
      kit.warn('no such node', action.dialog);
      return;
    }
    try {
      dialogVerb(target as HTMLDialogElement, action.op, run);
    } catch (error) {
      refuse(run)(error);
    }
  };
};
