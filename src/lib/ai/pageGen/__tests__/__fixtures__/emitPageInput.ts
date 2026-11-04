// A tool input in the shape the model sends to emit_page, built to exercise the
// streaming section scanner (../../sectionStream.ts): "nodes" is not the first
// key, a string VALUE spells "nodes": with a colon, the copy holds escaped
// quotes, backslashes, braces and brackets, unicode escapes and real non-ASCII
// text (German umlauts, an emoji), and the sections nest a few levels deep.
// The pretty-printed variant puts whitespace and newlines between every token,
// as the model often does.

export const EMIT_PAGE_INPUT = {
  title: 'Bäckerei "Zum Korn" {home}',
  description: 'A string that says "nodes": [ { not a section } ] and \\ ends here',
  nodes: [
    {
      type: 'section',
      label: 'Hero',
      props: { style: { padding: { base: '96px 24px', mobile: '48px 16px' }, display: 'flex', flexDirection: 'column', gap: '24px' } },
      children: [
        { type: 'h1', props: { children: 'Frisches Brot, jeden Morgen um 6 Uhr' } },
        { type: 'p', props: { children: 'Say "hello" to {sourdough} and [rye], a backslash \\ and a tab\there.' } },
        { type: 'a', preset: 'button', props: { children: 'Jetzt bestellen', href: '/bestellen' } },
      ],
    },
    {
      type: 'section',
      label: 'Signature breads',
      props: { style: { display: 'grid', gridTemplateColumns: { base: 'repeat(3, 1fr)', mobile: '1fr' }, gap: '32px' } },
      children: [
        {
          type: 'div',
          label: 'Card',
          children: [
            { type: 'img', imageQuery: 'rustic sourdough loaf on a wooden board', props: { alt: 'Sourdough loaf' } },
            { type: 'h3', props: { children: 'Sauerteig \u{1F35E}' } },
            { type: 'p', props: { children: 'Closing brace } and bracket ] inside text, then "}" quoted.' } },
          ],
        },
        {
          type: 'div',
          label: 'Card',
          children: [
            { type: 'img', imageQuery: 'dark rye bread sliced', props: { alt: 'Rye bread' } },
            { type: 'h3', props: { children: 'Roggen' } },
          ],
        },
      ],
    },
    {
      type: 'section',
      label: 'Story',
      props: { style: { padding: '64px 24px' } },
      children: [{ type: 'p', props: { children: 'Seit 1952 → drei Generationen. Über uns: "Familie".' } }],
    },
    {
      type: 'footer',
      label: 'Footer',
      props: { style: { padding: '32px 24px', backgroundColor: '#1f1a17', color: '#f5efe6' } },
      children: [{ type: 'p', props: { children: 'Hauptstraße 1, 10115 Berlin' } }],
    },
  ],
};

/** Compact, as JSON.stringify writes it (escapes as the model would send them). */
export const EMIT_PAGE_INPUT_TEXT = JSON.stringify(EMIT_PAGE_INPUT);

/** Pretty-printed, and with the unicode written as \u escapes the way some models emit them. */
export const EMIT_PAGE_INPUT_PRETTY = JSON.stringify(EMIT_PAGE_INPUT, null, 2).replace(
  /[\u0080-￿]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
);
