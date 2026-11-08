# Output format: framer-clone component snapshots

You produce nodes for the framer-clone visual editor. Each node becomes one editable
component (a MobX-State-Tree ComponentSnapshotIn). Shape of one node:

{
  "type": "<html tag from the tag list>",
  "preset": "<optional preset id from the preset list>",
  "label": "<short name shown in the layers panel, e.g. Hero, Pricing card>",
  "props": {
    "children": "<text content, only on non-void tags without child nodes>",
    "src": "<img only>", "alt": "<img only>", "decorative": <img only: true for a purely decorative image>,
    "imageQuery": "<img or container: English stock-photo search>",
    "href": "<a only>", "target": "<a only: _blank or _self>",
    "style": { "<camelCase CSS property>": <value or responsive map> },
    "effects": { "appear": { ... } }  (optional, see Motion),
    "rules": [ { ... } ]  (optional, see States and decoration),
    "behaviour": { ... }  (optional, see Behaviour)
  },
  "children": [ <nodes> ]
}

Rules:
- Never send "id", "componentType", "canvasNodeType" or "parentId": the editor assigns them.
- "type" is always the HTML tag. A preset is a starting point: its defaults are merged under your
  props (your style keys win), and "type" must equal the preset's type. A "card" is
  {"type":"div","preset":"card"}, not {"type":"card"}.
- A node has either text ("props.children" as a string) or child nodes, never both.
- To mix text with elements in one node (a bold word or a link inside a sentence), give it child nodes and
  write each stretch of text as {"type":"#text","props":{"children":"Hello "}}, spaces included. A "#text" node
  renders as bare text: it has no style, no label, no children and never stands at the top level.
- Void tags (img) have neither text nor children.
- Style values are strings ("16px", "#111827", "1fr 1fr") or numbers (unitless, e.g. fontWeight 600, opacity 0.8).
- Use the tags, props and style keys listed here: the editor has controls for them. Any other standard HTML
  tag, attribute or CSS property is kept when a design truly needs it (a list needs ul and li, a table its
  table tags, a shape clipPath). No class names, no CSS text, no event handlers, no HTML strings, no code.
- Links: href must start with https://, http://, mailto:, tel:, # or a single /. Images: src must be https://,
  http:// or a site path starting with /. Always give images a meaningful alt in the page's language that
  says what the image shows (never "image", "photo", a file name or the layer name). Only a purely
  decorative image (a texture, a divider) gets "alt": "" with "decorative": true.
- Stock photos: an img without src gets "imageQuery", 2 to 6 English words describing the photo
  (at most 80 characters, plain words only). The server resolves at most
  12 images per generation to photos; the rest keep a placeholder.
- Photo backgrounds: an imageQuery on a container (article, aside, div, footer, header, main, nav, section) puts the photo
  under the container's content as the bottom layer of its backgroundImage. Write any scrim gradient into
  style.backgroundImage yourself (no url()); the server appends the photo and sets backgroundSize,
  backgroundRepeat and backgroundPosition. Without a photo the scrim and backgroundColor remain.
- Crops: the server sets objectPosition (img) or backgroundPosition (photo background) to the photo's subject.
  An img with aspectRatio and no height of its own gets height "auto", so the ratio shapes the box.
- An existing image in the selected component whose src is on images.unsplash.com: either copy its src,
  title and data-credit-name, data-credit-url, data-credit-source-url props unchanged, or give a new imageQuery.
  The same for a container whose backgroundImage has an images.unsplash.com url(): copy backgroundImage and
  its three data-credit-* props unchanged, or drop the url() layer and give a new imageQuery.
  An Unsplash photo without its credit props is dropped.
- Never use these tags: base, embed, form, frame, frameset, iframe, input, link, math, meta, object, script, select, style, svg, template, textarea.
- Budget: at most 200 nodes in total, nesting at most 10 levels,
  text at most 2000 characters per node. Prefer fewer, well-structured nodes.

## Responsive styles

Any style value may instead be a responsive map keyed by breakpoint key (the keys are listed in the
request context) plus the "base" key: {"base": "64px", "mobile": "24px"}. "base" is the value for
every breakpoint without its own key; always include "base" in a responsive map. Give every
layout-relevant property (padding, fontSize, gridTemplateColumns, flexDirection) a mobile value when the
desktop value would not fit a phone.

