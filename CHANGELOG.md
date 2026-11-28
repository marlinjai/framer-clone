# Changelog

All notable changes to the Framer Clone (Visual Builder) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Unpublish a site from the Published versions dialog or from its card on the projects page. The project, its versions, address and domains are kept.
- Site agents make and change components: `createComponent` (from nodes, with refs for the component and its placement), `renameComponent`, `addComponentInput` (with `connect`, a field inside the component reads it, as the editor's Make input), `renameComponentInput`, `removeComponentInput` (counts the values and connections it takes across every page) and `setComponentInputDefault`. Each goes through the editor's own model action and refuses, writing nothing, what the editor refuses.
- The Inputs section of an open component has a Default field per input, also for an input a field reads (gap A4).
- Site agents read and set component inputs. `get_site` lists each component with its inputs (id, name, type, default, options), its own page and how many placements use it; `get_page` shows each placement's values and where each comes from (its own, the default, data, or a stored value the input refuses), and reads a component's own page. `placeComponent` takes values, and the new `setComponentInputs` sets or resets values of a placement. Each value is checked against its input's type as in the editor, which now writes through the same model action; an unknown input, an event input, an input bound to data or a refused value refuses the batch and writes nothing.

### Fixed

- Make input after an unlink connects the input nothing reads any more again, instead of adding a second one while the placements' values stayed on the first (gap A4). It takes the input the row is named after or whose default is the field's current value; with no such input, or several, it still adds one.
- Site agents can place components. Every `placeComponent` was refused as `<#component> is not rendered here`, and so was any later change to a section holding a component. The check now judges the component's own content where it is placed. A missing or broken component, content that would not render there, and a target that cannot hold elements are still refused, and an agent can no longer move a node into an element that takes no children. Removing a node inside a component is checked against every place the component is used.
- A component is no longer accepted inside a paragraph, in the editor or from an agent, when anything it draws would end the paragraph, also deeper than its outer element or in a component it places.

## [0.4.0] - 2026-03-01

### Changed

- Migrate from npm to pnpm

## [0.3.0] - 2026-02-10

### Added

- Standardized docs: index.md, architecture.md, transform-system.md

### Fixed

- Fix doc links: use absolute paths for Clearify routing

## [0.2.0] - 2025-08-28

### Added

- Implement layers panel
- Stabilize component model
- Implement functioning selection overlays
- Implement drag and drop for floating elements with overlay hiding

### Changed

- Refactor responsive design handling and component models
- Begin removing unnecessary zoom from UI store
- Simplify breakpoint and component model, fix selections
- Improve sidebar stability

### Fixed

- Fix selection for image elements

### Docs

- Add system documentation comments
- Update README

## [0.1.0] - 2025-08-21

### Added

- Initial Next.js project setup
- Infinite canvas and component model with MobX
- Component structure and responsive design features with MobX integration
- Enhanced project structure and UI components with MobX state management

### Changed

- Refactor UI layout and optimize Canvas component for performance
- Clean up test components and editor UI types
<!-- ci-replay touch -->
