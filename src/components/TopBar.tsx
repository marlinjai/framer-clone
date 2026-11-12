// src/components/TopBar.tsx
// Editor top bar: project title (left), reserved space (middle, intended for
// future tool-category tabs like Insert / Layout / Text), the site actions,
// and undo / redo + history dropdown (right). Page navigation lives in the
// left sidebar's Pages pane, not here (see LeftSidebar.tsx).
//
// Under 1024px wide the bar is compact (plan
// docs/plans/2026-10-24-editor-on-phones.md): back link, the project name
// (truncating; the page name is hidden), the save status, Preview, Publish and a More
// menu that holds Generate, Polish, Domains, Site settings, Form submissions
// and History. Undo and redo stay reachable in the bottom bar on every size.
// Which controls each bar shows is CSS (`lg:`), so the bar is right from the first paint; only the More menu's
// list, read when it opens, asks the same media query in script.
//
// From 1024px up the bar folds by what it holds (docs/plans/2026-11-12-top-bar-fold.md,
// src/components/topbar/fold.ts): first the words of Generate, Polish, Share
// preview and Review and merge, then the page name narrows, then the secondary
// icons move into the same More menu. Undo, redo, preview, the save status and the
// agent chip never fold, and the agent chip has a slot of its own beside the save
// status. The fold is measured in a layout effect, so each step lands before paint.
// Each dialog exists once: this bar owns its open state, the wide bar's
// buttons and the More menu's items open the same instance. On a phone the bar
// is 48px high instead of 64px.
//
// Marked data-editor-ui so the drag resolver treats hits here as chrome
// (cancels drops silently).
'use client';

import React from 'react';
import { useIsPhone, useMediaQuery } from '@/hooks/use-mobile';
import { MORE_TRIGGER_ATTR, useTopBarFold, type FoldLevel } from '@/components/topbar/fold';
import { TooltipProvider } from '@/components/ui/tooltip';
import { BarTooltip } from '@/components/topbar/BarTooltip';
import { COMPACT_TOP_BAR_QUERY } from '@/components/TopBarStatus';
import { hapticsEnabled, hapticsSupported, onHapticsPreferenceChange, setHapticsEnabled } from '@/lib/haptics';
import { observer } from 'mobx-react-lite';
import {
  Undo,
  Undo2,
  Redo2,
  History as HistoryIcon,
  RotateCcw,
  Play,
  ChevronLeft,
  MoreHorizontal,
  Vibrate,
  Sparkles,
  Wand,
  Globe,
  Settings,
  Inbox,
  Moon,
  Palette,
} from 'lucide-react';
import Link from 'next/link';
import { useStore } from '@/hooks/useStore';
import { getHistoryStore } from '@/stores/RootStore';
import PublishButton from '@/components/PublishButton';
import DomainsButton from '@/components/domains/DomainsButton';
import SiteSettingsButton from '@/components/site/SiteSettingsDialog';
import ThemeButton from '@/components/site/ThemePanel';
import FormSubmissionsButton from '@/components/forms/FormSubmissionsButton';
import PublishedVersionsButton from '@/components/PublishedVersionsButton';
import SaveStatus from '@/components/SaveStatus';
import AgentEditingNote from '@/components/live/AgentEditingNote';
import AgentAnnouncer from '@/components/live/AgentAnnouncer';
import AgentDeletedPageWatcher from '@/components/live/AgentDeletedPageWatcher';
import GeneratePageButton from '@/components/ai/GeneratePageDialog';
import { PolishPageButton } from '@/components/ai/VisualReview';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import EditableProjectTitle from './EditableProjectTitle';
import { useSiteBranch } from '@/contexts/SiteBranchContext';
import BranchSwitcher from './branches/BranchSwitcher';
import { BranchBadge, MainChangedNote, ReviewAndMergeButton, SharePreviewButton, UpdateUndoneNote, BranchClosedElsewhere } from './branches/BranchBar';
import ColorModeSwitch, { useHasColorModeSwitch } from './ColorModeSwitch';

