---
title: Framer Clone
description: Visual website builder with infinite canvas and responsive design
order: 0
---

# Framer Clone

A high-performance visual website builder built with Next.js, TypeScript, and MobX State Tree. Replicates Framer's core functionality with modern web technologies.

## Features

- **Infinite Canvas** — 60fps pan/zoom with zero React re-renders
- **Responsive Design** — Multi-breakpoint editing (Desktop, Tablet, Mobile)
- **Ground Wrapper System** — Individual positioning wrappers per element (Framer's architecture)
- **Drag & Drop** — Pixel-perfect snapping with zoom compensation
- **Component Hierarchy** — Unified architecture for viewports and floating elements
- **MobX State Tree** — Predictable state with snapshots, patches, and time-travel
- **Layers Panel** — Collapsible viewport trees with component hierarchy
- **Responsive Styling** — Breakpoint-aware colors and inheritance

## Architecture

Uses MobX State Tree with a `RootStore` containing:
- `ProjectStore` — domain logic (projects, pages, components)
- `EditorUIStore` — UI state (selections, tool state, panel visibility)

## Tech Stack

- **Next.js 15** with App Router
- **TypeScript** with full type safety
- **MobX State Tree** for state management
- **Tailwind CSS** for styling
- **Radix UI** for accessible primitives

## Documentation

- [Architecture](./architecture) — Ground wrapper system and state management
- [Transform System](./transform-system) — Zero-React-render canvas transforms
