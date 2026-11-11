// src/lib/live/activityText.ts
//
// The words of the live agent canvas (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 2), composed in the editor from what the stream sends (a tool name,
// an outcome, a page id, a count): the presence label's verb ("Editing"), the
// activity feed's line ("Wrote 4 changes on Home") and the top bar's note. A
// page title is content and never travels on the stream; the editor reads it
// from its own copy. Pure.

import { PLAN_STOPPED_TOOL, type AgentOutcome, type LiveFeedLine } from '@/lib/projects/liveEvents';

const READ_TOOLS = new Set(['get_site', 'get_page', 'describe_vocabulary', 'list_revisions', 'preview_url']);

/** Whether a tool only reads. */
export function isReadTool(tool: string): boolean {
  return READ_TOOLS.has(tool);
}

/** The tools that plan sections: they draw skeletons and write nothing to the site. */
const PLAN_TOOLS = new Set(['announce_sections', 'clear_sections']);

/** The tools that change what visitors see (the published site), never the copy the person edits. */
const PUBLISH_TOOLS = new Set(['publish', 'rollback']);

/** Whether a tool writes to the copy the person edits (neither a read, a plan nor a publish): a conflict may follow. */
export function writesSite(tool: string): boolean {
  return !READ_TOOLS.has(tool) && !PLAN_TOOLS.has(tool) && !PUBLISH_TOOLS.has(tool);
}

/** What the active agents do, from least to most likely to conflict with the person's edits. */
export type ActivityMode = 'reading' | 'planning' | 'publishing' | 'editing';
export const ACTIVITY_MODE_RANK: Record<ActivityMode, number> = { reading: 0, planning: 1, publishing: 1, editing: 2 };

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
      return 'Putting an earlier version live';
    case 'preview_url':
      return 'Previewing';
    case 'announce_sections':
    case 'clear_sections':
      return 'Planning';
    default:
      return isReadTool(tool) ? 'Reading' : 'Working';
  }
}

/** The presence label: "Claude · Editing", or "Claude · Writing Pricing" on the skeleton of an announced section it fills. */
export function presenceLabel(label: string, tool: string, sectionTitle?: string): string {
  if (sectionTitle) return `${label || 'Agent'} · Writing ${sectionTitle}`;
  return `${label || 'Agent'} · ${activityVerb(tool)}`;
}

/** Who did something, from the labels of one or more agents: "Claude", "Claude and Codex", "3 agents". */
function whoOf(labels: readonly string[]): string {
  // One entry per agent: two agents with the same label are still two agents.
  const names = labels.map((l) => l || 'Agent');
  if (names.length === 1) return names[0];
  if (names.length === 2 && names[0] !== names[1]) return `${names[0]} and ${names[1]}`;
  return `${names.length} agents`;
}

/**
 * The top bar's note for the active agents: "Claude is reading this site"
 * while every active agent's latest call only reads, "Claude is planning
 * changes to this site" while one plans sections (nothing written yet),
 * "Claude is changing what visitors see" while one publishes or puts an earlier
 * version live (the copy the person edits stays as it is), "Claude is editing
 * this site" as soon as one writes to that copy (a conflict may follow then).
 */
export function editingNote(agents: ReadonlyArray<{ label: string; tool: string }>, edited = false): string | null {
  const mode = activityMode(agents, edited);
  if (!mode) return null;
  const who = whoOf(agents.map((a) => a.label));
  const verb = agents.length === 1 ? 'is' : 'are';
  if (mode === 'planning') return `${who} ${verb} planning changes to this site`;
  if (mode === 'publishing') return `${who} ${verb} changing what visitors see`;
  return `${who} ${verb} ${mode} this site`;
}

/**
 * What the active agents do: only read, plan sections, or edit; undefined while none is active.
 * `edited`: an agent wrote to the site earlier in this run, so it stays "editing" while it reads
 * or plans in between.
 */
