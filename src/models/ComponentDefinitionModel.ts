// src/models/ComponentDefinitionModel.ts
//
// One reusable component of a site, as the editor holds it: a real PageModel plus
// its inputs and states, kept under ProjectModel.components. The page is never in
// ProjectModel.pages, so it has no address and is in no sitemap. Inputs and states
// are frozen values here, shaped by src/lib/components/definition.ts; the actions
// that change them are the model slice's.
//
// Contract: docs/plans/2026-11-02-reusable-components.md.

import { types, type Instance, type SnapshotOut } from 'mobx-state-tree';
import PageModel from './PageModel';
import {
  parseComponents,
  type ComponentDefinitions,
  type ParsedComponents,
  type StateDefinition,
} from '@/lib/components/definition';
import type { InputDefinition } from '@/lib/components/inputs';

export const ComponentDefinitionModel = types
  .model('ComponentDefinition', {
    id: types.identifier,
    name: types.string,
    description: types.maybe(types.string),
    page: PageModel,
    inputs: types.optional(types.frozen<InputDefinition[]>(), []),
    states: types.optional(types.frozen<StateDefinition[]>(), []),
    noScriptState: types.maybe(types.string),
  })
  .actions(self => ({
    setInputs(inputs: InputDefinition[]) {
      self.inputs = inputs;
    },
  }));

export type ComponentDefinitionInstance = Instance<typeof ComponentDefinitionModel>;
export type ComponentDefinitionSnapshotOut = SnapshotOut<typeof ComponentDefinitionModel>;

/**
 * `parseComponents`, for a value about to enter the model. A page that parses can
 * still fail PageModel's types, and one such definition must not make the whole
 * project impossible to open, so it is refused here like any other bad definition.
 */
export function parseModelComponents(raw: unknown): ParsedComponents {
  const { definitions, refused } = parseComponents(raw);
  const usable: ComponentDefinitions = {};
  const unusable = Object.entries(definitions).flatMap(([id, definition]) => {
    if (ComponentDefinitionModel.is(definition)) {
      usable[id] = definition;
      return [];
    }
    return [{ id, reason: 'its page does not fit the page model' }];
  });
  if (unusable.length > 0) {
    console.warn(`parseModelComponents: skipped ${unusable.length} definition(s)`, unusable.slice(0, 10));
  }
  return { definitions: usable, refused: [...refused, ...unusable] };
}
