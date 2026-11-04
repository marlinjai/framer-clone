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
   are the island's. On a part's button or input, whether it can be pressed, typed into or reached by the
   keyboard (`disabled`, `aria-disabled`, `tabindex`, and on an input `readonly` and `max`, in any spelling)
   is never stored: the normaliser drops a stored copy and the island draws none of the designer's, setting
   its own where it means something (a remove button that cannot be pressed would strand a visitor with a
   line). Order placement, the idempotency key, money and stock (server authored), the payment
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
   part is a plain node too (a duplicated control keeps its parts). Inside its own control a part has its
   place: under its spec parent (the part it belongs in, through any wrappers without a role, or the control
   itself for a top part). The editor refuses a move that would take it elsewhere, with a notice, and the
   normaliser takes the role from a part found elsewhere (an outside write), so the default comes back in its
   own place; a demo notice moved under the confirmation, which the payment step hides, cannot hide it. A
   role used twice inside a control (a paste, an outside write) stays only on its first part. Placement and
   copies are settled before anything is re-added, so one pass settles the tree (normalising twice gives the
   same object as normalising once). The role marker cannot be set or removed through
   site operations. Optional parts (the demo "simulate a declined payment" toggle) can be deleted and stay
   deleted.
5. **Parts kept in sight.** The demo notice, the simulated payment reference, the total and the pay button's
   wording are kept in sight, in four layers. The model: the stored design may style them within an
   allowlist, and the island pins at render, inline with `!important`, what would hide them, leaving the
   design's own changes alone (a hover that inverts the pay button's colours, a display that changes at a
   breakpoint). The guarantee covers accidents (see the last item).
   - The normaliser (load path, published render) removes from each of them, and from every wrapper between
     it and its control, the attributes `hidden`, `aria-hidden`, `popover` and `inert`. Their style and every
     rule they hold (whatever its selector, at every breakpoint) keep only an allowlist of style keys: type
     (colour, font, letter and word spacing, alignment, decoration), box (padding, margin, border, radius,
     background colour and image, shadow), flex and grid layout, sizes, display, visibility and opacity.
     A transform, scale, translate, rotate or filter stays when it is small (a hover lift or press: moves of
     at most 8 pixels, in `translate`, `translate3d` or `translateZ` as well, scales between 0.9 and 1.1,
     turns of at most 5 degrees, brightness, contrast or saturation between 0.7 and 1.3, and drop shadows). Anything else (a mask, containment, a clip, a position or inset, a
     text indent, a background clipped to the text, z-index, an outline wider than a focus ring, which
     paints over what is around it) goes whether or not it could hide, so a new way to hide is closed by
     default. A rule the filter empties goes with it.
     The listed keys are also checked by value: a `display` other than a visible keyword, a `visibility`
     other than visible, an `opacity` that is not a plain number of at least 0.5, a `font-size` under 10
     pixels (or 0.65 em) or not in pixels or em (a `clamp()` whose smallest size is readable stays), a zero `height`, `max-height`, `width` or `max-width`, a
     colour that is transparent or has an alpha under 0.5, a negative margin, letter or word spacing, and a
     padding over 200 pixels or 12 em all go (a value the check cannot read, a `var()` or a calc, counts as
     hiding). The control's own rules that reach inside it (a descendant, child or sibling step, such as
     `&:hover [data-checkout-demo-badge]`) lose every declaration that hides by the same value checks (plus
     `overflow`, `contain`, masks, scale, translate, rotate, an absolute or fixed position and negative
     offsets) but keep the rest, since they also style parts that are not kept in sight. No style or rule
     inside a shop control, or on it, keeps `!important`, generated `content` or an animation.
   - Nothing is laid over them: a node beside a part kept in sight, inside a part that holds one (the
     payment step, its actions row, the confirmation), loses its positioning and offsets, z-index,
     `pointer-events`, a transform beyond the small bounds above, a negative margin and an outline wider
     than a focus ring (4 pixels, offset at most 4). Grid placement stays. The control's other steps are
     never on screen with a kept part, so they keep all of it.
   - Nothing goes inside them: a part kept in sight or with fixed text holds no nodes, and a button whose
     wording is fixed holds its own parts and no text of its own. The editor refuses a drop, a palette
     insert, a generated insert or a duplicate there with a notice, and the normaliser removes what an outside write put there. None of them
     keeps an `aria-label`, `aria-labelledby`, `aria-description` or `title`, so assistive technology reads
     the fixed wording too.
   - Their tag is their spec's (a `div`, or a `span` inside the pay button), never a void tag, a template or
     anything else.
   - Each control draws one platform rule: these parts visible and opaque with `!important` (no stored rule
     carries it, so none outweighs it); no generated content (`::before`, `::after`) on them, on any wrapper
     between them and their control, nor on a button whose wording is fixed, from any rule on the page; and
     their first letter and first line look like the rest of them. It does not pin a display, so the
     designer's flex or grid stays.
   - As it renders, the island pins inline with `!important`: on the part itself, always, visible and
     opaque, the text filled with its colour, no transform, clip, mask, filter or animation, no indent or
     outline, letter and word spacing not below normal and a font size of at least 11 pixels, and its
     colour only when the computed one is see-through (then a dark default), so the label follows its
     button's colour; it is lifted above its siblings (position relative, z-index 1), which carry no
     positioning or z-index, so a sibling placed in the same grid cell cannot cover it. On the part and every
     wrapper up to the control, only where it would hide: a display of none (then block), a visibility other
     than visible, an opacity under 0.5 (or every faded wrapper, when their opacities multiply under 0.5), `content-visibility:
     hidden`, paint, size or strict containment, a clip path or mask, and an overflow that crops; each
     wrapper also gets the marker the platform rule blanks the generated content of.
   - The checkout button and the pay button hold their own parts only (the roles their spec lists): a part
     of somewhere else moved in loses its role (and with it its text), a part of theirs inside a wrapper is
     lifted out of it, and anything else (the wrapper, its text, a nested control) is dropped by the
     normaliser and ignored by the island, so no extra text joins the fixed wording and a required label is
     never lost with its wrapper.
   - The properties panel says, on a part kept in sight, a wrapper around one, or a node beside one, which
     styles the published page leaves out there, so a designer is not surprised that an effect seen on the
     canvas does not publish.
   - **What the guarantee covers** (decided by Marlin on 2026-11-03): these layers protect against
     accidents, a designer or an AI agent hiding the total, shrinking the wording or adding words to the
     pay button by mistake through ordinary styles, placement or pasted nodes. They do not try to stop a
     site's author who sets out to deceive (exotic CSS such as blend modes or extreme spacing, a node drawn
     over the button from elsewhere on the page, a colour matching its background, a colour or font
     through a page `var()`). That is the trader's own duty under section 312j of the German Civil Code,
     as on Medusa or WooCommerce; the platform, as a hosting provider, acts once it is told (notice and
     takedown). Reviews of this section judge it against accidents, not against a determined author. The
     locked alternative, the Shopify model (the platform draws the final pay step as a modal in the top
     layer, styled only through a few design tokens), is the ROADMAP line "Locked final pay step", due
     with live payments. The control's own style is the designer's (fading the whole checkout is
     allowed), and the island never walks above the control.
   The demo notice and the payment reference keep the platform's text in the site language whatever is
   stored. The checkout has no consent checkbox today (the only checkbox is the demo decline toggle), so
   there is no consent wording to protect yet.
