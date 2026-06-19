---
name: editor-chrome-redesign
track: editor-chrome
wave: 3
priority: P1
status: decided
type: plan
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2b-cms-datatable-grid-ui]
touchesSharedState: false
sharedState: [src/app/globals.css]
estimateDays: 2
verify: pnpm exec tsc --noEmit && pnpm lint && pnpm test
owner: Design Systems Engineer
date: 2026-06-20
---

# Editor chrome redesign: Layers tree + Properties panel ("Studio" language)

> Restyle the left **Layers** tree and the right **Properties** panel to match the approved
> mockup `docs/specs/build-2026-06/editor-chrome-redesign-mockup.html`, in the same Studio
> system as the Content panel + grid. This is a **visual/structural fidelity** pass, NOT a
> color migration: the panels were already token-polished in commit `fd9b61c`, so almost no
> hardcoded colors remain. The job is to bring the layout, spacing, controls, and affordances
> up to the mockup, and to close the two remaining hardcoded-color holes as zero-tech-debt fixes.

## Visual target (the mockup, distilled)

Open the mockup file to see it; the exact metrics below are lifted from its CSS so you do not
have to re-derive them. Accent `#5B5BD6` is the existing `--brand` token; `accent-12` ≈
`brand/12` and `accent-10` ≈ `brand/10` (use the Tailwind `brand/10` opacity utilities).

### Layers tree (`LayersPanel.tsx`)
- **Viewport group row** (Desktop / Tablet / Mobile): height 30px. Chevron (expand/collapse) +
  **device icon** (`Monitor` / `Tablet` / `Smartphone`, 15px, `text-muted-foreground`) + name in
  **uppercase** (12.5px, weight 600, `text-muted-foreground`, letter-spacing .02em) + a right-aligned
  **dimension pill** (`mono`, 10.5px, `text-muted-foreground`, `bg-muted`, hairline border, radius 5px,
  padding 1px 6px) showing the breakpoint width (1280 / 768 / 320).
- **Layer row**: height 28px. Left **indent guide** (a thin vertical rule, `border-border`/`bd-strong`
  color, one per nesting level), chevron (13px, only when the row has children), **type icon**
  (`.tico` 14px `text-muted-foreground`; selected → `text-brand`), name (13px, `text-foreground`;
  selected → `text-brand` + weight 500, truncate), and **hover-revealed actions** on the right:
  visibility (`Eye` / `EyeOff`), lock (`LockOpen` / `Lock`), and overflow (`MoreHorizontal`) for
  container rows OR delete (`Trash2`) for leaf rows. Each action 22x22, radius 5, `text-muted-foreground`,
  hover `bg-accent`/`text-foreground`. The actions are **hidden until row hover or selected**
  (`group-hover` reveal), EXCEPT a hidden element shows a **dimmed `EyeOff`** persistently
  (`text-border`/`bd-strong`) so "off" is a visible state, never a missing control.
- **Selection**: `bg-brand/10` + a 2px `bg-brand` left rail (the existing `border-l-2 border-brand`
  pattern is acceptable; the mockup uses an inset `::before` rail — either reads as the same).
- Indent: 14px padding-left per nesting level (the existing depth tracking stays).
- **"Floating elements"** section header: an uppercase label (11px, 600, `text-muted-foreground`) +
  a count pill (10.5px, 600, `text-muted-foreground`, `bg-muted`, radius-full, padding 1px 7px).

### Properties panel (`RightSidebar` + sections + primitives)
- **Header** (`RightSidebarHeader`): 42px. A 22x22 rounded **type tile** (`bg-brand/12`, `text-brand`,
  radius 6) holding the selected element's type icon + the element name (13px, weight 600) + a
  settings icon (`Settings2`) on the right.
- **Section header** (`CollapsibleSection`): 38px. chevron (13px) + section icon (14px) + **title**
  (11px, weight 600, **uppercase**, letter-spacing .05em, `text-muted-foreground`). Section divider:
  `border-b border-border`.
- **Field row**: a `grid-cols-[64px_1fr]` aligned label+control. Label `.k` = 11.5px
  `text-muted-foreground`; control on the right.
- **Input** (`.inp`): 30px tall, hairline border, radius 7, `bg-background`, 12.5px. Focus →
  `border-brand` + `ring-3 ring-brand/12`.
- **Unit segment** (`.unit`): a 30px, min-width 48px attached affordance after the input
  (`bg-muted`, hairline border, radius 7) showing the unit (`px`) + a small chevron, `mono` 12px.
  This is the `DimensionInput` unit selector restyled to sit visually attached to the value input.
- **W / H** are a **two-up** row (`.two`): two fields side by side, each `auto`-label + input + unit.
- **Display** is a real **text segmented control** (`.seg`): Block / Flex / Grid, `bg-muted` track,
  radius 7, padding 2; active segment → `bg-background` + `text-foreground` + `shadow-sm`; inactive
  → `text-muted-foreground`. (Today `LayoutSection` renders Display via `ToggleIconGroup` with icons;
  switch it to this text segmented control to match the mockup. Keep the flex sub-controls.)
- **Opacity** slider: 4px track (`bg-muted`), `bg-brand` fill, 14px white knob with hairline border +
  `shadow-sm`, paired with a 52px numeric input. **Visible** = an iris `Switch` (`bg-brand` when on).
