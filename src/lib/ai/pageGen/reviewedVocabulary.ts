// src/lib/ai/pageGen/reviewedVocabulary.ts
//
// What a person has read and judged safe for the AI generator to write. Hand-kept
// on purpose: ./webVocabulary.ts grows whenever the web's data packages do, and a
// refusal list over growing data accepts every new name the day it is regenerated.
// That is how the browser permission elements (geolocation, camera) got in. So a
// name is refused by default, here it takes a decision: a new tag or attribute in
// the data stays out, and ./__tests__/webVocabulary.test.ts fails until it is
// listed below or in REFUSED_ATTRIBUTES with a reason.
//
// Before adding a name, ask whether it acts on its own: does it fetch, navigate,
// run, ask for a permission, open the browser's top layer, hide content from the
// owner or reach past the consent banner? Any address it takes also needs a rule in
// attributeProblem (./validate.ts). The one family not listed is aria-*: those only
// change what assistive technology hears, so a pattern covers them (./schema.ts).

const words = (text: string): ReadonlySet<string> => new Set(text.trim().split(/\s+/));

/** HTML elements. Left out, among others: the form controls, template, noscript, permission elements. */
export const REVIEWED_HTML_TAGS = words(`
  a abbr address area article aside audio b bdi bdo blockquote br button canvas caption cite code col
  colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer
  h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd label legend li main map mark menu meter nav ol
  optgroup option output p picture pre progress q rp rt ruby s samp search section selectedcontent
  slot small source span strong sub summary sup table tbody td tfoot th thead time tr track u ul
  var video wbr
`);

/** SVG elements, as SVG spells them. image, feImage and use reach other files: see attributeProblem and the expansion budget. */
export const REVIEWED_SVG_TAGS = words(`
  a animate animateMotion animateTransform circle clipPath defs desc ellipse feBlend feColorMatrix
  feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight
  feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode
  feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence filter
  foreignObject g image line linearGradient marker mask metadata mpath path pattern polygon polyline
  radialGradient rect set stop svg switch symbol text textPath title tspan use view
`);

export const REVIEWED_MATHML_TAGS = words(`
  a annotation annotation-xml math menclose merror mfrac mi mmultiscripts mn mo mover mpadded mphantom
  mprescripts mroot mrow ms mspace msqrt mstyle msub msubsup msup mtable mtd mtext mtr munder munderover
  semantics
`);

/** Attributes, lower-cased, in the markup's and React's spelling. Where each may stand comes from the data. */
export const REVIEWED_ATTRIBUTES = words(`
  abbr accent accentunder accesskey alignment-baseline alignmentbaseline alpha alt anchor attributename
  attributetype autocapitalize autocorrect autoplay azimuth basefrequency baseline-shift baselineshift
  bias by calcmode cite clip-path clip-rule clippath clippathunits cliprule color-interpolation
  color-interpolation-filters colorinterpolation colorinterpolationfilters colorspace cols colspan
  columnspan containertiming containertimingignore controls controlslist coords cx cy d datetime decoding
  default depth dir direction disablepictureinpicture disableremoteplayback disabled displaystyle divisor
  diffuseconstant dominant-baseline dominantbaseline download draggable dur dx dy edgemode elementtiming
  elevation enterkeyhint exportparts fetchpriority fill fill-opacity fill-rule fillopacity fillrule
  filterunits flood-color flood-opacity floodcolor floodopacity focusgroup focusgroupstart font-size
  font-size-adjust font-stretch font-style font-variant font-weight fontsize fontsizeadjust fontstretch
  fontstyle fontvariant fontweight fr from fx fy gradienttransform gradientunits headers headingoffset
  headingreset hidden high href hreflang id image-rendering imagerendering in in2 inert inputmode ismap
  k1 k2 k3 k4 kernelmatrix kernelunitlength keypoints kind label lang largeop lengthadjust letter-spacing
  letterspacing lighting-color lightingcolor limitingconeangle linethickness loop low lspace marker-end
  marker-mid marker-start markerend markerheight markermid markerstart markerunits markerwidth
  mask maskcontentunits maskunits mathvariant max maxsize media method min minsize mode movablelimits multiple muted
  name numoctaves offset open operator optimum orient origin paint-order paintorder part path pathlength
  patterncontentunits patterntransform patternunits playsinline pointer-events pointerevents points pointsatx pointsaty pointsatz
  poster preload preservealpha preserveaspectratio primitiveunits r radius refx refy rel repeatcount
  requiredextensions reversed role rotate rows rowspan rspace rx ry scale scope scriptlevel seed selected
  shape shape-rendering shaperendering side size sizes slot spacing span specularconstant specularexponent
  spellcheck spreadmethod src srclang srcset start startoffset stddeviation stitchtiles stop-color
  stop-opacity stopcolor stopopacity stretchy stroke stroke-dasharray stroke-dashoffset stroke-linecap
  stroke-linejoin stroke-miterlimit stroke-opacity stroke-width strokedasharray strokedashoffset
  strokelinecap strokelinejoin strokemiterlimit strokeopacity strokewidth surfacescale symmetric
  systemlanguage tabindex target targetx targety text-anchor text-decoration text-overflow text-rendering
  textanchor textdecoration textlength textrendering title to transform-origin transformorigin translate
  type unicode-bidi unicodebidi usemap value values vector-effect vectoreffect viewbox virtualkeyboardpolicy
  visibility voffset white-space word-spacing wordspacing writing-mode writingmode writingsuggestions
  x x1 x2 xchannelselector xlink:href xlinkhref y y1 y2 ychannelselector z
`);

/**
 * Attributes judged and refused, lower-cased, by what they would do. Only the test
 * reads this: refused by default means a name here and a name nobody has seen are
 * treated alike. On tags the generator never writes, such as input, nothing needs
 * listing.
 */
export const REFUSED_ATTRIBUTES = words(`
  class classname
  nonce
  is
  drawable
  action formaction formenctype formmethod formnovalidate formtarget form
  ping attributionsourceid data srcdoc manifest manifestid
  referrerpolicy crossorigin loading
  autofocus contenteditable
  popover popovertarget popovertargetaction command commandfor closedby
  font-family
  autolocate
  htmlfor for
  shadowrootclonable shadowrootcustomelementregistry shadowrootdelegatesfocus shadowrootmode
  shadowrootserializable shadowrootslotassignment
  data_attributes
`);

/**
 * What an SVG animation may change. Its attributeName takes any name, so a refusal
 * list would have to foresee every attribute that matters (it missed target). These
 * only move or repaint a shape.
 */
export const REVIEWED_ANIMATED_ATTRIBUTES = words(`
  cx cy d dx dy fill fill-opacity offset opacity points r rx ry stop-color stop-opacity stroke
  stroke-dasharray stroke-dashoffset stroke-opacity stroke-width transform visibility x x1 x2 y y1 y2
`);
