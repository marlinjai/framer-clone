---
title: Architecture
description: Ground wrapper implementation and state management
order: 1
---

# Architecture Changes: Ground Wrapper Implementation

## Overview

This document outlines the major architectural changes made to implement Framer's ground wrapper approach for canvas element positioning.

## Problem Analysis

### Original Architecture Issues
- **Single Camera Transform**: All elements transformed together via one `cameraRef`
- **No Floating Elements**: Only component trees, no canvas-level floating items
- **Missing Page Context**: No concept of page-specific canvas elements

### Framer's Architecture
- **Individual Ground Wrappers**: Each element has its own `groundNodeWrapper`
- **Independent Positioning**: Each wrapper has individual `transform: translateX() translateY() scale()`
- **Page-Specific Elements**: Floating elements belong to pages and persist when switching
- **Mixed Element Types**: Both breakpoint viewports AND floating canvas elements coexist

## Implementation

### New Models

#### CanvasElementModel
- Represents floating canvas elements (images, text, components)
- Includes transform state (position, scale, rotation, z-index)
- Supports different element types: COMPONENT, IMAGE, TEXT, SHAPE

#### Extended PageModel
- Added `canvasElements` array to hold page-specific floating elements

### New Components

- **GroundWrapper** — `position: fixed` with independent `transform: translate(x, y) scale(s) rotate(r)`
- **CanvasElementRenderer** — Renders floating elements inside their ground wrappers

### Key Principles
1. Individual element positioning via ground wrappers
2. Page-centric canvas organization
3. Framer-compatible component structure
4. GPU-optimized transforms
