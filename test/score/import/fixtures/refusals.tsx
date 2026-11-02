// Hand-written for the import score: the refusal paths. A class only known when the
// component runs, a class Tailwind does not know, a handler, a component from a package
// the importer does not read, beside a `tailwind.config.js` it never runs. Each must be a
// line, and the verdict must say "not imported".

import { Check } from 'lucide-react';

export default function Refusals({ tone }: { tone: string }) {
  return (
    <div className={`rounded-md p-4 bg-${tone}`} onClick={() => undefined}>
      <p className="not-a-tailwind-class text-sm">Saved</p>
      <Check className="size-4" />
    </div>
  );
}
