---
type: plan
status: in-progress
date: 2026-11-02
title: "Designable shop controls: every visible part of the checkout, cart, add to cart and variant selector is a real node"
summary: "The shop controls drew their buttons, fields and messages in code with hard-coded styles, so a designer could not style, retype or translate them, and the canvas showed the checkout greyed with an unavailable message. Decided: each control's visible parts become ordinary child nodes with a role marker (data-shop-part) that the control's island reads, built from one spec. Styles, breakpoints, states, theme tokens, text editing, Layers and the AI vocabulary then work as for any node, while behaviour, data and security stay in the island. The canvas previews every state of the control with sample data. Three slices: the checkout first (built), then add to cart and the cart, then the variant selector."
tags: [framer-clone, commerce, checkout, editor, design, primitives]
projects: [framer-clone]
---

# Designable shop controls

Marlin's report (2026-11-02): on a product page in the editor the checkout button ("Zur Kasse") cannot be
edited. The canvas shows a greyed button and "Checkout is not available in the editor preview. Publish the
site to place an order.", and selecting it offers only the container's styles. The other shop controls are
the same. The code agrees: `CheckoutButton` took one `label` prop, and every button, panel, field and message
of the checkout, add to cart, cart and variant selector had inline styles written in the component.

Short forms: VAT (value-added tax), ARIA (Accessible Rich Internet Applications, the attributes that tell
assistive technology what an element is), AI (the page generator).

## Decided here, say so if you disagree

1. **Each visible part is a real child node with a role marker.** A control (the checkout, say) is a
   container node; its button, the button's label, its loading label, the payment step, the buyer fields and
   their labels, the demo notice, every message, are ordinary nodes under it, each with
   `data-shop-part="<role>"` (for example `checkout.pay`, `checkout.input.email`). The island finds them by
   role. This is the form's pattern (`data-form-kind`, `FormIsland`), which already works on the canvas and
   the published page. Why this and not a style prop per part or a theme of the control: a node gets
   everything the editor already has for free and keeps getting it as the editor grows, namely the panel's
   styles per breakpoint, the states (Hover, Pressed, Focused and authored rules), theme tokens, inline text
   editing, Layers names, duplication, wrapping in a layout of one's own, and the AI vocabulary. A parallel
   "style of the checkout" model would need each of those built twice.
2. **One spec feeds every path.** `src/lib/commerce/parts.ts` holds, per control, the roles, Layers names,
   tags, default styles and state rules, default text in English and German, which parts are required,
   which have fixed text, and the builder and normaliser. The palette insert, the editor's load path, the
   published render and the generator's insert all call it, so they cannot drift.
3. **Behaviour stays in the island.** The island passes the designer's props first and its own last, so a
   designer changes how a part looks and reads, never what it does: a button's `type`, its `disabled` and
   `aria-busy`, an input's `name`, `type`, `value`, `required`, `autocomplete`, ARIA wiring and every handler
   are the island's. Order placement, the idempotency key, money and stock (server authored), the payment
   gateway seam, Stripe, the demo company restriction, the receipt rules, the German VAT checks and "refuse
   Stripe until Books are ready" are untouched: they live in the island's controller and the server, which
   this change does not touch.
4. **Required parts cannot be lost, and roles and ids stay unique.** The editor refuses to delete a required
   part or a wrapper holding one (`PageModel.deleteComponent`, the Layers menu), with a notice saying why, and
   the generator cannot replace one (`applyGeneratedNodes`). The load path and the published render put back
   a missing required part in its default place, under an id nothing on the page uses yet (the deterministic
   `<control id>-<role>`, or it with the first free suffix). The island draws any required part its tree
   still lacks from its default. A part that leaves its control (moved out of any control or into another
   one, by drag, the Layers panel or a site operation) becomes a plain node with a fresh id, and a duplicated
   part is a plain node too (a duplicated control keeps its parts). A role used twice inside a control (a
   paste, an outside write) stays only on its first part. The role marker cannot be set or removed through
   site operations. Optional parts (the demo "simulate a declined payment" toggle) can be deleted and stay
   deleted.
5. **Parts kept in sight.** The demo notice, the simulated payment reference, the total and the pay button's
   wording are kept in sight, in three layers:
   - The normaliser (load path, published render) removes from each of them, and from every wrapper between
     it and its control, the attributes `hidden`, `aria-hidden`, `popover` and `inert`, and from their style
     and from every rule they hold (whatever its selector, at every breakpoint) any of these declarations
     unless plainly visible: `display` other than a visible keyword (block, inline, inline-block, flex,
     inline-flex, grid, inline-grid, flow-root, list-item, table, contents), `visibility` other than visible,
     `opacity` that is not a plain number of at least 0.5 (a percent or a `var()` counts as hiding),
     `content-visibility` other than visible or auto, any `clip-path`, `clip`, `transform` or `filter`, a
     `font-size` under 10 pixels (or 0.65 em) or not in pixels or em, and a zero `height`, `max-height`,
     `width` or `max-width`.
   - Their tag is their spec's (a `div`, or a `span` inside the pay button), never a void tag, a template or
     anything else.
   - As it renders, the island forces each one visible against anything left (a site head item, an inherited
     value): on the part and every wrapper up to the control, a computed `display: none`, a `visibility`
     other than visible, an `opacity` under 1 or `content-visibility: hidden` is overridden inline with
     `!important`, and on the part itself a `clip-path`, `transform` or `filter` and a font size under 11
     pixels.
   What stays possible: a designer can make one hard to read with colours, or place it off screen with
   positioning. The demo notice and the payment reference keep the platform's text in the site language
   whatever is stored. The checkout has no consent checkbox today (the only checkbox is the demo decline
   toggle), so there is no consent wording to protect yet.
