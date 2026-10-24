// src/components/TopBar.tsx
// Editor top bar: project title (left), reserved space (middle, intended for
// future tool-category tabs like Insert / Layout / Text), the site actions,
// and undo / redo + history dropdown (right). Page navigation lives in the
// left sidebar's Pages pane, not here — see LeftSidebar.tsx.
//
// Under 1024px wide the bar is compact (plan
// docs/plans/2026-10-24-editor-on-phones.md): back link, the project name
// (truncating; the page name is hidden), Save, Preview, Publish and a More
// menu that holds Generate, Polish, Domains, Site settings, Form submissions
// and History. Undo and redo stay reachable in the bottom bar on every size.
// The switch is CSS only (`lg:`), so the bar is right from the first paint.
// Each dialog exists once: this bar owns its open state, the wide bar's
// buttons and the More menu's items open the same instance. On a phone the bar
// is 48px high instead of 64px.
//
// Marked data-editor-ui so the drag resolver treats hits here as chrome
// (cancels drops silently).
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import {
  Undo2,
  Redo2,
  History as HistoryIcon,
  RotateCcw,
  Play,
  ChevronLeft,
  MoreHorizontal,
  Sparkles,
  Wand,
  Globe,
  Settings,
  Inbox,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useStore } from '@/hooks/useStore';
