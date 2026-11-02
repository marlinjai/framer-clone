// src/components/ErasePersonalDataPanel.tsx
//
// "Erase personal data", inside the Published versions dialog: find one value
// (a name, an address, a phone number) in every kept version of the site and in
// the editor's working copy, look at every match, leave some out, and erase the
// rest (plan docs/plans/2026-11-01-immutable-published-copy.md, "Erasing
// personal data from the history"). The company's owner only; the server says
// so to anyone else, and the panel shows that answer.
//
// Nothing changes before the second click: Search shows every match, Erase asks
// once more with the counts, and the answer shows what a fresh search finds
// afterwards (the proof). Every failure is shown. A preview that went stale (a
// publish in between) asks for a new search.
//
// After an erase this tab's copy of the project is older than the server's, and
// its Save would be refused, so the result offers a reload, and says that other
// open tabs of this project need one too.
'use client';

import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Location = { kind: 'revision'; number: number } | { kind: 'working' };

interface Match {
  id: string;
  location: Location;
  area: string;
  pageId: string | null;
  pageSlug: string | null;
  path: string;
  excerpt: string;
  blocked: string | null;
}

interface LocationSummary {
  location: Location;
  createdAt: string | null;
  kind: 'publish' | 'baseline' | null;
  live: boolean;
  matches: number;
  erasable: number;
}

interface SearchResult {
  token: string;
  total: number;
  erasable: number;
  blocked: number;
  matches: Match[];
  truncated: boolean;
  locations: LocationSummary[];
}

interface EraseResult {
  erased: number;
  remaining: number | null;
  erasableRemaining: number | null;
}

type State =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'found'; query: Query; result: SearchResult }
  | { kind: 'erasing'; query: Query; result: SearchResult }
  | { kind: 'done'; result: EraseResult };

interface Query {
  value: string;
  caseSensitive: boolean;
}

const AREA_LABELS: Record<string, string> = {
  name: 'project name',
  description: 'project description',
  text: 'text',
  attribute: 'attribute',
  binding: 'bound value',
  'page-metadata': 'page title or description',
  component: 'reusable component',
  settings: 'site settings',
  theme: 'theme',
  head: 'head item',
  address: 'page address',
  other: 'other',
};

const BLOCKED_LABELS: Record<string, string> = {
  key: 'a name in the structure, not a value',
  structural: 'an id, class, selector or form key: changing it would change more than this value',
  address: 'a page address: changing it would change where visitors land',
  'binding-reference': 'inside a data binding: changing it would break the binding',
};

function locationLabel(location: Location): string {
  return location.kind === 'working' ? 'Editor (working copy)' : `Version ${location.number}`;
}

async function readError(res: Response, fallback: string): Promise<{ code: string | null; message: string }> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) return { code: body.error.code ?? null, message: body.error.message };
  } catch {
    // not JSON
  }
  return { code: null, message: `${fallback} (HTTP ${res.status})` };
}

