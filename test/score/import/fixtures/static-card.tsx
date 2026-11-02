// Hand-written for the import score: a card of static markup with what layer 2 rewrites,
// a breakpoint map, `space-y`, a named state on a link, a group marker and text beside an
// element. No props, so nothing waits on a later layer.
/* eslint-disable @next/next/no-html-link-for-pages -- written as a component from elsewhere, not a page of this app */

export default function Card() {
  return (
    <section className="flex max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 text-card-foreground shadow-sm md:p-8">
      <header className="space-y-1.5">
        <h3 className="text-lg leading-none font-semibold tracking-tight">Create project</h3>
        <p className="text-sm text-muted-foreground">Deploy your new project in one click.</p>
      </header>
      <a
        href="/create"
        className="group inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        Continue
        <span className="transition-transform group-hover:translate-x-0.5">→</span>
      </a>
    </section>
  );
}
