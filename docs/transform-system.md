---
title: Transform System
description: Zero-React-render canvas transform architecture for 60fps performance
order: 2
---

# High-Performance Canvas Transform System

## Overview

The canvas transform system enables smooth 60fps pan/zoom operations with real-time overlay synchronization. It uses a **ref + subscription pattern** to achieve zero React re-renders during transforms.

## Architecture

### Core Components

1. **TransformContext** — Manages transform state and subscriptions
2. **Canvas** — Applies transforms and notifies subscribers
3. **HudSurface** — Subscribes to updates and positions overlays

### Data Flow

```
User Input (pan/zoom)
    |
Canvas updates transformState.current
    |
Canvas calls notifySubscribers()
    |
HudSurface receives notification
    |
HudSurface updates overlay via direct DOM manipulation
    |
Smooth 60fps overlay tracking (no React re-renders)
```

## Key Design Decisions

- **Ref-based state**: `useRef<CanvasTransform>` for zero React re-renders
- **Subscription pattern**: `Set<() => void>` for O(1) add/remove, returns cleanup function
- **Direct DOM manipulation**: Bypass React virtual DOM for real-time updates

## Coordinate Systems

Two coordinate systems in use:
- **Real DOM elements**: Use `getBoundingClientRect()`
- **Virtual models**: Manual transformation: `screenPos = (canvasPos * zoom) + pan + containerOffset`

## Performance

| Operation | Re-renders | Method | FPS |
|-----------|------------|--------|-----|
| Pan/Zoom | 0 | Direct DOM | 60fps |
| Overlay Update | 0 | Direct DOM | Real-time |
| Selection Change | 1 (HudSurface) | Direct DOM | Instant |