function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// --- HistoryList -----------------------------------------------------------
// Recent entries newest-first, each clickable to jumpTo(), plus "Initial
// state". Shared by the wide bar's dropdown and the compact bar's dialog.
const HistoryList = observer(() => {
  const history = getHistoryStore();
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!history) return null;

  const entries = history.history.slice().reverse();
  const originalLen = history.history.length;

  return (
    <div className="p-1">
      {entries.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          No actions yet.
        </div>
      ) : (
        entries.map((entry, displayIdx) => {
          const originalIdx = originalLen - 1 - displayIdx;
          const isApplied = history.undoIdx > originalIdx;
          const isCurrent = history.undoIdx === originalIdx + 1;
          return (
            <button
              key={entry.id}
              aria-current={isCurrent ? 'true' : undefined}
              onClick={() => history.jumpTo(originalIdx + 1)}
              className={`w-full flex items-start gap-2 text-left px-2 py-1.5 rounded text-xs transition-colors ${
                isCurrent
                  ? 'bg-brand/10 forced-colors:outline forced-colors:outline-2 forced-colors:-outline-offset-2'
                  : isApplied
                    ? 'text-foreground hover:bg-accent'
                    : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              <RotateCcw size={12} className="mt-0.5 shrink-0 opacity-60" />
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">{history.labelFor(entry)}</div>
                <div className="text-[10px] text-muted-foreground">
                  {relativeTime(entry.timestamp, now)}
                  {entry.patches.length > 1 && ` · ${entry.patches.length} patches`}
                </div>
              </div>
            </button>
          );
        })
      )}
      <button
        onClick={() => history.jumpTo(0)}
        aria-current={history.undoIdx === 0 ? 'true' : undefined}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs italic ${
          history.undoIdx === 0
            ? 'bg-brand/10 text-foreground forced-colors:outline forced-colors:outline-2 forced-colors:-outline-offset-2'
            : 'text-muted-foreground hover:bg-accent'
        }`}
      >
        <RotateCcw size={12} className="opacity-60" />
        Initial state
      </button>
    </div>
  );
});
HistoryList.displayName = 'HistoryList';

// --- HistoryMenu -----------------------------------------------------------
// Chevron dropdown beside Undo/Redo on the wide bar. Closes on outside click /
// Escape. Kept local so we don't pull in a popover library for one use-site.
// `folded`: the bar moved History into its More menu; an open dropdown closes with it.
const HistoryMenu = observer(({ folded = false }: { folded?: boolean }) => {
  const history = getHistoryStore();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (folded) setOpen(false);
  }, [folded]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!history) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title="History"
        // The visible count is part of the name (a speech user says what they see).
        aria-label={`History ${history.undoIdx}/${history.history.length}`}
        aria-expanded={open}
        className={`flex items-center gap-1.5 px-2 h-8 rounded text-sm text-foreground hover:bg-accent ${open ? 'bg-muted' : ''}`}
      >
        <HistoryIcon size={16} />
        {/* Fixed-width digits: the count growing on an edit moves the bar by one digit at most, within the fold's slack. */}
        <span className="text-xs text-muted-foreground tabular-nums">
          {history.undoIdx}/{history.history.length}
        </span>
      </button>
      {open && (
        <div
          data-editor-ui="true"
          className="absolute right-0 top-full mt-1 w-72 bg-background border border-border rounded-md shadow-lg overflow-hidden z-[100]"
        >
          <div className="max-h-80 overflow-y-auto">
            <HistoryList />
          </div>
        </div>
      )}
    </div>
  );
});
HistoryMenu.displayName = 'HistoryMenu';

/** Which top-bar dialog is open (one at a time). */
export type TopBarDialog = 'generate' | 'polish' | 'versions' | 'domains' | 'siteSettings' | 'theme' | 'forms' | 'history' | null;

// --- Haptics preference ----------------------------------------------------
// The phone editor's haptic ticks (src/lib/haptics.ts) can be turned off here;
// a local preference on this device. Offered only where some haptic mechanism
// may work (the Vibration API, or the iOS switch control).
function useHapticsPreference(): [supported: boolean, enabled: boolean] {
  const enabled = React.useSyncExternalStore(onHapticsPreferenceChange, hapticsEnabled, () => true);
  const supported = React.useSyncExternalStore(
    () => () => {},
    hapticsSupported,
    () => false,
  );
  return [supported, enabled];
}

