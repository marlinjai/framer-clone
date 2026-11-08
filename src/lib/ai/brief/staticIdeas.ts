// src/lib/ai/brief/staticIdeas.ts
//
// The curated ideas the Generate dialog shows the moment it opens, before (or
// instead of, when the call fails) the ideas tailored to the site
// (./ideas.ts). Twelve page types; each also has a section version for
// "Replace selection" and "Add to selection". No AI behind them, so they cost
// nothing and never fail. They are written in English: the tailored set
// follows the site language.

import type { BriefTargetKind, PageIdea } from './schema';

interface StaticIdea {
  title: string;
  /** The brief for a new page. */
  page: string;
  /** The brief for one section (replace or insert), when the type works as one. */
  section?: string;
}

export const STATIC_IDEAS: readonly StaticIdea[] = [
  {
    title: 'Landing page',
    page: 'A landing page: a hero with a clear promise and one main call to action, three benefits, a short how-it-works in three steps, a closing call to action and a footer.',
    section: 'A hero section with a clear promise, one supporting sentence and one main call to action.',
  },
  {
    title: 'Pricing',
    page: 'A pricing page with three plans side by side (what each includes, the recommended one highlighted), a short comparison, frequently asked questions about billing and a call to action. Prices as placeholders.',
    section: 'A pricing section with three plans side by side, the recommended one highlighted, prices as placeholders.',
  },
  {
    title: 'About us',
    page: 'An about page: who we are and why we started, what we believe in as three short values, the team with photos and roles, and a call to get in touch.',
    section: 'An about section: a short story of who we are next to a photo, and three values.',
  },
  {
    title: 'Contact',
    page: 'A contact page with a short invitation, a contact form (name, email, message), the address, phone and opening hours from the site settings, and a footer.',
    section: 'A contact section with a short invitation, a contact form (name, email, message) and the contact details from the site settings.',
  },
  {
    title: 'Blog index',
    page: 'A blog overview: a heading with a one-line description, a featured article, a grid of recent articles with image, title, date and teaser, and a newsletter sign-up.',
    section: 'A section showing the three latest articles as cards with image, title, date and teaser.',
  },
  {
    title: 'Product launch',
    page: 'A product launch page: a bold hero with the product photo and a pre-order call to action, the three features that matter most, a short video or image gallery, and launch date details.',
    section: 'A product highlight section: a large product photo, three key features and one call to action.',
  },
  {
    title: 'Event',
    page: 'An event page: name, date and place in the hero with a register button, what to expect, the schedule, the speakers or hosts, and how to get there.',
    section: 'An event announcement section with the date, the place, a short description and a register button.',
  },
  {
    title: 'Portfolio',
    page: 'A portfolio page: a short introduction, a grid of selected projects with image, title and one line each, client logos, and a call to start a project together.',
    section: 'A portfolio section with a grid of six selected projects, each with an image, a title and one line.',
  },
  {
    title: 'Restaurant menu',
    page: 'A menu page for a restaurant: a warm hero, the menu grouped into starters, mains and desserts with short descriptions and prices as placeholders, opening hours and a reservation call to action.',
    section: 'A menu section grouped into starters, mains and desserts, each dish with a short description and a price placeholder.',
  },
  {
    title: 'Shop front',
    page: 'A shop front page: a hero with the current collection, featured products with image, name and price placeholder, the reasons to buy here (shipping, returns), and a newsletter sign-up.',
    section: 'A featured products section: four products with image, name, price placeholder and a shop button.',
  },
  {
    title: 'Careers',
    page: 'A careers page: why work here, the benefits, the open positions as a list with location and type, how the hiring process works, and a call to apply.',
    section: 'A careers section: why work here in two sentences, three benefits and a link to the open positions.',
  },
  {
    title: 'FAQ',
    page: 'A frequently asked questions page: the questions grouped by topic as expandable items, and a contact call to action for anything not answered.',
    section: 'A frequently asked questions section with six questions and short answers as expandable items.',
  },
];

/** Which page types come first for each target (the rest fill up to six). */
const ORDER: Record<BriefTargetKind, string[]> = {
  newPage: ['Landing page', 'About us', 'Pricing', 'Contact', 'Product launch', 'FAQ'],
  replace: ['Landing page', 'Pricing', 'Contact', 'FAQ', 'Portfolio', 'Shop front'],
  insert: ['FAQ', 'Pricing', 'Contact', 'Blog index', 'Event', 'Careers'],
};

/** Six static ideas for a target: page briefs for a new page, section briefs otherwise. */
export function pickStaticIdeas(kind: BriefTargetKind, count = 6): PageIdea[] {
  const first = ORDER[kind];
  const sorted = [
    ...first.map((t) => STATIC_IDEAS.find((i) => i.title === t)).filter((i): i is StaticIdea => !!i),
    ...STATIC_IDEAS.filter((i) => !first.includes(i.title)),
  ];
  return sorted
    .filter((i) => kind === 'newPage' || !!i.section)
    .slice(0, count)
    .map((i) => ({ title: i.title, brief: kind === 'newPage' ? i.page : (i.section as string) }));
}
