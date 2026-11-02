// src/lib/ai/pageGen/promptSections/mapEmbed.ts
//
// The page generator's instructions for the Google Maps embed
// (src/lib/mapEmbed/mapEmbed.ts). Part of the cached system prefix, after the
// sticky call to action. Safe to teach because the model chooses only where a map
// goes and its title: the validator (../validate.ts, placeMapEmbeds) sets the
// address from the Site settings and drops a map when there is none, drops any
// embed address the model writes, and the published map loads only after the
// visitor consents.

export const MAP_EMBED_PROMPT = [
  '# Google map (location)',
  '',
  'When the page has a location or contact section and the request\'s site data holds a real address, you',
  'may show where the business is with one map: {"type":"div","preset":"mapEmbed","label":"Map",',
  '"props":{"mapTitle":"<Map: business name, in the page language>","style":{"width":"100%","height":"360px",',
  '"borderRadius":"<the page\'s card radius>"}}}. The platform fills in the address from the Site settings and',
  'loads the map only after the visitor consents; until then it shows the address and an "Open in Google',
  'Maps" link.',
  '- Never write mapUrl, mapAddress, an iframe or a link to Google Maps yourself.',
  '- No map without an address in the site data, at most one per page, no children.',
].join('\n');