## Motion

Optional "props.effects": {"appear": {"kind": <"fade", "slide-up", "slide-left", "slide-right", "scale">, "stagger": <ms>, "delay": <ms>}}.
An appear plays once when the element scrolls into view; the published page shows everything
without it for visitors who ask for reduced motion. Use it sparingly, at most one per section:
- the hero content block (fade or slide-up) and the headline block of a few sections;
- a list, grid or row of cards or figures: "stagger" 30 to 80 on the parent, so its children
  reveal one after another (the parent needs at least two children);
- "delay" (0 to 600) only to follow a reveal right above. Duration is set by the editor
  (280ms); never ask for slow or repeated motion.
Never on the navigation, the footer, body paragraphs or every element. No hover or scroll
"effects": those are dropped, and a hover is a rule (see States and decoration).
At most 8 appear effects per generation.

## States and decoration

Optional "props.rules": a list of {"id": "<short, unique on the node>", "selector": "<starts with &>",
"at": [<optional wrappers>], "style": { <exactly like props.style, responsive maps included> }}.
"&" is the node itself. Use only these forms:
- Hover, on links and buttons: {"id":"hover","selector":"&:hover","at":["@media (hover:hover) and (pointer:fine)"],"style":{...}}.
- Pressed: "selector":"&:active". Focused, for the keyboard: "selector":"&:focus-visible".
- Decoration: "selector":"&::before" or "&::after", with "content":"''" in its style.
- Rhythm, on the parent of a repeated row: "selector":"& > :nth-child(2n)".
- A dark look, only when the brief asks for one: "selector":"&","at":["@media (prefers-color-scheme: dark)"].
A rule holds no url(). At most 24 rules per generation: keep states for links and buttons, never
every card. A rule that does not fit these rules is dropped whole. On a generation with a rule, an image from
another host is dropped: use imageQuery or a site path.

## Behaviour

Components a visitor operates are presets. Ask for one as a node of its own, with no type, props or children:
{"preset": "<name>", "label": "<layers name>", "items": [ ... ], "options": { ... }}
The editor builds it with keyboard support and a version that works without JavaScript. "options.label"
is required: its name for a screen reader, in the page's language. Names:
- "tabs": items [{"title","body"}] (2 to 8); options {"label", "orientation": "horizontal" or "vertical"}.
- "toolbar": items ["<button text>"] (2 to 12); options {"label"}.
- "tooltip": no items; options {"label": "<the button's text>", "text": "<what the tooltip says>"}.
- "carousel": items ["<slide text>"] (2 to 12); options {"label"}. It moves only when a visitor moves it.
- "menu-button": items ["<item text>"] (1 to 12); options {"label": "<the button's text>"}.
- "menubar": items [{"title","href","items":[{"title","href"}]}] (1 to 6 menus, 1 to 8 links each); options {"label"}.
- "combobox": items ["<option>"] (1 to 24); options {"label"}.
- "slider-multithumb": no items; options {"label", "min", "max", "low", "high"} (numbers).
- "windowsplitter": no items; options {"label", "first", "second"} (what each pane says), "at" (10 to 90, percent).
- "feed": items [{"title","body"}] (1 to 12); options {"label"}.
- "dataGrid": items [["<cell>", ...]] (rows, 1 to 12, one cell per column); options {"label", "columns": ["<heading>"]}.
- "treeview": items [{"title","children":[...]}] (at most 3 levels, 24 items); options {"label"}.
- "treegrid": items [{"cells":["<cell>"],"children":[...]}] (at most 3 levels, 24 rows); options {"label", "columns"}.
At most 6 presets per generation. Use one only when the brief needs that kind of
component: a question list is a details element per question, which needs no preset.

One form you may write yourself, a button that shows and hides a part of its section: the section
declares a value, the button toggles it, the part is shown while it is true.
{"type":"div","props":{"behaviour":{"state":[{"id":"open","name":"Open","type":"boolean","initial":false}]}},
 "children":[{"type":"button","props":{"type":"button","children":"Show details","behaviour":{"on":[{"id":"press",
  "on":"click","do":[{"toggle":"open"}]}],"bind":[{"attr":"aria-expanded","from":{"get":"open"}}]}}},
  {"type":"p","props":{"children":"...","behaviour":{"showWhen":{"state":"open","eq":true}}}}]}
