// src/lib/ai/pageGen/svgAttributes.ts
//
// SVG attributes the format can only hold as styles. A node's `width` or
// `transform` prop is read as a style (CSS_PROP_SET), so these four would be lost
// as attributes, and a rect without a size or a group without its offset is a broken
// graphic. They move into `style` in the form CSS needs, and go through the same
// value checks as any other style.

/** Elements whose width and height are CSS geometry properties. On a mask or a pattern they are not. */
const SIZED_TAGS: ReadonlySet<string> = new Set(['svg', 'rect', 'image', 'foreignObject']);

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

const argumentsOf = (text: string): string[] => text.trim().split(/[\s,]+/).filter(Boolean);

function allNumbers(args: string[]): boolean {
  return args.length > 0 && args.every((arg) => NUMBER.test(arg));
}

/** One SVG transform function as CSS, where numbers carry units; undefined when it is not one. */
function cssTransformFunction(name: string, args: string[]): string | undefined {
  if (!allNumbers(args)) return undefined;
  const px = (n: string) => `${n}px`;
  const deg = (n: string) => `${n}deg`;
  if (name === 'translate' && args.length <= 2) return `translate(${args.map(px).join(', ')})`;
  if (name === 'scale' && args.length <= 2) return `scale(${args.join(', ')})`;
  if (name === 'rotate' && args.length === 1) return `rotate(${deg(args[0])})`;
  if (name === 'rotate' && args.length === 3) {
    // CSS has no pivot argument: move there, turn, move back.
    const [angle, x, y] = args;
    return `translate(${px(x)}, ${px(y)}) rotate(${deg(angle)}) translate(${px(`${-Number(x)}`)}, ${px(`${-Number(y)}`)})`;
  }
  if ((name === 'skewX' || name === 'skewY') && args.length === 1) return `${name}(${deg(args[0])})`;
  if (name === 'matrix' && args.length === 6) return `matrix(${args.join(', ')})`;
  return undefined;
}

/** An SVG transform list as a CSS transform value, or undefined when any part cannot be read. */
export function cssTransformFrom(text: string): string | undefined {
  const functions = [...text.matchAll(/([a-zA-Z]+)\s*\(([^()]*)\)/g)];
  const rest = text.replace(/[a-zA-Z]+\s*\([^()]*\)/g, '').replace(/[\s,]/g, '');
  if (functions.length === 0 || rest.length > 0) return undefined;
  const parts = functions.map(([, name, args]) => cssTransformFunction(name, argumentsOf(args)));
  return parts.every(Boolean) ? parts.join(' ') : undefined;
}

/**
 * The style one SVG attribute becomes, or undefined when it is not one of these.
 * A plain number stays a number, so it gets its px the way any style does.
 */
export function svgAttributeAsStyle(tag: string, key: string, value: unknown): { key: string; value: unknown } | undefined {
  const name = key.toLowerCase();
  const number = typeof value === 'string' && NUMBER.test(value.trim()) ? Number(value) : value;
  if ((name === 'width' || name === 'height') && SIZED_TAGS.has(tag)) return { key: name, value: number };
  if (name === 'opacity') return { key: name, value: number };
  if (name === 'transform' && tag !== 'svg' && typeof value === 'string') {
    const transform = cssTransformFrom(value);
    return transform === undefined ? undefined : { key: name, value: transform };
  }
  return undefined;
}
