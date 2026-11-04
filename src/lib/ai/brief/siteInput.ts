// src/lib/ai/brief/siteInput.ts
//
// The site context the brief helpers send, built from the live editor store
// with the same fields the generator's buildRequest sends
// (src/lib/ai/pageGen/editorBridge.ts): project name, Site settings, existing
// page titles and, for replace or insert, the selected component serialized
// and capped (smaller than the generator's, ideas need its gist only).

import type { ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { serializeSubtree } from '@/lib/ai/serializers/subtree';
import { siteContextFromSettings } from '@/lib/ai/pageGen/promptSections/siteContext';
import { contextFits, type BriefTargetKind, type IdeasRequest } from './schema';

/** About 2k tokens of the selected component: its structure and copy, not every style. */
const CONTEXT_TOKENS = 2_000;

export function buildBriefSiteInput(
  project: ProjectModelType,
  targetKind: BriefTargetKind,
  /** The selected component, only when the target can use it. */
  selected?: ComponentInstance,
): Omit<IdeasRequest, 'exclude'> {
  const base: Omit<IdeasRequest, 'exclude'> = {
    targetKind,
    projectName: project.metadata.title.slice(0, 120),
    existingPageTitles: project.pagesArray.map((p) => p.metadata.title.slice(0, 120)).slice(0, 100),
    siteContext: siteContextFromSettings(project.site, project.metadata.title, project.pagesArray),
  };
  if (targetKind === 'newPage' || !selected) return base;
  const context = serializeSubtree(selected, { maxTokens: CONTEXT_TOKENS });
  return contextFits(context) ? { ...base, context } : base;
}
