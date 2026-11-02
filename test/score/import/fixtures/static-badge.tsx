// Hand-written for the import score: static markup, real Tailwind classes, an icon child
// and no props, which is what the importer can carry end to end before props are read.
// The icon is what `[&>svg]` reads, so the rule runs on something.

export default function Badge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground shadow-xs [&>svg]:size-3 [&>svg]:shrink-0">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      New
    </span>
  );
}