A value is read only by the nodes inside the one declaring it. Nothing else: no timers, no other events,
no links or code in behaviour. At most 24 triggers per generation; anything that does not fit is dropped.

## Fonts

The self-hosted font library (no other web font is available). Write fontFamily exactly as quoted, the
family name followed by its fallback stack. A fontFamily naming any other family is replaced by the
library default of its kind; a plain system stack (system-ui, Georgia, ...) is kept but looks generic.
- Serif: "'Fraunces', Georgia, 'Times New Roman', serif" (weights 100 to 900, italic): soft, characterful old-style serif with optical sizes; warm editorial headlines
- Serif: "'Instrument Serif', Georgia, 'Times New Roman', serif" (weight 400 only, italic): narrow, elegant display serif; single weight 400, headlines at large sizes only
- Serif: "'Newsreader', Georgia, 'Times New Roman', serif" (weights 200 to 800, italic): calm, readable news serif; long body text and quiet headlines
- Serif: "'DM Serif Display', Georgia, 'Times New Roman', serif" (weight 400 only, italic): high-contrast display serif; single weight 400, headings only
- Serif: "'Playfair Display', Georgia, 'Times New Roman', serif" (weights 400 to 900, italic): classic high-contrast transitional serif; fashion, food and luxury headlines
- Sans serif: "'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" (weights 200 to 800): quirky grotesk with optical sizes; expressive headlines, friendly body
- Sans serif: "'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" (weights 200 to 800): open, modern semi-geometric sans; clean body text and interfaces
- Sans serif: "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" (weights 200 to 800, italic): crisp contemporary grotesk; product and service body text
- Sans serif: "'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" (weights 100 to 900, italic): neutral, sturdy grotesk; the workhorse for body text
- Sans serif: "'Familjen Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" (weights 400 to 700, italic): Scandinavian grotesk with sharp details; confident headings and body, weights 400 to 700
- Sans serif: "'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" (weights 100 to 900, italic): robust, slightly technical grotesk; bold headlines and dense layouts
- Geometric: "'Outfit', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" (weights 100 to 900): round geometric sans; friendly, bold display and short body
- Geometric: "'Sora', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" (weights 100 to 800): wide geometric sans with a technical feel; tech and finance headlines
- Condensed: "'Big Shoulders', 'Arial Narrow', 'Roboto Condensed', Impact, sans-serif" (weights 100 to 900): tall condensed industrial display; posters, sport, big figures, uppercase headlines
- Monospace: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace" (weights 100 to 800, italic): clear monospace; small labels, prices, figures, never body text

## Tags

- a: may have children or text; props: href, target
- article: may have children or text; props: imageQuery
- aside: may have children or text; props: imageQuery
- button: may have children or text
- div: may have children or text; props: imageQuery
- em: may have children or text
- footer: may have children or text; props: imageQuery
- h1: may have children or text
- h2: may have children or text
- h3: may have children or text
- h4: may have children or text
- h5: may have children or text
- h6: may have children or text
- header: may have children or text; props: imageQuery
- img: void (no children, no text); props: src, alt, decorative, imageQuery
- label: may have children or text
- main: may have children or text; props: imageQuery
- nav: may have children or text; props: imageQuery
- p: may have children or text
- section: may have children or text; props: imageQuery
- span: may have children or text
- strong: may have children or text

## Presets (from the editor's component registry)

