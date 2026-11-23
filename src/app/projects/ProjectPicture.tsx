// src/app/projects/ProjectPicture.tsx: the picture at the top of a project card, a
// small abstract page in the site's own colours (src/lib/site/cardColors.ts):
// a heading bar, a line of text and a button. Without colours, a neutral page
// with the project's initial. Decorative: the card's name says what it is.
import React from 'react';
import type { SiteCardColors } from '@/lib/site/cardColors';

export default function ProjectPicture({ colors, name }: { colors: SiteCardColors | null; name: string }) {
  const box = 'relative h-[76px] shrink-0 overflow-hidden border-b border-border sm:h-[120px]';
  if (!colors) {
    return (
      <div aria-hidden="true" className={`${box} grid place-items-center bg-[var(--canvas-ground)]`}>
        <span className="text-3xl font-semibold text-muted-foreground">{(name.trim()[0] ?? '?').toUpperCase()}</span>
      </div>
    );
  }
  return (
    <div aria-hidden="true" className={box} style={{ background: colors.background }}>
      <div className="absolute left-3.5 right-3.5 top-[18px] h-2.5 w-[46%] rounded opacity-90" style={{ background: colors.accent ?? colors.text }} />
      <div className="absolute left-3.5 top-[38px] h-1.5 w-[55%] rounded-sm opacity-50" style={{ background: colors.text }} />
      <div
        className="absolute bottom-4 left-3.5 h-[18px] w-16 rounded-md max-sm:bottom-2.5"
        style={{ background: colors.accent ?? colors.text, opacity: colors.accent ? 1 : 0.8 }}
      />
    </div>
  );
}
