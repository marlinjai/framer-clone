// src/lib/live/activityText.ts
//
// The words of the live agent canvas (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 2), composed in the editor from what the stream sends (a tool name,
// an outcome, a page id, a count): the presence label's verb ("Editing"), the
// activity feed's line ("Wrote 4 changes on Home") and the top bar's note. A
// page title is content and never travels on the stream; the editor reads it
// from its own copy. Pure.

import type { AgentOutcome, LiveFeedLine } from '@/lib/projects/liveEvents';

const READ_TOOLS = new Set(['get_site', 'get_page', 'describe_vocabulary', 'list_revisions', 'preview_url']);

/** Whether a tool only reads. */
export function isReadTool(tool: string): boolean {
  return READ_TOOLS.has(tool);
}

/** What the presence label says the agent does: "Reading", "Editing", ... */
export function activityVerb(tool: string): string {
  switch (tool) {
    case 'apply_batch':
      return 'Editing';
    case 'generate_page':
      return 'Generating';
    case 'publish':
      return 'Publishing';
    case 'rollback':
      return 'Rolling back';
    case 'preview_url':
      return 'Previewing';
    default:
      return isReadTool(tool) ? 'Reading' : 'Working';
  }
}

/** The presence label: "Claude · Editing". */
export function presenceLabel(label: string, tool: string): string {
  return `${label || 'Agent'} · ${activityVerb(tool)}`;
}

/** The top bar's note for the active agents' labels. */
export function editingNote(labels: readonly string[]): string | null {
  const unique = [...new Set(labels.map((l) => l || 'Agent'))];
  if (unique.length === 0) return null;
  if (unique.length === 1) return `${unique[0]} is editing this site`;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]} are editing this site`;
  return `${unique.length} agents are editing this site`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function onPage(pageTitle: string | undefined): string {
  return pageTitle ? ` on ${pageTitle}` : '';
}

/** What a refused or failed call was, as a noun ("Changes", "Generation"). */
function attemptNoun(tool: string): string {
  switch (tool) {
    case 'apply_batch':
      return 'Changes';
    case 'generate_page':
      return 'Generation';
    case 'publish':
      return 'Publishing';
    case 'rollback':
      return 'Rollback';
    default:
      return 'A request';
  }
}

function refusal(tool: string, outcome: Exclude<AgentOutcome, 'ok'>): string {
  const noun = attemptNoun(tool);
  if (outcome === 'site_changed') return `${noun} refused: site changed, re-reading`;
  if (outcome === 'rejected') return `${noun} refused, nothing written`;
  return `${noun} failed`;
}

/** One feed line in plain words. `pageTitle` is the title of the line's page in the open copy, if it still exists. */
export function feedLineText(line: Pick<LiveFeedLine, 'tool' | 'outcome' | 'changes'>, pageTitle?: string): string {
  if (line.outcome !== 'ok') return refusal(line.tool, line.outcome);
  switch (line.tool) {
    case 'get_site':
      return 'Read the site';
    case 'get_page':
      return pageTitle ? `Read the ${pageTitle} page` : 'Read a page';
    case 'describe_vocabulary':
      return 'Read the building blocks';
    case 'list_revisions':
      return 'Read the published versions';
    case 'preview_url':
      return 'Opened a preview';
    case 'apply_batch':
      return line.changes !== undefined ? `Wrote ${plural(line.changes, 'change', 'changes')}${onPage(pageTitle)}` : `Edited the site${onPage(pageTitle)}`;
    case 'generate_page':
      return `Generated content${onPage(pageTitle)}`;
    case 'publish':
      return 'Published the site';
    case 'rollback':
      return 'Put an earlier version live';
    case 'create_site':
      return 'Created the site';
    default:
      return 'Worked on the site';
  }
}

/** The line's time as the feed shows it (local hours and minutes). */
export function feedLineTime(at: string, locale?: string): string {
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}