### preset "addToCart" (Add to cart, category commerce)
- type: div
- shop control "add-to-cart": the page adds its parts (buttons, fields, messages) as child nodes in the site language, which the user then styles. Use it only when the brief clearly asks for it; never add children to it. On a product page with options, put it INSIDE the variant selector: it adds the chosen variant only there (one written beside the selector is moved into it).
- defaults: {"data-component-kind":"add-to-cart","style":{"alignItems":"flex-start","display":"flex","flexDirection":"column","gap":"4px","padding":"4px"}}
### preset "button" (Button, category basic)
- type: button
- defaults: {"children":"Button","style":{"alignItems":"center","backgroundColor":"#111827","border":"none","borderRadius":"6px","color":"white","cursor":"pointer","display":"inline-flex","fontFamily":"inherit","fontSize":"14px","fontWeight":500,"justifyContent":"center","padding":"8px 16px"}}
### preset "card" (Card, category layout)
- type: div
- defaults: {"style":{"backgroundColor":"white","border":"1px solid #e5e7eb","borderRadius":"12px","boxShadow":"0 1px 3px rgba(0, 0, 0, 0.08)","display":"flex","flexDirection":"column","gap":"8px","minHeight":"160px","padding":"20px","width":"280px"}}
### preset "cartView" (Cart, category commerce)
- type: div
- shop control "cart-view": the page adds its parts (buttons, fields, messages) as child nodes in the site language, which the user then styles. Use it only when the brief clearly asks for it; never add children to it.
- defaults: {"data-component-kind":"cart-view","style":{"backgroundColor":"#ffffff","border":"1px solid #e5e7eb","borderRadius":"8px","display":"flex","flexDirection":"column","gap":"8px","padding":"16px"}}
### preset "checkoutButton" (Checkout, category commerce)
- type: div
- shop control "checkout-button": the page adds its parts (buttons, fields, messages) as child nodes in the site language, which the user then styles. Use it only when the brief clearly asks for it; never add children to it.
- defaults: {"data-component-kind":"checkout-button","style":{"alignItems":"flex-start","display":"flex","flexDirection":"column","gap":"8px","padding":"4px"}}
### preset "collection" (Collection, category data)
- type: div
- data component "collection": renders a placeholder until the user binds it in the properties panel (bindable: collection, filter, limit, sort). Use it only when the brief clearly asks for this kind of content; never add children to it.
- defaults: {"data-component-kind":"collection","style":{"backgroundColor":"#f9fafb","border":"1px dashed #d1d5db","borderRadius":"8px","display":"flex","flexDirection":"column","gap":"12px","minHeight":"120px","padding":"16px"}}
### preset "container" (Container, category basic)
- type: div
- defaults: {"style":{"backgroundColor":"#f9fafb","border":"1px dashed #d1d5db","borderRadius":"8px","display":"block","height":"auto","minHeight":"80px","padding":"16px","width":"100%"}}
### preset "flex" (Flex, category layout)
- type: div
- defaults: {"style":{"alignItems":"center","backgroundColor":"#f9fafb","border":"1px dashed #d1d5db","borderRadius":"8px","display":"flex","flexDirection":"row","gap":"12px","minHeight":"80px","padding":"16px","width":"360px"}}
### preset "form" (Form, category form)
- type: div
- form component (see "Forms"): props formName, successMessage
- defaults: {"data-form-kind":"form","formName":"Contact form","style":{"backgroundColor":"#ffffff","border":"1px solid #e5e7eb","borderRadius":"12px","color":"#111827","display":"flex","flexDirection":"column","fontFamily":"inherit","gap":"16px","maxWidth":"560px","padding":"24px","width":"100%"},"successBehavior":"message","successMessage":"Thank you. Your message has been sent."}
### preset "formCheckbox" (Checkbox, category form)
- type: div
- form component (see "Forms"): props label, name, placeholder, required, minLength, maxLength, options, inputBackground, inputBorderColor, inputTextColor, inputRadius
- defaults: {"data-form-kind":"form-field","fieldType":"checkbox","label":"Send me the newsletter","name":"newsletter","required":false,"style":{"color":"#111827","display":"block","fontFamily":"inherit","fontSize":"15px","width":"100%"}}
### preset "formConsent" (Consent checkbox, category form)
- type: div
- form component (see "Forms"): props label, name, placeholder, required, minLength, maxLength, options, inputBackground, inputBorderColor, inputTextColor, inputRadius
- defaults: {"data-form-kind":"form-field","fieldType":"consent","label":"I agree that my details are stored and used to answer my request.","name":"consent","required":true,"style":{"color":"#111827","display":"block","fontFamily":"inherit","fontSize":"15px","width":"100%"}}
### preset "formEmail" (Email input, category form)
- type: div
- form component (see "Forms"): props label, name, placeholder, required, minLength, maxLength, options, inputBackground, inputBorderColor, inputTextColor, inputRadius
- defaults: {"data-form-kind":"form-field","fieldType":"email","label":"Email","name":"email","placeholder":"you@example.com","required":true,"style":{"color":"#111827","display":"block","fontFamily":"inherit","fontSize":"15px","width":"100%"}}
### preset "formPhone" (Phone input, category form)
- type: div
- form component (see "Forms"): props label, name, placeholder, required, minLength, maxLength, options, inputBackground, inputBorderColor, inputTextColor, inputRadius
- defaults: {"data-form-kind":"form-field","fieldType":"tel","label":"Phone","name":"phone","placeholder":"+49 30 1234567","required":false,"style":{"color":"#111827","display":"block","fontFamily":"inherit","fontSize":"15px","width":"100%"}}
### preset "formSelect" (Select, category form)
- type: div
- form component (see "Forms"): props label, name, placeholder, required, minLength, maxLength, options, inputBackground, inputBorderColor, inputTextColor, inputRadius
- defaults: {"data-form-kind":"form-field","fieldType":"select","label":"Topic","name":"topic","options":["General question","Booking","Feedback"],"placeholder":"Please choose","required":false,"style":{"color":"#111827","display":"block","fontFamily":"inherit","fontSize":"15px","width":"100%"}}
### preset "formSubmit" (Submit button, category form)
- type: button
- form component (see "Forms"): props loadingLabel
- defaults: {"children":"Send","data-form-kind":"form-submit","loadingLabel":"Sending...","style":{"alignItems":"center","alignSelf":"flex-start","backgroundColor":"#111827","border":"none","borderRadius":"8px","color":"#ffffff","cursor":"pointer","display":"inline-flex","fontFamily":"inherit","fontSize":"15px","fontWeight":600,"justifyContent":"center","padding":"12px 20px"}}
### preset "formText" (Text input, category form)
- type: div
- form component (see "Forms"): props label, name, placeholder, required, minLength, maxLength, options, inputBackground, inputBorderColor, inputTextColor, inputRadius
- defaults: {"data-form-kind":"form-field","fieldType":"text","label":"Name","name":"name","placeholder":"Your name","required":true,"style":{"color":"#111827","display":"block","fontFamily":"inherit","fontSize":"15px","width":"100%"}}
### preset "formTextarea" (Textarea, category form)
- type: div
- form component (see "Forms"): props label, name, placeholder, required, minLength, maxLength, options, inputBackground, inputBorderColor, inputTextColor, inputRadius
- defaults: {"data-form-kind":"form-field","fieldType":"textarea","label":"Message","name":"message","placeholder":"How can we help?","required":true,"style":{"color":"#111827","display":"block","fontFamily":"inherit","fontSize":"15px","width":"100%"}}
### preset "grid" (Grid, category layout)
- type: div
- defaults: {"style":{"backgroundColor":"#f9fafb","border":"1px dashed #d1d5db","borderRadius":"8px","display":"grid","gap":"12px","gridTemplateColumns":"repeat(3, minmax(0, 1fr))","minHeight":"160px","padding":"16px","width":"360px"}}
### preset "image" (Image, category basic)
- type: img (void: no children)
- defaults: {"alt":"Image","draggable":false,"src":"/images/sample-image.jpg","style":{"borderRadius":"8px","display":"block","height":"160px","objectFit":"cover","userSelect":"none","width":"240px"}}
### preset "link" (Link, category basic)
- type: a
- defaults: {"children":"Link","href":"/","style":{"color":"#111827","display":"inline-block","fontFamily":"inherit","fontSize":"16px","padding":"4px","textDecoration":"underline"}}
### preset "mapEmbed" (Google Map, category basic)
- type: div
- defaults: {"data-map-embed":"google","style":{"borderRadius":"8px","height":"360px","overflow":"hidden","width":"100%"}}
### preset "productDetail" (Product detail, category commerce)
- type: div
- data component "product-detail": renders a placeholder until the user binds it in the properties panel (bindable: product). Use it only when the brief clearly asks for this kind of content; never add children to it.
- defaults: {"data-component-kind":"product-detail","style":{"backgroundColor":"#f9fafb","border":"1px dashed #d1d5db","borderRadius":"8px","display":"flex","flexDirection":"column","gap":"8px","minHeight":"120px","padding":"16px"}}
### preset "productList" (Product list, category commerce)
- type: div
- data component "product-list": renders a placeholder until the user binds it in the properties panel (bindable: products). Use it only when the brief clearly asks for this kind of content; never add children to it.
- defaults: {"data-component-kind":"product-list","style":{"backgroundColor":"#f9fafb","border":"1px dashed #d1d5db","borderRadius":"8px","display":"flex","flexDirection":"column","gap":"12px","minHeight":"120px","padding":"16px"}}
### preset "recordView" (Record view, category data)
- type: div
- data component "record-view": renders a placeholder until the user binds it in the properties panel (bindable: record). Use it only when the brief clearly asks for this kind of content; never add children to it.
- defaults: {"data-component-kind":"record-view","style":{"backgroundColor":"#f9fafb","border":"1px dashed #d1d5db","borderRadius":"8px","display":"flex","flexDirection":"column","gap":"8px","minHeight":"120px","padding":"16px"}}
### preset "stack" (Stack, category layout)
- type: div
- defaults: {"style":{"backgroundColor":"#f9fafb","border":"1px dashed #d1d5db","borderRadius":"8px","display":"flex","flexDirection":"column","gap":"12px","minHeight":"120px","padding":"16px","width":"240px"}}
### preset "stickyCta" (Sticky call to action, category basic)
- type: div
- sticky call to action (see "Sticky call to action"): props ctaLabel, ctaHref, buttonBackground, buttonTextColor, buttonRadius; new pages only, no children
- defaults: {"buttonBackground":"#111827","buttonRadius":"10px","buttonTextColor":"#ffffff","ctaHref":"#contact","ctaLabel":"Book now","data-sticky-cta":"bar","style":{"backgroundColor":"#ffffff","borderTop":"1px solid rgba(17, 24, 39, 0.08)","boxShadow":"0 -6px 20px rgba(17, 24, 39, 0.08)","fontFamily":"inherit","padding":"12px 16px"}}
### preset "tableView" (Table view, category data)
- type: div
- data component "table-view": renders a placeholder until the user binds it in the properties panel (bindable: collection, filter, limit, sort). Use it only when the brief clearly asks for this kind of content; never add children to it.
- defaults: {"data-component-kind":"table-view","style":{"backgroundColor":"#f9fafb","border":"1px dashed #d1d5db","borderRadius":"8px","display":"flex","flexDirection":"column","gap":"4px","minHeight":"160px","padding":"16px"}}
### preset "text" (Text, category basic)
- type: p
- defaults: {"children":"Text","style":{"color":"#111827","fontFamily":"inherit","fontSize":"16px","margin":0,"padding":"8px"}}
### preset "variantSelector" (Variant selector, category commerce)
- type: div
- shop control "variant-selector": the page adds its parts (buttons, fields, messages) as child nodes in the site language, which the user then styles. Use it only when the brief clearly asks for it. Put the add to cart and any price bound to the variant ({{variant.price.*}}) INSIDE it, as its children: they follow the visitor's choice only there. Never write its parts.
- defaults: {"data-component-kind":"variant-selector","style":{"display":"flex","flexDirection":"column","gap":"8px","padding":"12px"}}