- **Fill / Text** color rows: a 28x28 rounded swatch (radius 7, hairline border) + a `mono` hex input.
- **Overflow / Border style / Font family etc.**: the `.sel` select look (30px, hairline border,
  radius 7, trailing chevron).
- **"Min / Max"** and **"Individual sides"** are `.more-link` disclosure rows (11.5px
  `text-muted-foreground` + chevron) — the existing expand toggles, restyled.

## Scope

**In (restyle only; preserve every MST observer, hook, store action, and the responsive
`getResponsiveStyleValue` / `updateResponsiveStyle` read/write contract):**

| File | Change |
|------|--------|
| `src/components/sidebars/left/LayersPanel.tsx` | Viewport group rows (device icon + dimension pill), indent guides, type-icon-per-element, hover-revealed action cluster, dimmed-eye "off" state, Floating-elements header + count pill. |
| `src/components/sidebars/right/RightSidebarHeader.tsx` | Type tile (brand/12) + name + settings icon, 42px header. |
| `src/components/sidebars/right/primitives/CollapsibleSection.tsx` | 38px header with icon + uppercase title + chevron; consistent body padding/gap (`px-3 pb-3.5 gap-2.5`). |
| `src/components/sidebars/right/primitives/DimensionInput.tsx` | Attached unit segment (`bg-muted` pill with chevron) after a 30px value input; focus ring `ring-brand/12`. |
| `src/components/sidebars/right/primitives/ColorInput.tsx` | 28px rounded swatch + mono hex input on the field grid. |
| `src/components/sidebars/right/primitives/PropertySlider.tsx` | Iris fill + white knob + 52px numeric input. |
| `src/components/sidebars/right/primitives/PropertySelect.tsx` | `.sel` trigger look (30px, hairline, trailing chevron). |
| `src/components/sidebars/right/primitives/ToggleIconGroup.tsx` | Align to the segmented-track look where used; keep icon variants for align/decoration. |
| `src/components/sidebars/right/sections/LayoutSection.tsx` | Render **Display** as the text segmented control (Block/Flex/Grid). Keep flex sub-controls + padding. |
| `src/components/sidebars/right/sections/{Size,Position,Styles,Typography}Section.tsx` | Field-grid alignment (64px label), two-up W/H in Size, `.more-link` disclosures. No logic change. |
| `src/components/sidebars/right/sections/DataSourceSection.tsx` | Visual alignment only (already token-driven). |
| `src/app/globals.css` | **Add a `--warning` token** (amber) in `:root` and `.dark`, plus `--color-warning` + `--color-warning-foreground` in `@theme inline`. |
| `src/components/sidebars/right/BindingControl.tsx` | **Zero-tech-debt fix:** replace hardcoded `border-amber-400 bg-amber-50 text-amber-700` (line ~94, broken-binding warning) with the new `border-warning bg-warning/10 text-warning` tokens. |
| `src/components/sidebars/right/BindingPicker.tsx` | **Zero-tech-debt fix:** replace `text-white` (line ~262, Apply button on `bg-brand`) with `text-brand-foreground`. |

**Out (not this slice):** any MST store/model change; new sections or properties; the canvas;
the top bar (separately polished already); dark-mode design QA beyond "tokens resolve" (light is
the live target).

## Conventions (hard)
- **Studio tokens only.** No hardcoded `gray/blue/red/amber/slate/zinc/white/black` Tailwind colors
  anywhere you touch. Use `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-muted`,
  `bg-accent`, `border-border`, `text-brand`, `bg-brand/10`, `text-brand-foreground`, `text-destructive`,
  and the new `--warning` token. After your pass, `grep -rE "amber-|-blue-|-gray-|text-white|bg-white" src/components/sidebars` must be empty (other than intentional swatch defaults that render user colors).
- **Preserve MST wiring.** Do not rename/move `observer()` wrappers, `useStore()`/`useDragSource()`
  calls, conditional rendering (`isViewportNode`/`isFloatingElement`), or the ternaries that compute
  active/selected state. Only className strings + small presentational JSX (icons, pills, guides) change.
- **lucide-react** (`^0.540.0`) is already installed; import icons from it.
- Match the mockup's metrics; it is the source of truth for spacing, radii, and weights.

## Tests (headless `.test.ts(x)`, in the `pnpm test` gate)
- Existing `sidebars/right/__tests__/*` (BindingPicker, QueryBuilder, scopeIntrospection) stay green.
- **Add** `BindingControl.test.tsx` if not present: asserts the broken-binding state renders with the
  warning token classes (not amber) and the bound state renders `text-brand`; asserts unlink calls
  `clearBinding`. (Proves the zero-tech-debt color fix + preserves the bind/unbind contract.)
- No snapshot tests of styling; assert behavior + the presence of token classes where it proves the fix.

## Verification
- Gates green in the worktree: `pnpm exec tsc --noEmit && pnpm lint && pnpm test`. (Build is run by
  the Lead at integration; this slice is client-only restyle.)
- The Lead does the authoritative live-verify + screenshot against the running editor after merge.

## Definition of done
- [ ] Layers tree + Properties panel match the mockup (viewport groups, guides, hover actions,
      field-grid, unit segments, segmented Display, iris slider/switch, swatches, section headers).
- [ ] Both hardcoded colors removed (`--warning` token added; amber + `text-white` gone).
- [ ] All MST wiring preserved; no behavior change.
- [ ] `tsc + lint + test` green; status → in-progress → completed.
