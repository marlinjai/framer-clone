// HTML void elements cannot host children. The drop resolver refuses `inside`
// zones on them; ComponentRenderer has its own render-time guard so React
// doesn't receive children for a void tag.
//
// Kept as a tiny standalone module so the resolver and the renderer can share
// one list without the resolver pulling the whole ComponentRenderer file.

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export function isVoidTag(type: string): boolean {
  return VOID_ELEMENTS.has(type.toLowerCase());
}
