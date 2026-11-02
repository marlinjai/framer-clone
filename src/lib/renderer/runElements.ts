// src/lib/renderer/runElements.ts
//
// The element factory every React renderer passes to renderRuns
// (src/lib/renderer/textNode.ts), which stays free of React itself. One place, so
// formatted text is made the same way on the canvas, in the preview and on the
// published page. No MST and no server-only code: the published renderer and the
// client islands import it too.

import React from 'react';
import type { ElementFactory } from './textNode';

export const createRunElement: ElementFactory<React.ReactElement> = (type, props, ...children) =>
  React.createElement(type, props, ...(children as React.ReactNode[]));