export function activityMode(agents: ReadonlyArray<{ tool: string }>, edited = false): ActivityMode | undefined {
  if (agents.length === 0) return undefined;
  if (edited || agents.some((a) => writesSite(a.tool))) return 'editing';
  if (agents.some((a) => PUBLISH_TOOLS.has(a.tool))) return 'publishing';
  return agents.some((a) => PLAN_TOOLS.has(a.tool)) ? 'planning' : 'reading';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A page title as the feed quotes it. */
function quoted(title: string): string {
  return `‘${title}’`;
}

function onPage(pageTitle: string | undefined): string {
  return pageTitle ? ` on ${quoted(pageTitle)}` : '';
}

/** What a refused or failed call was, as a noun ("Changes", "Publishing"). */
function attemptNoun(tool: string): string {
  switch (tool) {
    case 'apply_batch':
      return 'Changes';
    case 'generate_page':
      return 'Generating content';
    case 'publish':
      return 'Publishing';
    case 'rollback':
      return 'Putting an earlier version live';
    case 'announce_sections':
      return 'Planned sections';
    case 'clear_sections':
      return 'Removing the planned sections';
    default:
      return 'A step';
  }
}

/** What a call the site refused because it changed meanwhile did not do. */
function notDone(tool: string): string {
  switch (tool) {
    case 'apply_batch':
      return 'Changes not written';
    case 'generate_page':
      return 'Generated content not saved';
    case 'announce_sections':
      return 'Planned sections not saved';
    default:
      return `${attemptNoun(tool)} stopped`;
  }
}

function refusal(tool: string, outcome: Exclude<AgentOutcome, 'ok'>): string {
  const noun = attemptNoun(tool);
  // No promise of a retry: the agent decides that, and may stop.
  if (outcome === 'site_changed') return `${notDone(tool)}: the site changed meanwhile`;
  if (outcome === 'rejected') return `${noun} refused, nothing written`;
  if (outcome === 'awaiting_approval') return `${noun} needs your approval`;
  if (outcome === 'declined') return `${noun} declined, nothing changed`;
  // A failure may have come after a write committed: no promise that nothing changed.
  return `${noun} failed`;
}

export type FeedLineWords = Pick<LiveFeedLine, 'tool' | 'outcome'> & Partial<Pick<LiveFeedLine, 'label' | 'pageId' | 'changes' | 'deletedPageIds' | 'deletedPages'>>;

/** How many pages a line deleted: the uncapped count, else the ids it carries. */
function deletedCount(line: Partial<Pick<LiveFeedLine, 'deletedPageIds' | 'deletedPages'>>): number {
  return line.deletedPages ?? line.deletedPageIds?.length ?? 0;
}

/** A batch's words: "Wrote 4 changes on 'Home'", "Deleted the page 'About'", "Wrote 4 changes and deleted 1 page". */
function batchText(line: FeedLineWords, pageTitle: string | undefined, deletedTitles: ReadonlyArray<string | undefined>): string {
  const deleted = deletedCount(line);
  // The line's page is the deleted one: no "on" for a page that is gone.
  const page = line.pageId && line.deletedPageIds?.includes(line.pageId) ? undefined : pageTitle;
  if (deleted === 0) {
    return line.changes !== undefined ? `Wrote ${plural(line.changes, 'change', 'changes')}${onPage(page)}` : `Edited the site${onPage(page)}`;
  }
  const title = deleted === 1 ? deletedTitles[0] : undefined;
  const others = Math.max(0, (line.changes ?? deleted) - deleted);
  if (others === 0) return deleted === 1 ? `Deleted ${title ? `the page ${quoted(title)}` : 'a page'}` : `Deleted ${deleted} pages`;
  const deletion = title ? `the page ${quoted(title)}` : plural(deleted, 'page', 'pages');
  return `Wrote ${plural(others, 'change', 'changes')}${onPage(page)} and deleted ${deletion}`;
}

/**
 * One feed line in plain words. `pageTitle` is the title of the line's page in
 * the open copy, if it still exists; `deletedTitles` the titles the editor
 * still knows of the pages the line deleted, in the order of `deletedPageIds`
 * (a page deleted before this editor saw it has none: "Deleted a page").
 */
export function feedLineText(line: FeedLineWords, pageTitle?: string, deletedTitles: ReadonlyArray<string | undefined> = []): string {
  if (line.outcome !== 'ok') return refusal(line.tool, line.outcome);
  switch (line.tool) {
    case 'get_site':
      return 'Read the site';
    case 'get_page':
      return pageTitle ? `Read the page ${quoted(pageTitle)}` : 'Read a page';
    case 'describe_vocabulary':
      return 'Read the building blocks';
    case 'list_revisions':
      return 'Read the published versions';
    case 'preview_url':
      return 'Opened a preview';
    case 'apply_batch':
      return batchText(line, pageTitle, deletedTitles);
    case 'generate_page':
      return `Generated content${onPage(pageTitle)}`;
    case 'publish':
      return 'Published the site';
    case 'rollback':
      return 'Put an earlier version live';
    case 'create_site':
      return 'Created the site';
    case 'merge_branch':
      return 'Merged a branch into the site';
    case 'update_branch':
      return 'Brought the changes from main into the branch';
    case 'announce_sections':
      return `Planned sections${onPage(pageTitle)}`;
    case 'clear_sections':
      return 'Removed the planned sections';
    case PLAN_STOPPED_TOOL:
      return `Planned sections removed: ${line.label || 'the agent'} stopped`;
    default:
      return 'Worked on the site';
  }
}

/**
 * Whether a line asks for the person's attention when it arrives: a refusal, an approval needed,
 * a decline, a failure. Not "the site changed meanwhile": that is ordinary concurrency the agent
 * recovers from by itself (it reads again and retries), and it can repeat often while the person
 * edits too. The feed still shows it.
 */
export function needsAttention(line: Pick<LiveFeedLine, 'outcome'>): boolean {
  return line.outcome !== 'ok' && line.outcome !== 'site_changed';
}

/** A line that needs attention as a screen reader hears it when it arrives: the agent first. */
export function feedLineAnnouncement(line: FeedLineWords): string {
  return `${line.label || 'Agent'}: ${feedLineText(line)}`;
}

/** The notice when an agent's write deleted the page this editor had open: "Claude deleted the page 'About'." */
export function deletedOpenPageNotice(label: string | undefined, title: string | undefined): string {
  const who = label || 'An agent';
  return title ? `${who} deleted the page ${quoted(title)}.` : `${who} deleted the page you had open.`;
}

/** What the person hears when the camera stops following because they moved it. */
export function followOffAnnouncement(label: string | undefined): string {
  return `Stopped following ${label || 'the agent'}. Turn Follow back on to follow again.`;
}

/** The Follow toggle's tooltip. */
export function followTitle(on: boolean, label: string | undefined): string {
  const who = label || 'the agent';
  return on ? `The canvas follows ${who}` : `Follow ${who} on the canvas`;
}

/** The line's time as the feed shows it (local hours and minutes). */
export function feedLineTime(at: string, locale?: string): string {
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}
