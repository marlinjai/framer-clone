'use client';

// src/components/site/HeadItemsDialog.tsx
//
// The Head section of Site settings and of Page settings (docs/plans/2026-11-02-theme-and-head.md,
// slice H3): a summary line and a button that opens the editor for the tags a page or the whole
// site adds to the <head> beyond its search metadata.
//
// The editor writes at once, one undo step per change, and is not part of the settings dialog's
// Save: a settings dialog edits a draft of its own fields, and the head list is replaced as a whole
// by its own action (ProjectModel.updateSiteHead, the page's updateMetadata), so a dialog opened
// before an edit and saved after it cannot put the old list back. The dialog says so.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { PageModelType } from '@/models/PageModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import { HEAD_LIMITS, OG_TYPES, parseOgType, resolveHead, type OgType, type StoredHeadItem } from '@/lib/site/headItems';
import { HeadItemsEditor } from './HeadItemsEditor';

const fieldLabel = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const hint = 'text-[11px] text-muted-foreground';

const OG_LABEL: Record<OgType, string> = { website: 'Website (the default)', article: 'Article', book: 'Book', profile: 'Profile (a person)' };

export type HeadScope = { kind: 'site'; project: ProjectModelType } | { kind: 'page'; project: ProjectModelType; page: PageModelType };

/** The editor for one home, wired to its model action. */
export const HeadItemsPanel = observer(({ scope }: { scope: HeadScope }) => {
  const items = (scope.kind === 'site' ? scope.project.site.head : scope.page.metadata.head) as readonly StoredHeadItem[];
  const write = (next: StoredHeadItem[]) => {
    if (scope.kind === 'site') return scope.project.updateSiteHead(next);
    const { headDropped } = scope.page.updateMetadata({ head: next });
    return { ok: true as const, dropped: headDropped };
  };
  return (
    <div className="flex flex-col gap-4">
      {scope.kind === 'page' && (
        <div className="flex flex-col gap-1">
          <label htmlFor="head-og-type" className={fieldLabel}>Content type</label>
          <select
            id="head-og-type"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={parseOgType(scope.page.metadata.ogType)}
            onChange={(e) => scope.page.updateMetadata({ ogType: e.target.value })}
          >
            {OG_TYPES.map((t) => (
              <option key={t} value={t}>{OG_LABEL[t]}</option>
            ))}
          </select>
          <p className={hint}>What sharing services read as the kind of page. Article tags below mean most with Article.</p>
        </div>
      )}
      <HeadItemsEditor
        items={items}
        cap={scope.kind === 'site' ? HEAD_LIMITS.siteItems : HEAD_LIMITS.pageItems}
        write={write}
        home={scope.kind}
      />
    </div>
  );
});

export function HeadItemsDialog({ scope, open, onClose }: { scope: HeadScope; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent
          data-testid="head-dialog"
          data-editor-ui="true"
          className="max-w-[640px]"
          // Keep editor shortcuts from firing while typing; Escape still closes.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation();
          }}
        >
          <DialogHeader>
            <DialogTitle>{scope.kind === 'site' ? 'Head items for every page' : 'Head items for this page'}</DialogTitle>
            <DialogDescription>
              Tags in the page&apos;s head that search engines and sharing services read: site verification codes, language
              alternates, profile links and structured data. Changes apply at once and are one undo step each; they do not wait for Save.
              {scope.kind === 'page' ? ' An item here replaces a site item with the same name.' : ' A page can replace an item with the same name.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <HeadItemsPanel scope={scope} />
          </DialogBody>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** What the section says about the list: how many items, and how many this build refuses. */
function summaryOf(scope: HeadScope): { count: number; problems: number } {
  const items = scope.kind === 'site' ? scope.project.site.head : scope.page.metadata.head;
  const siteItems = scope.project.site.head;
  const resolution = scope.kind === 'site' ? resolveHead(siteItems, []) : resolveHead([], items);
  return { count: items.length, problems: resolution.problems.length };
}

/** The Head section a settings dialog shows: a line of status and the button that opens the editor. */
export const HeadItemsSection = observer(({ scope }: { scope: HeadScope }) => {
  const [open, setOpen] = React.useState(false);
  const { count, problems } = summaryOf(scope);
  const id = scope.kind === 'site' ? 'site-head-section' : 'page-head-section';
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2" data-testid={id}>
      <h3 id={`${id}-title`} className="text-[13px] font-semibold text-foreground">Head</h3>
      <p className={hint}>
        Extra tags in the head of {scope.kind === 'site' ? 'every page' : 'this page'}: verification codes, language alternates, profile links and
        structured data.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} data-testid={`${id}-open`}>
          Edit head items
        </Button>
        <span className={problems > 0 ? 'text-[11px] text-destructive' : hint} data-testid={`${id}-summary`}>
          {count === 0 ? 'None yet' : `${count} ${count === 1 ? 'item' : 'items'}`}
          {problems > 0 ? `, ${problems} not published` : ''}
        </span>
      </div>
      <HeadItemsDialog scope={scope} open={open} onClose={() => setOpen(false)} />
    </section>
  );
});
