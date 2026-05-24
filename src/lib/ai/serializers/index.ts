// src/lib/ai/serializers/index.ts
//
// Barrel for the AI-prompt MST snapshot serializers. Everything in this
// folder is READ-ONLY against MST and deterministic — feeding the same
// input twice produces byte-identical JSON, which is what
// Anthropic's prompt-caching needs to hit on the cached prefix.
//
// Typical assembly (client-side, before POSTing to /api/ai/edit):
//
//   const stable = {
//     overview: serializeProjectOverview(project),
//     registry: serializeRegistry(),
//     breakpoints: serializeBreakpoints(project),
//   };
//   const volatile = {
//     pageSnapshot: serializePageTree(currentPage),
//     selectionSnapshot: serializeSelection(editorUI, project),
//   };
//
//   const prompt = [
//     toPromptString('project_overview', stable.overview),
//     toPromptString('component_registry', stable.registry),
//     toPromptString('breakpoints', stable.breakpoints),
//     // ⇡ everything above this line is cache-eligible
//     toPromptString('page_snapshot', volatile.pageSnapshot),
//     toPromptString('selection', volatile.selectionSnapshot),
//   ].join('\n\n');

export {
  normalize,
  stableStringify,
  toPromptString,
} from './normalize';

export {
  estimateTokens,
  truncateTreeToBudget,
} from './tokenBudget';

export {
  serializeSubtree,
} from './subtree';
export type { SerializedComponent } from './subtree';

export { serializePageTree } from './pageTree';

export { serializeProjectOverview } from './projectOverview';
export type { ProjectOverview } from './projectOverview';

export { serializeRegistry } from './registry';
export type { SerializedRegistry } from './registry';

export { serializeBreakpoints } from './breakpoints';
export type { SerializedBreakpoint } from './breakpoints';

export { serializeSelection } from './selection';
export type { SerializedSelectionItem } from './selection';