6. **All visible strings are part text, with tokens.** Part text may hold `{total}`, `{orderNumber}`,
   `{email}`, `{message}` and the like, which the island fills. The canvas shows them filled with sample
   values and shows the raw text while it is typed. An emptied required label falls back to its default, so
   an input always has a name, and a text that drops a token it must keep falls back to its default too:
   `{total}` on the total, `{orderNumber}` on the confirmation and the paid thank-you. Messages the server or
   the browser writes (a refusal, a decline reason, a network error) arrive as they are inside `{message}`;
   the checkout's own wrappers around them are in the site language.
   **The pay button's wording is fixed** (decided by the coordinator on 2026-11-03 as the conservative
   default, Marlin can loosen it): the button solution of section 312j (3) of the German Civil Code wants
   the button that places a paid order to say so plainly, so its label is "Zahlungspflichtig bestellen" on a
   German site and "Buy now" on an English one, followed by the amount. It can be styled, not reworded, and
   the properties panel says why in place of the Text field (as it does for the other fixed texts).
6a. **Nothing inside a shop control sends.** Each part keeps a tag from an allowlist: behaviour, form and
   list parts keep their spec's tag (button, input, label, fieldset, legend, list and item), text and layout
   parts may be div, span, p, h1 to h6, strong, em, b, i, small, section, article, header, footer or aside,
   never a void tag, template, noscript, dialog, a link, a form or a frame. Any node inside a control that is
   a `form` renders as a `div`, and no node there keeps `action`, `formaction`, `method`, `target` or
   `enctype`, so a retyped part cannot post the buyer's name, email and address anywhere.
6b. **Labelled fields.** Each buyer input gets an id from the island and points at its label text
   (`aria-labelledby`); the field's `label` points at the input (`for`). Label, fieldset and legend tags are
   fixed.
7. **The canvas shows the design, not a greyed control.** It never runs the checkout. A bar in the editor's
   notice stack (`ShopPreviewBar`, next to the product picker) picks the state the canvas shows, from the
   island's real states: ready, empty cart (disabled), placing (loading), the payment step and its sub
   states (processing, details missing, details refused, payment failed), going to the payment page,
   confirmed, back from payment (paid, cancelled), not enough stock, items no longer sold, and checkout
   failed. It says "Sample data. Orders are placed on the published site only." Selecting a part the current
   state hides (from Layers) switches to the first state that shows it. The editor's Preview runs the real
   control against the editor cart and, when the checkout is pressed, says that orders cannot be placed in
   the editor preview, instead of greying the button.
8. **Disabled and Loading are stored rules, not new named states.** Each button part arrives with three
   rules: Hover (the named state), `&:disabled` and `&[aria-busy="true"]`, which the panel names Disabled and
   Loading. The island sets the attributes, so the published page needs no new mechanism, and the panel lists
   them like any state. Adding them to the named states would change the panel's state order everywhere and
   the score's panel column, for no gain here.
9. **Old pages are rewritten, not kept compatible** (pre-launch). A control with no parts gets the whole
   default tree, its old `label`/`payLabel` carried into the label parts; the props are removed. Part ids are
   deterministic (`<control id>-<role>`), so a reload of the same stored row gives the same tree and the
   version lock's comparison (`openProject`) stays equal until the next Save stores it. The live demo shop
   keeps working without a republish, because the published render normalises too.

## How it fits together

- **Insert:** `PageModel.insertRegistryComponent` adds the parts in the site language; the generator's
  `applyGeneratedNodes` runs the same normaliser, and the generator's schema tells it the page adds them.
- **Load:** `persistedToProjectSnapshot` and the version comparison in `openProject` run `pageWithShopParts`.
- **Canvas:** `createComponentElement` hands the control its children as the canvas drew them;
  `CheckoutCanvas` publishes a runtime for the picked state; each part renders through `ShopPartElement`
  (`src/lib/commerce/shopRuntime.tsx`) with the canvas's own selection and editing props.
- **Preview:** the same, with the live runtime.
- **Published page:** `renderPublishedPage` runs `withShopParts` before the stylesheet pass, so parts get
  classes, breakpoints and rules like any node; the island renders its children through
  `renderComponentNode`, whose `data-shop-part` branch draws each part through `ShopPartElement`.
- **Layers:** every part carries its Layers name; `layerIconOf` names notices, inputs, repeated lines and
  server messages by what they are.

## Slices

1. **Plan, shared parts, the checkout** (built, held for review because it touches the checkout): the spec,
   builder, normaliser, runtime, canvas state preview, delete guard, Layers icons, generator schema, tests.
2. **Add to cart and the cart:** the button, its label, the availability error; the cart's empty message, a
   line item template (title, variant, quantity control, line price, remove button) drawn once per line,
   subtotal and the display-only notice. The cart's `emptyContent` binding moves to the empty message part.
3. **Variant selector:** the option groups, option labels and the choice buttons as a template drawn per
   option value, with the selected and sold-out looks as stored rules.

## Score

The primitive score has no place for shop controls: its matrix rows come from the web standards (elements,
attributes, CSS, the WAI-ARIA patterns) and the reusable component promises, and the parity corpus's
BusBasis checkout page needs a filled cart on the live shop, which it does not write (see the score's
excluded list). No row is added; the round trip and every other score case stay as they were.

## Limits, stated

- A required part dragged out of its control becomes a plain node, and the control draws (and on the next
  load stores) a default copy where it belongs. The designer's styling of the moved part does not come back
  with it.
- On the canvas, a button previewed as Disabled may not take a click (browsers do not deliver clicks to a
  disabled button); select it from Layers in that state.
- Formatted text in a part keeps its marks; tokens inside it are filled run by run.