6. **All visible strings are part text, with tokens.** Part text may hold `{total}`, `{orderNumber}`,
   `{email}`, `{message}` and the like, which the island fills. The canvas shows them filled with sample
   values and shows the raw text while it is typed. An emptied required label falls back to its default, so
   an input always has a label, and a text that drops a token it must keep (in formatted text, a token must
   sit whole in one run, as tokens are filled run by run) falls back to its default too:
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
   `enctype`, so a retyped part cannot post the buyer's name, email and address anywhere. Input parts carry
   no `name`, neither stored (the normaliser strips it) nor drawn (the island sends the order from its own state), so even a form the page wraps around the
   control has nothing of the buyer's to post.
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
2. **Add to cart and the cart** (built, held until slice 1 lands): the add to cart's button with its label
   and a sold out label, and the availability error; the cart's empty message, a line template (name, price,
   quantity with its label, remove button, the low stock warning, and the loading, no longer sold and failed
   messages) drawn once per cart line with each copy reading its own line, the estimated subtotal (it must
   keep `{subtotal}`) and the estimate notice (fixed text, kept in sight). The old `label` and `emptyContent`
   props and their bindings move to the label and empty message parts, where a binding resolves against the
   frames the island sits in (also on a control that already has parts, unless the part is bound already). A
   line no longer sold or failed to load keeps its remove button in sight whatever the design says (the
   island pins it as it does a part kept in sight), since its quantity cannot go below one. A designer's id
   on a part inside the repeated line goes, so it never repeats on the page. The pinned remove button also
   takes a press through a `pointer-events: none` of its own or of a wrapper (pinned `auto`, the design's
   value back when the pin lets go). On the canvas and in the Preview only the first copy of the line, and
   of every node inside it, carries the selection identity; every copy keeps the style hook. The quantity
   input never removes a line (zero or less is one, a blank keeps the quantity: removing is the remove
   button's), and after a removal the focus moves to the next line's remove button, else the previous one's,
   else the empty message. While a line is not counted in the subtotal (loading, failed, no longer sold or
   without a price), the estimate notice says so in the site language, and before any price is known the
   subtotal shows a placeholder (a hyphen), never a bare 0.00 without its currency. The line price and the
   subtotal are not kept in sight, by decision: they are display-only estimates, and the estimate notice
   beside them, fixed and kept in sight, already tells the visitor the final total is the checkout's. The
   checkout's total is kept in sight because it is the figure the buyer commits to when paying. Canvas states: ready, no option chosen, checking (loading), sold out and a failed
   check for the add to cart; items, empty, loading, low stock, an item no longer sold and an item that failed
   for the cart.
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
