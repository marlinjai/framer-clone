// src/components/preview/leavePreview.ts
//
// Leaves the project's standalone preview (/projects/<id>/preview) with a full
// document load, never a client-side navigation. That route is served with an
// enforced `frame-src` (src/middleware.ts, decision D6 of
// docs/plans/2026-11-02-sandboxed-custom-code.md), and a policy belongs to the
// document: a client-side step into the editor would keep it there and refuse
// the editor's own frames (the Books PDF preview, for one). The demo preview
// (/preview) is reached and left client-side, because its project lives only in
// this tab's memory; it never carries the policy.
export function leavePreview(href: string): void {
  window.location.assign(href);
}
