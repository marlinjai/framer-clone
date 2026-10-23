// src/lib/styles/cssPropSet.ts
//
// Prop keys the editor treats as CSS: a node may carry one at the top level of
// its props (not only inside `style`), and every renderer routes it into the
// style object. Kept free of model imports so the published-page server path
// can use it without pulling in MobX-State-Tree.

export const CSS_PROP_SET = new Set<string>([
  'width','height','minWidth','minHeight','maxWidth','maxHeight','aspectRatio',
  'display','position','top','right','bottom','left','inset',
  'padding','paddingTop','paddingRight','paddingBottom','paddingLeft',
  'margin','marginTop','marginRight','marginBottom','marginLeft',
  'gap','rowGap','columnGap',
  'flex','flexGrow','flexShrink','flexBasis','flexDirection','flexWrap','alignItems','alignContent','alignSelf','justifyItems','justifySelf','justifyContent','order',
  'grid','gridTemplate','gridTemplateColumns','gridTemplateRows','gridTemplateAreas','gridArea','gridColumn','gridRow','gridAutoFlow','gridAutoRows','gridAutoColumns',
  'font','fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textAlign','textDecoration','textTransform','whiteSpace',
  'color','background','backgroundColor','backgroundImage','backgroundSize','backgroundPosition','backgroundRepeat','backgroundClip',
  'border','borderWidth','borderStyle','borderColor','borderTop','borderRight','borderBottom','borderLeft',
  'borderRadius','borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius','boxShadow','outline',
  'opacity','filter','backdropFilter','mixBlendMode',
  'transform','transformOrigin','transition','transitionProperty','transitionDuration','transitionDelay','transitionTimingFunction',
  'overflow','overflowX','overflowY','zIndex','cursor','objectFit','objectPosition'
]);