import { getHistoryStore } from '@/stores/RootStore';
import PublishButton from '@/components/PublishButton';
import DomainsButton from '@/components/domains/DomainsButton';
import SiteSettingsButton from '@/components/site/SiteSettingsDialog';
import FormSubmissionsButton from '@/components/forms/FormSubmissionsButton';
import SaveButton from '@/components/SaveButton';
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
              onClick={() => history.jumpTo(originalIdx + 1)}
              className={`w-full flex items-start gap-2 text-left px-2 py-1.5 rounded text-xs transition-colors ${
                isCurrent
                  ? 'bg-brand/10 border-l-2 border-brand'
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
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs italic ${
          history.undoIdx === 0
            ? 'bg-brand/10 border-l-2 border-brand text-foreground'
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
const HistoryMenu = observer(() => {
  const history = getHistoryStore();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

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
        className={`flex items-center gap-1.5 px-2 h-8 rounded text-sm text-foreground hover:bg-accent ${open ? 'bg-muted' : ''}`}
      >
        <HistoryIcon size={16} />
        <span className="text-xs text-muted-foreground">
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
export type TopBarDialog = 'generate' | 'polish' | 'domains' | 'siteSettings' | 'forms' | 'history' | null;

// --- MoreMenu --------------------------------------------------------------
// The compact bar's overflow menu: every action the wide bar shows that does
// not fit. Items only set which dialog is open; the dialogs are siblings of
// the menu, so the menu closes cleanly before the dialog takes focus.
// Non-modal: a modal menu and the dialog it opens would fight over the
// pointer-events lock on <body>.
const MoreMenu = observer(({ onOpen, className = '' }: { onOpen: (dialog: Exclude<TopBarDialog, null>) => void; className?: string }) => {
  const { editorUI } = useStore();
  const hasProject = !!editorUI.currentProject;
  const hasPage = !!editorUI.currentPage;
  const history = getHistoryStore();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="More actions"
        title="More actions"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand data-[state=open]:bg-muted ${className}`}
      >
        <MoreHorizontal size={18} />
      </DropdownMenuTrigger>
      <DropdownMenuContent data-editor-ui="true" className="z-[1100] min-w-[13rem]">
        <DropdownMenuItem disabled={!hasProject} onSelect={() => onOpen('generate')}>
          <Sparkles /> Generate with AI
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hasPage} onSelect={() => onOpen('polish')}>
          <Wand /> Polish with AI
        </DropdownMenuItem>
        {hasProject && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onOpen('domains')}>
              <Globe /> Domains
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpen('siteSettings')}>
              <Settings /> Site settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpen('forms')}>
              <Inbox /> Form submissions
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
  const router = useRouter();
  const [dialog, setDialog] = React.useState<TopBarDialog>(null);
  // Open state for one dialog, in the shape the buttons take.
  const control = (which: Exclude<TopBarDialog, null>) => ({
    open: dialog === which,
    onOpenChange: (open: boolean) => setDialog((cur) => (open ? which : cur === which ? null : cur)),
  });

  // Preview the page being edited (`?page=`). A dashboard project previews
  // at its own route; the browser-only demo project (`/`) has no server copy,
  // so it previews at /preview, from this tab's store.
  const pageQuery = currentPage ? `?page=${encodeURIComponent(currentPage.id)}` : '';
  const previewHref = project && !editorUI.isUnsavedDemo
    ? `/projects/${project.id}/preview${pageQuery}`
    : `/preview${pageQuery}`;

  // Hidden in the compact bar (reached through the More menu instead).
  const wideOnly = 'max-lg:hidden';

  return (
    <header
      data-editor-ui="true"
      data-editor-topbar="true"
      className="fixed top-0 left-0 right-0 h-16 phone:h-12 bg-background border-b border-border flex items-center z-90"
    >
      {/* Left: back-to-projects + project title + current page (Framer-style
          breadcrumb, since the page tabs moved to the sidebar). In the
          compact bar this side takes the free space and the title truncates. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 px-2 sm:gap-2 lg:min-w-[200px] lg:flex-none lg:shrink-0 lg:px-6">
        <Link
          href="/projects"
          title="Back to projects"
          aria-label="Back to projects"
          className="flex items-center justify-center w-8 h-8 lg:-ml-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground shrink-0"
        >
          <ChevronLeft size={18} />
        </Link>
        <EditableProjectTitle project={project} />
        {currentPage && (
          <>
            <span className="text-muted-foreground max-md:hidden">/</span>
            <div
              className="text-sm text-muted-foreground truncate max-w-[160px] max-md:hidden"
              title={currentPage.metadata.title}
            >
              {currentPage.metadata.title}
            </div>
          </>
        )}
      </div>

      {/* Middle: reserved for tool-category tabs (Insert / Layout / Text /
          Vector / CMS) in a future iteration. Left empty rather than with
          placeholder boxes so the bar reads as intentional, not unfinished. */}
      <div className="flex-1 max-lg:hidden" />

      {/* Generate: AI page / section generation (plan ai-driven-page-generation).
          Applies as one undoable action; Save persists it like any other edit. */}
      <GeneratePageButton {...control('generate')} triggerClassName={wideOnly} />

      {/* Polish with AI: measure the open page's layout and let a vision model
          fix clipped text, overflow and contrast, as one undo step (plan
          2026-10-23-ai-design-quality-round-2, decision 4). */}
      <PolishPageButton {...control('polish')} triggerClassName={wideOnly} />

      {/* Save: persist the working copy WITHOUT publishing (MT-10). Sits just
          before Publish so the non-destructive action reads first. */}
      <SaveButton />

      {/* Publish: the primary rightward action. Serializes the live project
          and pushes it live via the admin-guarded publish endpoint. */}
      <PublishButton />

      {/* Domains: connect a custom domain to this project (its own dialog). */}
      <DomainsButton {...control('domains')} triggerClassName={wideOnly} />

      {/* Site settings: name, language, favicon, sharing image, business data. */}
      <SiteSettingsButton {...control('siteSettings')} triggerClassName={wideOnly} />
      {/* Form submissions: what visitors sent through this site's forms. */}
      <FormSubmissionsButton {...control('forms')} triggerClassName={wideOnly} />

      {/* Preview entry — sits just before the undo/redo cluster so it's
          visually grouped with the other rightward actions. */}
      <button
        type="button"
        onClick={() => router.push(previewHref)}
        title="Preview"
        aria-label="Preview"
        className="flex items-center justify-center w-8 h-8 shrink-0 rounded text-foreground hover:bg-accent mr-1 lg:mr-2"
      >
        <Play size={16} />
      </button>

      {/* Compact bar only: everything that did not fit. */}
      <MoreMenu onOpen={setDialog} className="mr-2 lg:hidden" />

      {/* Right: undo / redo / history (wide bar; the bottom bar has undo and redo on every size) */}
      <div className="hidden lg:flex items-center gap-1 px-3 border-l border-border shrink-0 h-full">
        <button
          type="button"
          onClick={() => history?.undo()}
          disabled={!history?.canUndo}
          title="Undo (Cmd+Z)"
          className="flex items-center justify-center w-8 h-8 rounded text-foreground hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          onClick={() => history?.redo()}
          disabled={!history?.canRedo}
          title="Redo (Cmd+Shift+Z)"
          className="flex items-center justify-center w-8 h-8 rounded text-foreground hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Redo2 size={16} />
        </button>
        <HistoryMenu />
      </div>

      {/* History as a dialog, opened from the compact bar's More menu. */}
      {history && (
        <Dialog {...control('history')}>
          <DialogContent data-editor-ui="true" data-testid="history-dialog" className="max-w-[400px]">
            <DialogHeader>
              <DialogTitle>History</DialogTitle>
              <DialogDescription>Jump back or forward to any step. Undo and redo are in the bottom bar.</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <HistoryList />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </header>
  );
});

TopBar.displayName = 'TopBar';
export default TopBar;
