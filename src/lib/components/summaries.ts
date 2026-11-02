// src/lib/components/summaries.ts
//
// What the page generator is told of a site's components, and what the generation
// route checks a placement against: one summary per definition, without its tree.
// See "AI generation" in docs/plans/2026-11-02-reusable-components.md.
//
// The editor builds summaries from the real definitions. The route rebuilds a
// skeleton of each definition from its summary (a root of the stored tag, the
// placements it holds, and a control when it holds one), which is all that
// `placementRefusal` and `contentModelRefusal` read. So the route refuses a cycle,
// a nesting past the limit, and a component a browser would move out of a link,
// with the same functions and the same reasons as the editor, and no definition's
// content travels to the model or the route.
//
// Names and descriptions are written by people, so the prompt carries them as data
// in a delimited block, never as instructions.
//
// PURE: no React, no MST. Client and server safe.

import { z } from 'zod';
import {
  holdsInteractive,
  placedDefinitionIds,
  type ComponentDefinition,
  type ComponentDefinitions,
  type StateKind,
} from './definition';
import { inputDefinitionRefusal, type InputDefinition } from './inputs';
import { COMPONENT_LIMITS, PLACEMENT_TYPE } from './placement';

export interface ComponentSummary {
  id: string;
  name: string;
  description?: string;
  inputs: InputDefinition[];
  states: { id: string; name: string; kind: StateKind }[];
  /** The tag of the definition's root. */
  rootTag: string;
  /** It holds a link or a control, its own or a nested component's. */
  holdsInteractive: boolean;
  /** The definitions it places, in its tree. */
  places: string[];
}

/** Where a generation lands, in component terms. */
export interface GenerationComponents {
  summaries: ComponentSummary[];
  /** The definition being edited, when the generation lands inside one. */
  insideDefinition?: string;
  /** The tags above the insertion point, nearest first. */
  ancestorTags?: string[];
}

/** The summaries of a site's definitions, for the request. */
export function componentSummaries(definitions: ComponentDefinitions): ComponentSummary[] {
  return Object.values(definitions).map((definition: ComponentDefinition) => {
    const tree = definition.page?.appComponentTree as unknown as { type?: unknown } | undefined;
    return {
      id: definition.id,
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
      inputs: definition.inputs,
      states: definition.states.map(({ id, name, kind }) => ({ id, name, kind })),
      rootTag: typeof tree?.type === 'string' ? tree.type : 'div',
      holdsInteractive: holdsInteractive(tree, definitions),
      places: [...new Set(placedDefinitionIds(tree))],
    };
  });
}

const STATE_KIND = z.enum(['hover', 'pressed', 'focused', 'custom']);
const ID = z.string().regex(/^[A-Za-z0-9_-]+$/).max(120);

/** The request field. Bounded by the component limits, and every input checked as stored ones are. */
export const GenerationComponentsSchema = z.strictObject({
  summaries: z
    .array(
      z.strictObject({
        id: ID,
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(300).optional(),
        inputs: z
          .array(z.unknown())
          .max(COMPONENT_LIMITS.inputsPerDefinition)
          .refine((inputs) => inputs.every((input) => inputDefinitionRefusal(input) === null), 'an input is not one a component may hold'),
        states: z.array(z.strictObject({ id: ID, name: z.string().trim().min(1).max(120), kind: STATE_KIND })).max(COMPONENT_LIMITS.statesPerDefinition),
        rootTag: z.string().regex(/^[a-z][a-z0-9-]*$/).max(40),
        holdsInteractive: z.boolean(),
        places: z.array(ID).max(200),
      }),
    )
    .max(COMPONENT_LIMITS.definitionsPerSite),
  insideDefinition: ID.optional(),
  ancestorTags: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/).max(40)).max(64).optional(),
});

/**
 * Definitions with only what the refusal checks read: a root of the stored tag, the
 * placements it holds, and a button when it holds a control. Never rendered.
 */
export function skeletonDefinitions(summaries: readonly ComponentSummary[]): ComponentDefinitions {
  const out: ComponentDefinitions = {};
  for (const summary of summaries) {
    out[summary.id] = {
      id: summary.id,
      name: summary.name,
      inputs: summary.inputs,
      states: summary.states,
      page: {
        appComponentTree: {
          id: `${summary.id}-root`,
          type: summary.rootTag,
          props: {},
          children: [
            ...summary.places.map((placed, index) => ({ id: `${summary.id}-p${index}`, type: PLACEMENT_TYPE, props: { component: placed }, children: [] })),
            ...(summary.holdsInteractive ? [{ id: `${summary.id}-control`, type: 'button', props: {}, children: [] }] : []),
          ],
        },
      } as unknown as ComponentDefinition['page'],
    };
  }
  return out;
}

/** "Card" or a definition id, to the summary it names. Names are matched without regard to case. */
export function summaryNamed(summaries: readonly ComponentSummary[], name: string): ComponentSummary | undefined {
  const wanted = name.trim();
  return summaries.find((summary) => summary.id === wanted)
    ?? summaries.find((summary) => summary.name.toLowerCase() === wanted.toLowerCase());
}