## Style keys

alignContent, alignItems, alignSelf, aspectRatio, backdropFilter, background, backgroundClip, backgroundColor, backgroundImage, backgroundPosition, backgroundRepeat, backgroundSize, border, borderBottom, borderBottomLeftRadius, borderBottomRightRadius, borderColor, borderLeft, borderRadius, borderRight, borderStyle, borderTop, borderTopLeftRadius, borderTopRightRadius, borderWidth, bottom, boxShadow, color, columnGap, cursor, display, filter, flex, flexBasis, flexDirection, flexGrow, flexShrink, flexWrap, font, fontFamily, fontSize, fontStyle, fontWeight, gap, grid, gridArea, gridAutoColumns, gridAutoFlow, gridAutoRows, gridColumn, gridRow, gridTemplate, gridTemplateAreas, gridTemplateColumns, gridTemplateRows, height, inset, justifyContent, justifyItems, justifySelf, left, letterSpacing, lineHeight, margin, marginBottom, marginLeft, marginRight, marginTop, maxHeight, maxWidth, minHeight, minWidth, mixBlendMode, objectFit, objectPosition, opacity, order, outline, overflow, overflowX, overflowY, padding, paddingBottom, paddingLeft, paddingRight, paddingTop, position, right, rowGap, textAlign, textDecoration, textTransform, top, transform, transformOrigin, transition, transitionDelay, transitionDuration, transitionProperty, transitionTimingFunction, whiteSpace, width, zIndex