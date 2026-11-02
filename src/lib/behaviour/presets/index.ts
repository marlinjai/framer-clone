// src/lib/behaviour/presets/index.ts
//
// Every preset the palette can ask for by name. The function a name maps to is the whole
// preset: see ./nodes.ts.
//
// PURE: no React, no MST.

import { carousel } from './carousel';
import { combobox } from './combobox';
import { feed } from './feed';
import { grid } from './grid';
import { menuButton } from './menu';
import { menubar } from './menubar';
import type { PresetNode } from './nodes';
import { multithumbSlider } from './slider';
import { splitter } from './splitter';
import { tabs } from './tabs';
import { toolbar } from './toolbar';
import { tooltip } from './tooltip';
import { treegrid, treeview } from './tree';

export type { PresetNode } from './nodes';

export const PRESETS = {
  tabs: (seed: string) => tabs({ seed }),
  toolbar: (seed: string) => toolbar({ seed }),
  tooltip: (seed: string) => tooltip({ seed }),
  carousel: (seed: string) => carousel({ seed }),
  'menu-button': (seed: string) => menuButton({ seed }),
  menubar: (seed: string) => menubar({ seed }),
  combobox: (seed: string) => combobox({ seed }),
  'slider-multithumb': (seed: string) => multithumbSlider({ seed }),
  windowsplitter: (seed: string) => splitter({ seed }),
  feed: (seed: string) => feed({ seed }),
  grid: (seed: string) => grid({ seed }),
  treeview: (seed: string) => treeview({ seed }),
  treegrid: (seed: string) => treegrid({ seed }),
} as const satisfies Record<string, (seed: string) => PresetNode>;

export type PresetKind = keyof typeof PRESETS;