// --- MoreMenu --------------------------------------------------------------
// The compact bar's overflow menu: every action the wide bar shows that does
// not fit. Items only set which dialog is open; the dialogs are siblings of
// the menu, so the menu closes cleanly before the dialog takes focus.
// Non-modal: a modal menu and the dialog it opens would fight over the
// pointer-events lock on <body>.
// On the wide bar it shows only at fold level 3, and holds the icons that folded
// into it (Generate and Polish stay in the bar as icons there).
const MoreMenu = observer(({ onOpen, className = '' }: { onOpen: (dialog: Exclude<TopBarDialog, null>) => void; className?: string }) => {
  const { editorUI } = useStore();
  // The compact bar's menu holds everything, the wide bar's only what folded into it.
  const compactBar = useMediaQuery(COMPACT_TOP_BAR_QUERY);
  const hasProject = !!editorUI.currentProject;
  const hasPage = !!editorUI.currentPage;
  const history = getHistoryStore();
  const [hapticsSupportedHere, hapticsOn] = useHapticsPreference();
  // Phone layout only: desktop Chrome has a no-op navigator.vibrate and desktop
  // Safari knows the switch control, and the desktop editor has no haptics.
  const isPhone = useIsPhone();
  const hapticsAvailable = isPhone && hapticsSupportedHere;
  // A `system` site's Light and Dark switch (ColorModeSwitch), as one checkbox here.
  const hasColorMode = useHasColorModeSwitch();
  const showsDark = editorUI.previewColorMode === 'dark';
  // A site branch has no domains, published versions or form submissions: they belong to main (site branches).
  const onBranch = useSiteBranch().state?.kind === 'branch';
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        {...{ [MORE_TRIGGER_ATTR]: '' }}
        aria-label="More actions"
        title="More actions"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand data-[state=open]:bg-muted ${className}`}
      >
        <MoreHorizontal size={18} />
      </DropdownMenuTrigger>
      <DropdownMenuContent data-editor-ui="true" className="z-[1100] min-w-[13rem]">
        {compactBar && (
          <>
            <DropdownMenuItem disabled={!hasProject} onSelect={() => onOpen('generate')}>
              <Sparkles /> Generate with AI
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!hasPage} onSelect={() => onOpen('polish')}>
              <Wand /> Polish with AI
            </DropdownMenuItem>
          </>
        )}
        {hasProject && (
          <>
            {compactBar && <DropdownMenuSeparator />}
            {!onBranch && (
              <>
                <DropdownMenuItem onSelect={() => onOpen('versions')}>
                  <Undo /> Published versions
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onOpen('domains')}>
                  <Globe /> Domains
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onSelect={() => onOpen('siteSettings')}>
              <Settings /> Site settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpen('theme')}>
              <Palette /> Theme
            </DropdownMenuItem>
            {!onBranch && (
              <DropdownMenuItem onSelect={() => onOpen('forms')}>
                <Inbox /> Form submissions
              </DropdownMenuItem>
            )}
          </>
        )}
        {hasColorMode && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              role="menuitemcheckbox"
              aria-checked={showsDark}
              // Keep the menu open: the frames change behind it, the state is shown in place.
              onSelect={(e) => {
                e.preventDefault();
                editorUI.setPreviewColorMode(showsDark ? 'light' : 'dark');
              }}
            >
              <Moon /> Show dark mode
              <span className="ml-auto text-xs text-muted-foreground">{showsDark ? 'On' : 'Off'}</span>
            </DropdownMenuItem>
          </>
        )}
        {history && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onOpen('history')}>
              <HistoryIcon /> History
              <span className="ml-auto text-xs text-muted-foreground">
                {history.undoIdx}/{history.history.length}
              </span>
            </DropdownMenuItem>
          </>
        )}
        {hapticsAvailable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              role="menuitemcheckbox"
              aria-checked={hapticsOn}
              // Keep the menu open: it is a setting, the state is shown in place.
              onSelect={(e) => {
                e.preventDefault();
                setHapticsEnabled(!hapticsOn);
              }}
            >
              <Vibrate /> Haptic feedback
              <span className="ml-auto text-xs text-muted-foreground">{hapticsOn ? 'On' : 'Off'}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
MoreMenu.displayName = 'MoreMenu';

// --- TopBar ----------------------------------------------------------------
const TopBar = observer(() => {
  const rootStore = useStore();
  const { editorUI } = rootStore;
  const project = editorUI.currentProject;
  const currentPage = editorUI.currentPage;
  const history = getHistoryStore();
  const [dialog, setDialog] = React.useState<TopBarDialog>(null);
  // Main or a site branch, when branches are on for the company (null otherwise: nothing of branches shows).
  const onBranch = useSiteBranch().state?.kind === 'branch';
  // Open state for one dialog, in the shape the buttons take.
  const control = (which: Exclude<TopBarDialog, null>) => ({
    open: dialog === which,
    onOpenChange: (open: boolean) => setDialog((cur) => (open ? which : cur === which ? null : cur)),
  });

  // How far the wide bar has folded to fit what it holds (src/components/topbar/fold.ts).
  const barRef = React.useRef<HTMLElement>(null);
  const fold: FoldLevel = useTopBarFold(barRef);
  const iconOnly = fold >= 1;
  const narrowPage = fold >= 2;
  const inMore = fold >= 3;

  // Hidden in the compact bar (reached through the More menu instead). Never squeezed on the wide bar: every
  // control keeps its own width, so the fold measures what the bar needs and folds instead of squeezing.
  const wideOnly = 'max-lg:hidden shrink-0';
  // Hidden in the compact bar, and on the wide bar once it folded them into More.
  const secondary = inMore ? 'hidden' : wideOnly;

  return (
    // One provider for the bar's tooltips: moving from one to the next shows it without the delay again.
    <TooltipProvider>
    <header
      ref={barRef}
      data-editor-ui="true"
      data-editor-topbar="true"
      data-fold={fold}
      className="fixed top-0 left-0 right-0 h-16 phone:h-12 bg-background border-b border-border flex items-center z-90"
    >
      {/* Left: back-to-projects + project title + current page (Framer-style
          breadcrumb, since the page tabs moved to the sidebar). In the
          compact bar this side takes the free space and the title truncates. */}
      {/* A floor in the compact bar: the back link and the branch switcher stay pressable when the right side
          is full (on a branch it holds Update, Share preview and Review and merge), and the save status, which
          can shrink, gives way instead. Seen in real browsers: test/behaviour/branches.spec.ts. */}
      {/* On the wide bar this side keeps its own width until the last fold, so the fold can measure what the
          bar needs; at the last fold the site and branch names truncate. */}
      <div
        className={`flex min-w-[7.5rem] flex-1 items-center gap-1 px-2 sm:gap-2 lg:min-w-[200px] lg:flex-none lg:px-6 ${
          inMore ? 'lg:shrink' : 'lg:shrink-0'
        }`}
      >
        <Link
          href="/projects"
          title="Back to projects"
          aria-label="Back to projects"
          className="flex items-center justify-center w-8 h-8 lg:-ml-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground shrink-0"
        >
          <ChevronLeft size={18} />
        </Link>
        <EditableProjectTitle project={project} />
        <BranchSwitcher />
        {/* The badge gives way at the page name's fold: the switcher beside it already names the branch, and its
            menu says what a branch is. */}
        <BranchBadge className={narrowPage ? 'hidden' : 'max-lg:hidden'} />
        {currentPage && (
          <>
            {/* The compact bar has no room for it on a branch (the switcher and the branch controls take it). */}
            <span aria-hidden="true" className={`text-muted-foreground ${onBranch ? 'max-lg:hidden' : 'max-md:hidden'}`}>/</span>
            <div
              data-testid="topbar-page-name"
              // Narrows at the second fold; the full name shows on hover, and in the Pages panel.
              className={`truncate text-sm text-muted-foreground lg:shrink-0 ${onBranch ? 'max-lg:hidden' : 'max-md:hidden'} ${narrowPage ? 'max-w-[6rem]' : 'max-w-[10rem]'}`}
              title={currentPage.metadata.title}
            >
              {currentPage.metadata.title}
            </div>
          </>
        )}
      </div>

      {/* Middle: the free room. Reserved for tool-category tabs (Insert / Layout / Text / Vector / CMS) in a
          future iteration; the fold reads its width as room to spare. */}
      <div data-fold-gap="" className="min-w-0 flex-1 max-lg:hidden" />

      {/* Light and Dark for a site that follows each visitor's system: which one the
          canvas and the preview show. Nothing is saved. The compact bar has it in More, and so has the wide bar
          once it folded. */}
      <ColorModeSwitch className={`mr-2 ${secondary}`} />

      {/* Generate: AI page / section generation (plan ai-driven-page-generation).
          Applies as one undoable action, saved at once like any other edit. */}
      <GeneratePageButton {...control('generate')} triggerClassName={wideOnly} iconOnly={iconOnly} />

      {/* Polish with AI: measure the open page's layout and let a vision model
          fix clipped text, overflow and contrast, as one undo step (plan
          2026-10-23-ai-design-quality-round-2, decision 4). */}
      <PolishPageButton {...control('polish')} triggerClassName={wideOnly} iconOnly={iconOnly} />

      {/* The status slot: the save status and, beside it in a slot of its own, the agent chip. Neither folds and
          neither is ever drawn over the other. */}
      <div data-testid="topbar-status-slot" className="flex min-w-0 items-center lg:shrink-0">
        {/* The save status: the editor saves by itself and has no Save button
            (owner, 2026-11-04); this says Saved, Unsaved changes, Saving…, or
            why not, with Retry. Cmd/Ctrl+S saves at once. Saving never publishes. */}
        <SaveStatus />

        {/* While an agent works on the site (live agent canvas): a chip, "Agent editing", whose tooltip says who
            does what, so a person who starts editing knows a conflict may follow. */}
        <AgentEditingNote className={`mr-2 ${wideOnly}`} />
        <AgentEditingNote compact className="mr-1 lg:hidden" />
      </div>
      {/* What a screen reader hears of the agents: the note when they become active, refusals, approvals needed and failures. */}
      <AgentAnnouncer />
      {/* An agent deleted the open page: a notice above the canvas, with Undo. */}
      <AgentDeletedPageWatcher />

      {/* Publish: the primary rightward action. Serializes the live project
          and pushes it live via the admin-guarded publish endpoint. */}
      {/* On a site branch: "Main has changed" with Update, and "Review and merge" in place of Publish (a
          branch is never published; publishing happens from main). Review and merge stays the filled button
          at every fold. */}
      {onBranch ? (
        <>
          <BranchClosedElsewhere />
          <UpdateUndoneNote className="mr-2" />
          <MainChangedNote className="mr-2" iconOnly={iconOnly} />
          <SharePreviewButton className="mr-2" iconOnly={iconOnly} />
          <ReviewAndMergeButton iconOnly={iconOnly} />
        </>
      ) : (
        <PublishButton />
      )}

      {!onBranch && (
        <>
          {/* Published versions: what visitors have been served, and going back to one. */}
          <PublishedVersionsButton {...control('versions')} triggerClassName={secondary} />

          {/* Domains: connect a custom domain to this project (its own dialog). */}
          <DomainsButton {...control('domains')} triggerClassName={secondary} />
        </>
      )}

      {/* Site settings: name, language, favicon, sharing image, business data. */}
      <SiteSettingsButton {...control('siteSettings')} triggerClassName={secondary} />
      {/* Theme: the site's shared colours and fonts, colour mode and page defaults. */}
      <ThemeButton {...control('theme')} triggerClassName={secondary} />
      {/* Form submissions: what visitors sent through this site's forms. */}
      {!onBranch && <FormSubmissionsButton {...control('forms')} triggerClassName={secondary} />}

      {/* Preview entry: sits just before the undo/redo cluster so it's
          visually grouped with the other rightward actions. Never folds. */}
      <BarTooltip text="Preview the page as visitors see it">
        <button
          type="button"
          onClick={() => editorUI.setPreviewOpen(true)}
          aria-label="Preview"
          className="flex items-center justify-center w-8 h-8 shrink-0 rounded text-foreground hover:bg-accent mr-1 lg:mr-2"
        >
          <Play size={16} aria-hidden />
        </button>
      </BarTooltip>

      {/* The compact bar's More menu holds everything that did not fit; the wide bar's, once folded, the
          secondary icons. */}
      <MoreMenu onOpen={setDialog} className={`mr-2 ${inMore ? '' : 'lg:hidden'}`} />

      {/* Right: undo / redo / history (wide bar; the bottom bar has undo and redo on every size). Undo and
          redo never fold; history moves into More at the last fold. */}
      <div className="hidden lg:flex items-center gap-1 px-3 border-l border-border shrink-0 h-full">
        <button
          type="button"
          onClick={() => history?.undo()}
          disabled={!history?.canUndo}
          title="Undo (Cmd+Z)"
          aria-label="Undo"
          className="flex items-center justify-center w-8 h-8 rounded text-foreground hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Undo2 size={16} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => history?.redo()}
          disabled={!history?.canRedo}
          title="Redo (Cmd+Shift+Z)"
          aria-label="Redo"
          className="flex items-center justify-center w-8 h-8 rounded text-foreground hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Redo2 size={16} aria-hidden />
        </button>
        <div className={inMore ? 'hidden' : undefined}>
          <HistoryMenu folded={inMore} />
        </div>
      </div>

      {/* History as a dialog, opened from the More menu. */}
      {history && (
        <Dialog {...control('history')}>
          <DialogContent data-editor-ui="true" data-testid="history-dialog" className="max-w-[400px]">
            <DialogHeader>
              <DialogTitle>History</DialogTitle>
              <DialogDescription>Jump back or forward to any step. Undo and redo are in the bottom bar, and beside History on a wide top bar.</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <HistoryList />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </header>
    </TooltipProvider>
  );
});

TopBar.displayName = 'TopBar';
export default TopBar;
