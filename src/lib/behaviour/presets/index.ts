// src/lib/behaviour/presets/index.ts
//
// Every preset the palette can ask for by name. The function a name maps to is the whole
// preset: see ./nodes.ts.
//
// PURE: no React, no MST.

import { carousel } from './carousel';
import type { PresetNode } from './nodes';
import { tabs } from './tabs';
import { toolbar } from './toolbar';
import { tooltip } from './tooltip';

export type { PresetNode } from './nodes';

export const PRESETS = {
  tabs: (seed: string) => tabs({ seed }),
  toolbar: (seed: string) => toolbar({ seed }),
  tooltip: (seed: string) => tooltip({ seed }),
  carousel: (seed: string) => carousel({ seed }),
} as const satisfies Record<string, (seed: string) => PresetNode>;

export type PresetKind = keyof typeof PRESETS;
