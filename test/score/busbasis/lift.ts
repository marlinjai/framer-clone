// The node tree of a frozen BusBasis page, lifted mechanically from its DOM and its
// stylesheet. One rule set for every page and no page-specific code: that is what
// makes the tree a rebuild and not a fit.
//
// `liftDocument` runs inside Chromium on the frozen page. It reads authored CSS only,
// never `getComputedStyle`, which would resolve the cascade for the format and hide
// exactly what the corpus exists to find. For each element, in cascade order:
//
//   - a declaration that needs no selector goes on the node, as an author would;
//   - what needs a state, a pseudo-element or an at-rule goes in `props.rules`, written
//     the way the panel stores it;
//   - a condition that can be decided from the frozen page (`.dark`, `:first-child`,
//     `.space-y-2 > * + *`) is decided here, because no author would restate it. The
//     site is dark only, so its `dark:` variants are simply the page.
//
// What the format has no place for is reported, never faked. `html` and `body` belong
// to the route, so their declarations move to the root node, the closest thing an
// author has, and whatever that cannot do shows up as a difference in the score.

export type StyleMap = Record<string, string>;

export interface LiftedRule {
  id: string;
  selector?: string;
  at?: string[];
  style?: StyleMap;
  define?: string;
  blocks?: { selector: string; style: StyleMap }[];
}

export interface LiftedNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: LiftedNode[];
}

export interface LiftReport {
  /** Rules of the stylesheet no element of this page uses, or that could not be read. */
  unreadSelectors: string[];
  /** A selector part the walk could not turn into a rule, with how often it applied. */
  unliftable: { selector: string; reason: string; elements: number }[];
  /** Declarations of `html` the root node took over, because children inherit them. */
  rootTook: string[];
  /** Declarations of `html` that act on the document itself, so no node can hold them. */
  rootLeft: string[];
}

export interface LiftResult {
  root: LiftedNode;
  report: LiftReport;
}

/** React's spelling of an attribute, where it is not the HTML one. */
const ATTRIBUTE_NAMES: Record<string, string> = {
  tabindex: 'tabIndex', readonly: 'readOnly', autocomplete: 'autoComplete', autofocus: 'autoFocus', for: 'htmlFor',
  maxlength: 'maxLength', minlength: 'minLength', colspan: 'colSpan', rowspan: 'rowSpan', srcdoc: 'srcDoc',
  playsinline: 'playsInline', autoplay: 'autoPlay', crossorigin: 'crossOrigin', enterkeyhint: 'enterKeyHint',
  inputmode: 'inputMode', referrerpolicy: 'referrerPolicy', allowfullscreen: 'allowFullScreen', novalidate: 'noValidate',
  datetime: 'dateTime', usemap: 'useMap', contenteditable: 'contentEditable', spellcheck: 'spellCheck',
  value: 'defaultValue', checked: 'defaultChecked',
};

/**
 * Runs in the page: no closure, no import. Serialised by Playwright, so everything
 * it needs is inside it.
 */
