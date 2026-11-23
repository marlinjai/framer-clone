// src/components/brand/LumitraStar.tsx
//
// The Lumitra star as an inline mark, filled with currentColor so the surface
// chooses its colour (mint on dark, the dark green on light: mint is 1.3:1 on
// white). The same outline as public/platform-icon.svg, the editor's favicon.
import React from 'react';

const STAR_PATH =
  'M95.68,19.36 Q100.00,10.00 104.32,19.36 Q112.66,41.96 122.35,58.44 Q125.39,65.05 132.62,65.91 Q151.29,70.02 175.36,70.98 Q185.60,72.19 178.03,79.19 Q159.12,94.11 146.43,108.41 Q141.09,113.35 142.50,120.48 Q144.36,139.51 150.89,162.70 Q152.90,172.81 143.91,167.78 Q123.87,154.40 106.35,146.75 Q100.00,143.20 93.65,146.75 Q76.13,154.40 56.09,167.78 Q47.10,172.81 49.11,162.70 Q55.64,139.51 57.50,120.48 Q58.91,113.35 53.57,108.41 Q40.88,94.11 21.97,79.19 Q14.40,72.19 24.64,70.98 Q48.71,70.02 67.38,65.91 Q74.61,65.05 77.65,58.44 Q87.34,41.96 95.68,19.36Z';

export default function LumitraStar({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="8 8 184 184" className={className} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d={STAR_PATH} fill="currentColor" />
    </svg>
  );
}