export function ErasePersonalDataPanel({ projectId }: { projectId: string }) {
  const [value, setValue] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [leaveOut, setLeaveOut] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [failure, setFailure] = useState<{ code: string | null; message: string } | null>(null);
  const base = `/api/projects/${encodeURIComponent(projectId)}/erasures`;

  const search = async (query: Query) => {
    setFailure(null);
    setConfirming(false);
    setLeaveOut(new Set());
    setState({ kind: 'searching' });
    try {
      const res = await fetch(`${base}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(query),
      });
      if (!res.ok) {
        setFailure(await readError(res, 'The search failed'));
        setState({ kind: 'idle' });
        return;
      }
      setState({ kind: 'found', query, result: (await res.json()) as SearchResult });
    } catch {
      setFailure({ code: null, message: 'The search failed: network error.' });
      setState({ kind: 'idle' });
    }
  };

  const erase = async (query: Query, result: SearchResult) => {
    setFailure(null);
    setConfirming(false);
    setState({ kind: 'erasing', query, result });
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...query, replacement, token: result.token, leaveOut: [...leaveOut] }),
      });
      if (!res.ok) {
        setFailure(await readError(res, 'The erase failed'));
        setState({ kind: 'found', query, result });
        return;
      }
      setState({ kind: 'done', result: (await res.json()) as EraseResult });
    } catch {
      setFailure({ code: null, message: 'The erase failed: network error. Search again to see whether it went through.' });
      setState({ kind: 'found', query, result });
    }
  };

  const toggle = (id: string) =>
    setLeaveOut((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (state.kind === 'done') {
    const { erased, remaining, erasableRemaining } = state.result;
    return (
      <div className="space-y-3" role="status">
        <p className="text-sm font-medium">
          Erased {erased} {erased === 1 ? 'match' : 'matches'}.
        </p>
        <p className="text-sm">
          {remaining === null
            ? 'The check afterwards could not run. Search again to confirm the value is gone.'
            : remaining === 0
              ? 'A new search finds nothing: the value is gone from every kept version and from the editor.'
              : `A new search still finds ${remaining} ${remaining === 1 ? 'match' : 'matches'}` +
                (erasableRemaining ? `, ${erasableRemaining} of them erasable (left out, or added since).` : ', none of them erasable here.')}
        </p>
        <p className="text-sm text-muted-foreground">
          This editor still holds the old copy. Reload it before you go on; every other open tab of this project needs a reload too, and cannot save until then.
        </p>
        <Button type="button" size="sm" onClick={() => window.location.reload()}>
          Reload the editor
        </Button>
      </div>
    );
  }

  const busy = state.kind === 'searching' || state.kind === 'erasing';
  const found = state.kind === 'found' || state.kind === 'erasing' ? state : null;
  const chosen = found ? found.result.erasable - found.result.matches.filter((m) => m.blocked === null && leaveOut.has(m.id)).length : 0;
  const versions = found ? found.result.locations.filter((l) => l.location.kind === 'revision' && l.erasable > 0).length : 0;

  return (
    <div className="space-y-3">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search({ value, caseSensitive });
        }}
      >
        <label className="block text-sm font-medium" htmlFor="erase-value">
          Value to find
        </label>
        <div className="flex gap-2">
          <input
            id="erase-value"
            className="h-8 min-w-0 flex-1 rounded border border-border bg-background px-2 text-sm"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="A name, an email address, a phone number"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || value.trim().length === 0}>
            <Search size={14} /> {state.kind === 'searching' ? 'Searching...' : 'Search'}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
          Match upper and lower case exactly
        </label>
      </form>

      {failure && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{failure.message}</p>
          {failure.code === 'erase_preview_stale' && found && (
            <Button type="button" size="sm" variant="outline" onClick={() => void search(found.query)}>
              Search again
            </Button>
          )}
        </div>
      )}

      {found && (
        <div className="space-y-3">
          <p className="text-sm">
            {found.result.total === 0
              ? 'Nothing found in any kept version or in the editor.'
              : `${found.result.total} ${found.result.total === 1 ? 'match' : 'matches'}: ${found.result.erasable} can be erased` +
                (found.result.blocked > 0 ? `, ${found.result.blocked} cannot be erased here.` : '.')}
          </p>
          {found.result.total > 0 && (
            <ul className="text-xs text-muted-foreground">
              {found.result.locations
                .filter((l) => l.matches > 0)
                .map((l) => (
                  <li key={locationLabel(l.location)}>
                    {locationLabel(l.location)}
                    {l.live && ' (live)'}: {l.matches}
                  </li>
                ))}
            </ul>
          )}
          {found.result.matches.length > 0 && (
            <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded border border-border" aria-label="Matches">
              {found.result.matches.map((match) => (
                <li key={match.id} className="flex gap-2 p-2 text-sm">
                  {match.blocked === null ? (
                    <input
                      type="checkbox"
                      className="mt-1"
                      aria-label={`Erase this match in ${locationLabel(match.location)}`}
                      checked={!leaveOut.has(match.id)}
                      onChange={() => toggle(match.id)}
                      disabled={busy}
                    />
                  ) : (
                    <span className="mt-1 w-[13px]" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">
                      {locationLabel(match.location)} · {AREA_LABELS[match.area] ?? match.area}
                      {match.pageSlug !== null && ` · page /${match.pageSlug}`}
                    </div>
                    <div className="break-words">{match.excerpt}</div>
                    {match.blocked !== null && (
                      <div className="text-xs text-muted-foreground">
                        Cannot be erased here: {BLOCKED_LABELS[match.blocked] ?? match.blocked}.
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {found.result.truncated && (
            <p className="text-xs text-muted-foreground">
              Showing the first {found.result.matches.length}. Erase covers every erasable match, also the ones not shown.
            </p>
          )}
          {found.result.erasable > 0 && (
            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="erase-replacement">
                Replace with (optional)
              </label>
              <input
                id="erase-replacement"
                className="h-8 w-full rounded border border-border bg-background px-2 text-sm"
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder="Leave empty to remove, or for example [entfernt]"
                autoComplete="off"
                disabled={busy}
              />
              {confirming ? (
                <div role="group" aria-label="Confirm the erase" className="space-y-2 rounded border border-border p-3">
                  <p className="text-sm font-medium">
                    Erase {chosen} {chosen === 1 ? 'match' : 'matches'}
                    {versions > 0 ? ` from ${versions} published ${versions === 1 ? 'version' : 'versions'}` : ''} and the editor? This
                    cannot be undone, and the live site changes at once.
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="destructive" onClick={() => void erase(found.query, found.result)}>
                      Erase
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy || chosen === 0}
                  onClick={() => setConfirming(true)}
                >
                  {state.kind === 'erasing' ? 'Erasing...' : `Erase ${chosen} ${chosen === 1 ? 'match' : 'matches'}...`}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