export function liftDocument(input: { attributeNames: Record<string, string> }): LiftResult {
  const INHERITED = new Set([
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontFeatureSettings', 'fontVariationSettings', 'lineHeight', 'color',
    'letterSpacing', 'textSizeAdjust', 'WebkitTextSizeAdjust', 'tabSize', 'WebkitTapHighlightColor', 'WebkitFontSmoothing', 'MozOsxFontSmoothing',
    'textRendering', 'colorScheme',
  ]);
  const STATES = [
    'focus-visible', 'focus-within', 'hover', 'focus', 'active', 'disabled', 'enabled', 'checked', 'invalid', 'valid',
    'placeholder-shown', '-webkit-autofill', 'autofill', 'visited', 'target', 'indeterminate', 'required', 'read-only',
  ];
  const STATE_RE = new RegExp(`(?<!\\\\):(${STATES.join('|')})(?![\\w-])`, 'g');
  const HEX_ESCAPE = /\\[0-9a-fA-F]{1,6} ?/g;
  const PSEUDO_ELEMENT_RE = /(?<!\\)::[-\w]+(?:\([^)]*\))?\s*$/;

  interface Declaration { name: string; value: string; important: boolean }
  interface Part {
    selectorText: string;
    match: string;
    pseudoElement: string;
    states: string[];
    /** What must hold around the subject for a state on another element, or ''. */
    context: string;
    specificity: number;
    order: number;
    at: string[];
    declarations: Declaration[];
  }

  const report: LiftReport = { unreadSelectors: [], unliftable: [], rootTook: [], rootLeft: [] };

  const camel = (name: string): string => {
    if (name.startsWith('--')) return name;
    const parts = name.replace(/^-/, '').split('-');
    const joined = parts.map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join('');
    return name.startsWith('-') ? joined[0].toUpperCase() + joined.slice(1) : joined;
  };

  /** A top-level split that respects quotes and brackets, and backslash escapes. */
  const splitTop = (text: string, separator: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') { i++; continue; }
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === separator && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
  };

  const readDeclarations = (cssText: string): Declaration[] =>
    splitTop(cssText, ';').flatMap((entry) => {
      const colon = entry.indexOf(':');
      if (colon < 0) return [];
      const name = entry.slice(0, colon).trim();
      let value = entry.slice(colon + 1).trim();
      // `--tw-blur: ;` is a value: the empty one that keeps a var() list valid.
      if (!name || (!value && !name.startsWith('--'))) return [];
      if (!value) return [{ name, value: ' ', important: false }];
      const important = /!\s*important\s*$/i.test(value);
      if (important) value = value.replace(/\s*!\s*important\s*$/i, '');
      return [{ name, value, important }];
    });

  const specificityOf = (selector: string): number => {
    let text = selector.replace(HEX_ESCAPE, 'x').replace(/\\./g, 'x').replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '');
    const inner: number[] = [];
    text = text.replace(/:(?:is|not|has)\(((?:[^()]|\([^()]*\))*)\)/g, (_, list: string) => {
      inner.push(Math.max(...splitTop(list, ',').map(specificityOf)));
      return '';
    });
    const ids = (text.match(/#[-\w]+/g) ?? []).length;
    const pseudoElements = (text.match(/::[-\w]+/g) ?? []).length;
    text = text.replace(/::[-\w]+/g, '');
    const classes = (text.match(/\.[-\w]+|\[[^\]]*\]|:[-\w]+/g) ?? []).length;
    text = text.replace(/\.[-\w]+|\[[^\]]*\]|:[-\w]+(?:\([^)]*\))?/g, ' ');
    const types = (text.match(/[a-zA-Z][-\w]*/g) ?? []).length + pseudoElements;
    return ids * 10000 + classes * 100 + types + inner.reduce((a, b) => a + b, 0);
  };

  /** Top-level compounds and the combinators between them. */
  const compoundsOf = (selector: string): { compounds: string[]; combinators: string[] } => {
    const compounds: string[] = [];
    const combinators: string[] = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      if (ch === '\\') {
        // A hex escape ends in a space that belongs to it: `.\32 xl\:flex` is one class.
        const hex = selector.slice(i).match(/^\\[0-9a-fA-F]{1,6} ?/);
        const escape = hex ? hex[0] : selector.slice(i, i + 2);
        current += escape;
        i += escape.length - 1;
        continue;
      }
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) {
        let j = i;
        let combinator = '';
        while (j < selector.length && ' >+~'.includes(selector[j])) { if (selector[j] !== ' ') combinator = selector[j]; j++; }
        if (current) { compounds.push(current); combinators.push(combinator || ' '); current = ''; }
        i = j - 1;
        continue;
      }
      current += ch;
    }
    if (current) compounds.push(current);
    return { compounds, combinators };
  };

  const noState = (compound: string): string => {
    const stripped = compound.replace(STATE_RE, '');
    return stripped === '' || stripped.startsWith(':') ? `*${stripped}` : stripped;
  };

  /** One selector list entry as the parts the walk needs, or why not. */
  const readPart = (raw: string): Omit<Part, 'order' | 'at' | 'declarations'> | string => {
    const selectorText = raw.trim();
    const element = selectorText.match(PSEUDO_ELEMENT_RE);
    const pseudoElement = element ? element[0].trim() : '';
    const bare = element ? selectorText.slice(0, element.index).trimEnd() : selectorText;
    if (/:not\([^)]*:(?:hover|focus|active|disabled|checked)/.test(bare)) return 'a negated state';
    const { compounds, combinators } = compoundsOf(bare);
    if (compounds.length === 0) return 'empty';
    const subject = compounds[compounds.length - 1];
    const states = [...subject.matchAll(STATE_RE)].map((m) => `:${m[1]}`);
    const before = compounds.slice(0, -1);
    const stateBefore = before.some((c) => new RegExp(STATE_RE.source).test(c));
    let context = '';
    if (stateBefore) {
      // `.group:hover .x` becomes `&:is(.group:hover *)`: the subject under a condition.
      let text = '';
      before.forEach((c, i) => { text += `${c}${combinators[i] === ' ' ? ' ' : ` ${combinators[i]} `}`; });
      context = `${text}*`;
    }
    const staticBefore = before.map(noState);
    let match = '';
    staticBefore.forEach((c, i) => { match += `${c}${combinators[i] === ' ' ? ' ' : ` ${combinators[i]} `}`; });
    match += noState(subject);
    return { selectorText, match, pseudoElement, states, context, specificity: specificityOf(selectorText) };
  };

  const parts: Part[] = [];
  const keyframes = new Map<string, LiftedRule>();
  let order = 0;

  const walk = (rules: CSSRuleList, at: string[]): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const declarations = readDeclarations(rule.style.cssText);
        for (const raw of splitTop(rule.selectorText, ',')) {
          const part = readPart(raw);
          if (typeof part === 'string') {
            report.unreadSelectors.push(`${raw.trim()}: ${part}`);
            continue;
          }
          parts.push({ ...part, order: order++, at, declarations });
        }
      } else if (rule instanceof CSSMediaRule) walk(rule.cssRules, [...at, `@media ${rule.media.mediaText}`]);
      else if (rule instanceof CSSSupportsRule) walk(rule.cssRules, [...at, `@supports ${rule.conditionText}`]);
      else if (rule instanceof CSSKeyframesRule) {
        keyframes.set(rule.name, {
          id: `keyframes-${rule.name}`,
          define: `@keyframes ${rule.name}`,
          blocks: Array.from(rule.cssRules).map((frame) => {
            const style: StyleMap = {};
            for (const d of readDeclarations((frame as CSSKeyframeRule).style.cssText)) style[camel(d.name)] = d.value;
            return { selector: (frame as CSSKeyframeRule).keyText, style };
          }),
        });
      } else report.unreadSelectors.push(rule.cssText.slice(0, 120));
    }
  };
  for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules, []);

  // Each entry's elements, found once: the sheet has far more entries than a page uses.
  const matchedBy = new Map<Element, Part[]>();
  const defaults = new Map<string, string>();
  for (const part of parts) {
    let elements: Element[];
    try {
      elements = Array.from(document.querySelectorAll(part.match));
    } catch {
      report.unreadSelectors.push(part.selectorText);
      continue;
    }
    // Tailwind's reset gives every element its variables. They only matter where read.
    if (/^(?:\*|\*::before|\*::after|::before|::after|::backdrop)?$/.test(part.selectorText.replace(/^\*(?=::)/, '')) || part.selectorText === '*') {
      for (const d of part.declarations) if (d.name.startsWith('--')) defaults.set(d.name, d.value);
    }
    for (const el of elements) {
      const list = matchedBy.get(el);
      if (list) list.push(part);
      else matchedBy.set(el, [part]);
    }
  }

  const byCascade = (a: Part, b: Part) => a.specificity - b.specificity || a.order - b.order;

  const isDefaultVariable = (part: Part, d: Declaration) => d.name.startsWith('--') && /^(?:\*|::before|::after|::backdrop)$/.test(part.match);

  const applyDeclarations = (target: StyleMap, list: Part[], important: boolean): void => {
    for (const part of list) {
      for (const d of part.declarations) {
        if (d.important !== important || isDefaultVariable(part, d)) continue;
        const key = camel(d.name);
        // Delete first: a later shorthand must come after the longhands it replaces.
        delete target[key];
        target[key] = d.value;
      }
    }
  };

  const variablesIn = (value: string): string[] => [...value.matchAll(/var\(\s*(--[-\w]+)/g)].map((m) => m[1]);

  /** The defaults a set of declarations reads, however deep, that it does not set itself. */
  const fillDefaults = (style: StyleMap, read: Iterable<string>): void => {
    const queue = [...read];
    const seen = new Set<string>();
    const added: StyleMap = {};
    while (queue.length > 0) {
      const name = queue.pop() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const value = style[name] ?? defaults.get(name);
      if (value === undefined) continue;
      if (style[name] === undefined) added[name] = value;
      queue.push(...variablesIn(value));
    }
    Object.assign(style, { ...added, ...style });
  };

  const usedKeyframes = new Set<string>();
  const markerClasses = new Set<string>();
  let nextId = 0;

  const readStyleAttribute = (el: Element): StyleMap => {
    const out: StyleMap = {};
    for (const d of readDeclarations(el.getAttribute('style') ?? '')) out[camel(d.name)] = d.value;
    return out;
  };

  const liftStyles = (el: Element): { style: StyleMap; rules: LiftedRule[] } => {
    const matched = [...(matchedBy.get(el) ?? [])].sort(byCascade);
    const plain = matched.filter((p) => p.at.length === 0 && !p.pseudoElement && p.states.length === 0 && !p.context);
    const style: StyleMap = {};
    applyDeclarations(style, plain, false);
    applyDeclarations(style, plain, true);

    const inline = readStyleAttribute(el);
    for (const key of Object.keys(inline)) delete style[key];
    Object.assign(style, inline);

    const rules: LiftedRule[] = [];
    const rest = matched.filter((p) => !plain.includes(p));
    for (const part of rest) {
      if (part.pseudoElement && /^::(?:before|after)$/.test(part.pseudoElement) && part.declarations.every((d) => isDefaultVariable(part, d))) continue;
      const body: StyleMap = {};
      applyDeclarations(body, [part], false);
      applyDeclarations(body, [part], true);
      for (const key of Object.keys(inline)) if (!part.pseudoElement) delete body[key];
      if (Object.keys(body).length === 0) continue;
      const selector = `&${part.states.join('')}${part.context ? `:is(${part.context})` : ''}${part.pseudoElement}`;
      if (part.context) {
        for (const name of part.context.matchAll(/\.((?:[-\w]|\\.)+)/g)) markerClasses.add(name[1].replace(/\\/g, ''));
      }
      const last = rules[rules.length - 1];
      if (last && last.selector === selector && JSON.stringify(last.at ?? []) === JSON.stringify(part.at)) {
        Object.assign(last.style as StyleMap, body);
      } else {
        rules.push({ id: `r${rules.length}`, selector, ...(part.at.length > 0 ? { at: part.at } : {}), style: body });
      }
    }

    // Variables a value reads come from the reset wherever the value sits. Inside a
    // pseudo-element the reset applies again, so the rule carries its own.
    const onNode = new Set<string>(Object.values(style).flatMap(variablesIn));
    for (const rule of rules) {
      const values = Object.values(rule.style as StyleMap).flatMap(variablesIn);
      if (rule.selector?.includes('::')) fillDefaults(rule.style as StyleMap, values);
      else for (const name of values) onNode.add(name);
    }
    fillDefaults(style, onNode);

    for (const map of [style, ...rules.map((r) => r.style as StyleMap)]) {
      const names = `${map.animation ?? ''} ${map.animationName ?? ''}`;
      for (const name of keyframes.keys()) if (new RegExp(`(?:^|[\\s,])${name}(?:$|[\\s,])`).test(names)) usedKeyframes.add(name);
    }
    return { style, rules };
  };

  const liftAttributes = (el: Element): Record<string, unknown> => {
    const props: Record<string, unknown> = {};
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      if (name === 'class' || name === 'style' || name === 'xmlns') continue;
      if (name.startsWith('data-') || name.startsWith('aria-')) props[name] = attr.value;
      else if (['hidden', 'disabled', 'required', 'readonly', 'multiple', 'muted', 'loop', 'open', 'selected', 'checked', 'controls', 'playsinline', 'autoplay'].includes(name)) {
        props[input.attributeNames[name] ?? name] = true;
      } else if (el.namespaceURI === 'http://www.w3.org/2000/svg' && name.includes('-')) {
        props[name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = attr.value;
      } else props[input.attributeNames[name] ?? name] = attr.value;
    }
    return props;
  };

  const liftElement = (el: Element, root = false): LiftedNode => {
    const { style, rules } = liftStyles(el);
    const props = liftAttributes(el);
    if (Object.keys(style).length > 0) props.style = style;
    if (rules.length > 0) props.rules = rules;
    (el as unknown as { __lifted: Record<string, unknown> }).__lifted = props;

    const kinds = Array.from(el.childNodes).filter((c) => c.nodeType === Node.ELEMENT_NODE || (c.nodeType === Node.TEXT_NODE && c.nodeValue !== ''));
    const elements = kinds.filter((c) => c.nodeType === Node.ELEMENT_NODE);
    const node: LiftedNode = { id: `n${++nextId}`, type: root ? 'div' : el.localName, props };
    if (kinds.length === 1 && elements.length === 0) {
      props.children = kinds[0].nodeValue;
    } else if (kinds.length > 0) {
      node.children = kinds.map((child) =>
        child.nodeType === Node.ELEMENT_NODE
          ? liftElement(child as Element)
          : { id: `n${++nextId}`, type: '#text', props: { children: child.nodeValue } },
      );
    }
    return node;
  };

  const root = liftElement(document.body, true);

  // The route owns html and body: the root node is the nearest thing an author has.
  const htmlMatched = [...(matchedBy.get(document.documentElement) ?? [])].sort(byCascade).filter((p) => p.at.length === 0 && !p.pseudoElement && p.states.length === 0);
  const fromHtml: StyleMap = {};
  applyDeclarations(fromHtml, htmlMatched, false);
  const htmlStyle: StyleMap = {};
  for (const [key, value] of Object.entries(fromHtml)) {
    if (key.startsWith('--') || INHERITED.has(key)) {
      htmlStyle[key] = value;
      report.rootTook.push(key);
    } else report.rootLeft.push(key);
  }
  // `body { line-height: inherit }` reads html, and the root node has no html to read.
  const bodyStyle = Object.fromEntries(Object.entries((root.props.style ?? {}) as StyleMap).filter(([, value]) => value !== 'inherit'));
  // A div isolates its text direction and a body does not: the stand-in restates body.
  root.props.style = { unicodeBidi: 'normal', ...htmlStyle, ...bodyStyle };
  if (document.documentElement.lang) root.props.lang = document.documentElement.lang;

  // A class no rule reads is dead weight on a node, but `.group` in `:is(.group:hover *)` is read.
  const stamp = (el: Element): void => {
    const props = (el as unknown as { __lifted?: Record<string, unknown> }).__lifted;
    if (props) {
      const kept = Array.from(el.classList).filter((name) => markerClasses.has(name));
      if (kept.length > 0) props.className = kept.join(' ');
    }
    Array.from(el.children).forEach(stamp);
  };
  stamp(document.body);

  if (usedKeyframes.size > 0) {
    const rules = (root.props.rules ?? []) as LiftedRule[];
    root.props.rules = [...rules, ...[...usedKeyframes].map((name) => keyframes.get(name) as LiftedRule)];
  }
  return { root, report };
}

export const LIFT_INPUT = { attributeNames: ATTRIBUTE_NAMES };
