// One proof per event: a stored tree holding a stored action on that event, and the real
// cause, a person's gesture, a real file or a real navigation. Nothing here dispatches an
// event, and `events.score.ts` fails if anything does, because a row asks whether a stored
// action runs from a real cause. Every action is the same `set`, so what differs is only
// what made the browser fire the event.
// See docs/plans/2026-11-02-behaviour-model.md, "The 100 event handler rows".

import type { Page } from 'playwright';

export interface StoredProofNode {
  id: string;
  type: string;
  componentType: 'host';
  props: Record<string, unknown>;
  children: StoredProofNode[];
}

/** What a cause can reach. */
export interface ProofContext {
  page: Page;
}

export interface EventProof {
  /** The stored page, holding `on` wherever the event fires. */
  tree: (on: Behaviour) => StoredProofNode[];
  cause: (context: ProofContext) => Promise<void>;
  /** Rendered, but not a press target: page state the proof's own controls read. */
  state?: { id: string; name: string; type: 'boolean'; initial: boolean }[];
}

type Behaviour = Record<string, unknown>;

export const n = (id: string, type: string, props: Record<string, unknown> = {}, ...children: StoredProofNode[]): StoredProofNode => ({
  id,
  type,
  componentType: 'host',
  props: { 'data-t': id, ...props },
  children,
});

const at = (page: Page, id: string) => page.locator(`[data-t="${id}"]`).first();
const SIZE = { width: '200px', height: '80px' };
const flag = (id: string) => ({ id, name: id, type: 'boolean' as const, initial: false });

const centre = async (page: Page, id: string): Promise<{ x: number; y: number }> => {
  const box = await at(page, id).boundingBox();
  if (!box) throw new Error(`${id} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const pressAt = (id: string, ...actions: unknown[]): StoredProofNode =>
  n(id, 'button', { type: 'button', children: id, behaviour: { noScript: 'show', on: [{ id: 'c', on: 'click', do: actions }] } });

// ---- pointer and mouse ------------------------------------------------------------------

const box = (on: Behaviour, extra: Record<string, unknown> = {}): StoredProofNode[] => [
  n('box', 'div', { children: 'Box', style: SIZE, behaviour: on, ...extra }),
  n('away', 'div', { children: 'Away', style: SIZE }),
];

const onBox = (cause: (page: Page) => Promise<void>): EventProof => ({ tree: (on) => box(on), cause: ({ page }) => cause(page) });
const clicked = (button: 'left' | 'middle' | 'right') => onBox((page) => at(page, 'box').click({ button }));
const pressedAndHeld = onBox(async (page) => {
  await at(page, 'box').hover();
  await page.mouse.down();
  await page.mouse.up();
});
const movedThrough = onBox(async (page) => {
  await at(page, 'box').hover();
  await at(page, 'away').hover();
});
const movedOver = onBox(async (page) => {
  const { x, y } = await centre(page, 'box');
  await page.mouse.move(x, y);
  await page.mouse.move(x + 5, y + 5, { steps: 3 });
});

/** A drag from one box to another with real mouse input. */
const dragged = async (page: Page): Promise<void> => {
  const from = await centre(page, 'source');
  const to = await centre(page, 'zone');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.waitForTimeout(100);
  await page.mouse.move(to.x + 3, to.y + 3, { steps: 2 });
  await page.waitForTimeout(100);
};

const dropTree = (place: 'source' | 'zone') => (on: Behaviour): StoredProofNode[] => [
  n('source', 'div', { children: 'Drag me', draggable: 'true', style: SIZE, ...(place === 'source' ? { behaviour: on } : {}) }),
  n('zone', 'div', {
    children: 'Zone',
    style: SIZE,
    // What makes an element a drop target, in any page.
    behaviour: place === 'zone'
      ? { ...on, on: [...(on.on as unknown[]), { id: 'over', on: 'dragover', prevent: true, do: [{ set: 'seen', value: true }] }] }
      : { on: [{ id: 'over', on: 'dragover', prevent: true, do: [{ set: 'seen', value: true }] }] },
  }),
];

const dragging = (place: 'source' | 'zone', finish = false): EventProof => ({
  state: [flag('seen')],
  tree: dropTree(place),
  cause: async ({ page }) => {
    await dragged(page);
    if (finish) await page.mouse.up();
  },
});

const POINTER: Record<string, EventProof> = {
  auxclick: clicked('middle'),
  click: clicked('left'),
  contextmenu: clicked('right'),
  dblclick: onBox((page) => at(page, 'box').dblclick()),
  mousedown: pressedAndHeld,
  mouseup: pressedAndHeld,
  pointerdown: pressedAndHeld,
  pointerup: pressedAndHeld,
  mouseenter: movedThrough,
  mouseleave: movedThrough,
  mouseout: movedThrough,
  mouseover: movedThrough,
  pointerenter: movedThrough,
  pointerleave: movedThrough,
  pointerout: movedThrough,
  pointerover: movedThrough,
  mousemove: movedOver,
  pointermove: movedOver,
  wheel: onBox(async (page) => {
    await at(page, 'box').hover();
    await page.mouse.wheel(0, 40);
  }),
  // A native drag taking over a press is what cancels a pointer.
  pointercancel: {
    state: [flag('seen')],
    tree: (on) => [n('source', 'div', { children: 'Drag me', draggable: 'true', style: SIZE, behaviour: on }), n('zone', 'div', { children: 'Zone', style: SIZE })],
    cause: ({ page }) => dragged(page),
  },
  gotpointercapture: {
    tree: (on) => box({ on: [...(on.on as unknown[]), { id: 'grab', on: 'pointerdown', do: [{ capturePointer: true }] }] }),
    cause: ({ page }) => pressedAndHeld.cause({ page }),
  },
  lostpointercapture: {
    tree: (on) => box({ on: [...(on.on as unknown[]), { id: 'grab', on: 'pointerdown', do: [{ capturePointer: true }] }] }),
    cause: ({ page }) => pressedAndHeld.cause({ page }),
  },
};

// ---- keyboard, focus and editing --------------------------------------------------------

const button = (on: Behaviour) => [n('key', 'button', { type: 'button', children: 'Key', behaviour: { noScript: 'show', ...on } }), n('next', 'button', { type: 'button', children: 'Next' })];
const field = (on: Behaviour, extra: Record<string, unknown> = {}) => [
  n('field', 'input', { type: 'text', 'aria-label': 'Field', defaultValue: 'words', behaviour: on, ...extra }),
  n('next', 'button', { type: 'button', children: 'Next' }),
];

const keyOn = (page: Page) => at(page, 'key').focus().then(() => page.keyboard.press('b'));
const typed = async ({ page }: ProofContext): Promise<void> => {
  await at(page, 'field').click();
  await page.keyboard.press('End');
  await page.keyboard.type('s');
};
const selected = async (page: Page): Promise<void> => {
  await at(page, 'field').click();
  await page.keyboard.press('ControlOrMeta+a');
};

const KEYBOARD: Record<string, EventProof> = {
  keydown: { tree: button, cause: ({ page }) => keyOn(page) },
  keyup: { tree: button, cause: ({ page }) => keyOn(page) },
  focus: { tree: field, cause: ({ page }) => at(page, 'field').click() },
  blur: {
    tree: field,
    cause: async ({ page }) => {
      await at(page, 'field').click();
      await at(page, 'next').click();
    },
  },
  input: { tree: field, cause: typed },
  beforeinput: { tree: field, cause: typed },
  change: {
    tree: field,
    cause: async (context) => {
      await typed(context);
      await at(context.page, 'next').click();
    },
  },
  select: { tree: field, cause: ({ page }) => selected(page) },
  selectionchange: {
    tree: (on) => [n('words', 'p', { children: 'Words to select', behaviour: on })],
    cause: ({ page }) => at(page, 'words').dblclick(),
  },
  copy: {
    tree: field,
    cause: async ({ page }) => {
      await selected(page);
      await page.keyboard.press('ControlOrMeta+c');
    },
  },
  cut: {
    tree: field,
    cause: async ({ page }) => {
      await selected(page);
      await page.keyboard.press('ControlOrMeta+x');
    },
  },
  paste: {
    tree: field,
    cause: async ({ page }) => {
      await selected(page);
      await page.keyboard.press('ControlOrMeta+x');
      await page.keyboard.press('ControlOrMeta+v');
    },
  },
};

// ---- forms ------------------------------------------------------------------------------

const form = (on: Behaviour, extra: Record<string, unknown>, ...children: StoredProofNode[]) => [
  n('sheet', 'form', { action: '/sink', behaviour: on, ...extra }, ...children),
];
const pressSend = ({ page }: ProofContext) => at(page, 'send').click();
const send = n('send', 'button', { type: 'submit', children: 'Send' });

const FORMS: Record<string, EventProof> = {
  submit: { tree: (on) => form({ on: (on.on as object[]).map((trigger) => ({ ...trigger, prevent: true })) }, {}, send), cause: pressSend },
  // A new tab takes the submission, so this page is there to see what fired.
  formdata: { tree: (on) => form(on, { target: '_blank' }, send), cause: pressSend },
  reset: { tree: (on) => form(on, {}, n('clear', 'button', { type: 'reset', children: 'Clear' })), cause: ({ page }) => at(page, 'clear').click() },
  invalid: {
    tree: (on) => form({}, {}, n('need', 'input', { type: 'text', required: true, 'aria-label': 'Needed', behaviour: on }), send),
    cause: pressSend,
  },
};

// ---- open and close ---------------------------------------------------------------------

const popoverTree = (on: Behaviour) => [
  n('opener', 'button', { type: 'button', popoverTarget: 'pop', children: 'Open' }),
  n('pop', 'div', { id: 'pop', popover: 'auto', children: 'Popover', behaviour: on }),
];
const dialogTree = (on: Behaviour) => [
  n('opener', 'button', { type: 'button', commandfor: 'held', command: 'show-modal', children: 'Open' }),
  n('held', 'dialog', { id: 'held', behaviour: on }, n('inside', 'p', { children: 'Inside' })),
];
const opened = ({ page }: ProofContext) => at(page, 'opener').click();
const openedAndEscaped = async ({ page }: ProofContext) => {
  await at(page, 'opener').click();
  await page.keyboard.press('Escape');
};

const OPEN_CLOSE: Record<string, EventProof> = {
  toggle: { tree: popoverTree, cause: opened },
  beforetoggle: { tree: popoverTree, cause: opened },
  cancel: { tree: dialogTree, cause: openedAndEscaped },
  close: { tree: dialogTree, cause: openedAndEscaped },
  command: { tree: dialogTree, cause: opened },
};

// ---- drag -------------------------------------------------------------------------------

const DRAG: Record<string, EventProof> = {
  dragstart: dragging('source'),
  drag: dragging('source'),
  dragend: dragging('source', true),
  dragenter: dragging('zone'),
  dragover: {
    tree: (on) => [n('source', 'div', { children: 'Drag me', draggable: 'true', style: SIZE }), n('zone', 'div', { children: 'Zone', style: SIZE, behaviour: on })],
    cause: ({ page }) => dragged(page),
  },
  dragleave: {
    state: [flag('seen')],
    tree: (on) => [...dropTree('zone')(on), n('further', 'div', { children: 'Further', style: SIZE })],
    cause: async ({ page }) => {
      await dragged(page);
      const { x, y } = await centre(page, 'further');
      await page.mouse.move(x, y, { steps: 6 });
    },
  },
  drop: dragging('zone', true),
};

// ---- motion, caused by state rules ------------------------------------------------------

const KEYFRAMES = { id: 'k', define: '@keyframes u-probe', blocks: [{ selector: 'from', style: { opacity: '0.2' } }, { selector: 'to', style: { opacity: '1' } }] };

const motionTree = (style: Record<string, unknown>) => (on: Behaviour): StoredProofNode[] => [
  pressAt('go', { toggle: 'go' }),
  n('mover', 'div', {
    children: 'Moves',
    style: { opacity: '1', ...SIZE },
    rules: [KEYFRAMES, { id: 'r', selector: '&', when: { state: 'go', eq: true }, style }],
    behaviour: on,
  }),
];

const animated = (style: Record<string, unknown>, twice = false): EventProof => ({
  state: [flag('go')],
  tree: motionTree(style),
  cause: async ({ page }) => {
    await at(page, 'go').click();
    if (twice) await at(page, 'go').click();
  },
});

const SHORT = { animation: 'u-probe 60ms linear 3' };
const LONG = { animation: 'u-probe 5s linear' };
const FADE = { opacity: '0.5', transition: 'opacity 60ms linear' };
const SLOW_FADE = { opacity: '0.5', transition: 'opacity 5s linear' };

const MOTION: Record<string, EventProof> = {
  animationstart: animated(SHORT),
  animationend: animated(SHORT),
  animationiteration: animated(SHORT),
  animationcancel: animated(LONG, true),
  transitionrun: animated(FADE),
  transitionstart: animated(FADE),
  transitionend: animated(FADE),
  transitioncancel: animated(SLOW_FADE, true),
};

// ---- scrolling and loading --------------------------------------------------------------

const scroller = (on: Behaviour, snap = false): StoredProofNode[] => [
  n('scroller', 'div', {
    style: { width: '300px', height: '150px', overflow: 'auto', ...(snap ? { scrollSnapType: 'y mandatory' } : {}) },
    behaviour: on,
  }, ...[0, 1, 2].map((index) => n(`slide-${index}`, 'div', { children: `Slide ${index}`, style: { height: '150px', ...(snap ? { scrollSnapAlign: 'start' } : {}) } }))),
];

const wheeled = async ({ page }: ProofContext): Promise<void> => {
  await at(page, 'scroller').hover();
  await page.mouse.wheel(0, 160);
};
const pageScrolled = async ({ page }: ProofContext): Promise<void> => {
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, 3000);
};

const belowTheFold = (node: StoredProofNode): StoredProofNode[] => [n('gap', 'div', { style: { height: '2500px' } }), node];

const SCROLL_AND_LOAD: Record<string, EventProof> = {
  scroll: { tree: (on) => scroller(on), cause: wheeled },
  scrollend: { tree: (on) => scroller(on), cause: wheeled },
  scrollsnapchange: { tree: (on) => scroller(on, true), cause: wheeled },
  scrollsnapchanging: { tree: (on) => scroller(on, true), cause: wheeled },
  contentvisibilityautostatechange: {
    tree: (on) => belowTheFold(n('later', 'div', { children: 'Later', style: { contentVisibility: 'auto', height: '100px' }, behaviour: on })),
    cause: pageScrolled,
  },
  // Lazy, so the file arrives after the runtime and a real scroll asks for it.
  load: { tree: (on) => belowTheFold(n('picture', 'img', { src: '/pixel.gif', alt: 'x', loading: 'lazy', width: 10, height: 10, behaviour: on })), cause: pageScrolled },
  error: { tree: (on) => belowTheFold(n('picture', 'img', { src: '/missing.gif', alt: 'x', loading: 'lazy', width: 10, height: 10, behaviour: on })), cause: pageScrolled },
};

// ---- media ------------------------------------------------------------------------------

const audioTree = (src = '/clip.wav') => (on: Behaviour): StoredProofNode[] => [
  n('clip', 'audio', { src, preload: 'none', controls: true, behaviour: on }),
  pressAt('play', { media: 'clip', op: 'play' }),
  pressAt('pause', { media: 'clip', op: 'pause' }),
  pressAt('load', { media: 'clip', op: 'load' }),
  pressAt('seek', { media: 'clip', op: 'seek', value: 0.2 }),
  pressAt('rate', { media: 'clip', op: 'rate', value: 2 }),
  pressAt('volume', { media: 'clip', op: 'volume', value: 0.5 }),
];

const pressing = (...ids: string[]): EventProof['cause'] => async ({ page }) => {
  for (const id of ids) await at(page, id).click();
};

const played: EventProof = { tree: audioTree(), cause: pressing('play') };

const inVideo = (on: Behaviour): StoredProofNode[] => [
  n('film', 'video', { src: '/clip.webm', preload: 'none', muted: true, behaviour: on }),
  pressAt('play', { media: 'film', op: 'play' }),
];

const MEDIA: Record<string, EventProof> = {
  loadstart: played,
  durationchange: played,
  loadedmetadata: played,
  loadeddata: played,
  canplay: played,
  canplaythrough: played,
  progress: played,
  play: played,
  playing: played,
  timeupdate: played,
  ended: played,
  pause: { tree: audioTree(), cause: pressing('play', 'pause') },
  seeking: { tree: audioTree(), cause: pressing('play', 'seek') },
  seeked: { tree: audioTree(), cause: pressing('play', 'seek') },
  ratechange: { tree: audioTree(), cause: pressing('rate') },
  volumechange: { tree: audioTree(), cause: pressing('volume') },
  // A second load empties what the first one loaded, and stops what it was fetching.
  emptied: {
    tree: audioTree(),
    cause: async (context) => {
      await pressing('play')(context);
      await context.page.waitForTimeout(150);
      await pressing('load')(context);
    },
  },
  abort: {
    tree: audioTree('/never.wav'),
    cause: async (context) => {
      await pressing('play')(context);
      await context.page.waitForTimeout(150);
      await pressing('load')(context);
    },
  },
  suspend: { tree: (on) => [n('clip', 'audio', { src: '/clip.wav', preload: 'metadata', behaviour: on }), pressAt('load', { media: 'clip', op: 'load' })], cause: pressing('load') },
  // A file that never arrives is the real cause of these two.
  stalled: { tree: audioTree('/never.wav'), cause: pressing('play') },
  waiting: { tree: audioTree('/never.wav'), cause: pressing('play') },
  resize: { tree: inVideo, cause: pressing('play') },
  cuechange: {
    tree: (on) => [
      n('clip', 'audio', { src: '/clip.wav', preload: 'none' }, n('cues', 'track', { src: '/cues.vtt', kind: 'metadata', default: true, behaviour: on })),
      pressAt('play', { media: 'clip', op: 'play' }),
    ],
    cause: pressing('play'),
  },
};

// ---- display ----------------------------------------------------------------------------

const DISPLAY: Record<string, EventProof> = {
  fullscreenchange: {
    tree: (on) => [n('pane', 'div', { children: 'Pane', style: SIZE, behaviour: on }), pressAt('full', { fullscreen: 'pane', op: 'enter' })],
    cause: pressing('full'),
  },
  // An open popover cannot go fullscreen, so a press asks and the browser refuses.
  fullscreenerror: {
    tree: (on) => [
      n('opener', 'button', { type: 'button', popoverTarget: 'pane', children: 'Open' }),
      n('pane', 'div', { id: 'pane', popover: 'manual', children: 'Pane', style: SIZE, behaviour: on }),
      pressAt('full', { fullscreen: 'pane', op: 'enter' }),
    ],
    cause: pressing('opener', 'full'),
  },
  enterpictureinpicture: {
    tree: (on) => [...inVideo(on), pressAt('small', { pictureInPicture: 'film', op: 'enter' })],
    cause: pressing('play', 'small'),
  },
  leavepictureinpicture: {
    tree: (on) => [...inVideo(on), pressAt('small', { pictureInPicture: 'film', op: 'enter' }), pressAt('big', { pictureInPicture: 'film', op: 'leave' })],
    cause: pressing('play', 'small', 'big'),
  },
};

export const EVENT_PROOFS: Readonly<Record<string, EventProof>> = {
  ...POINTER, ...KEYBOARD, ...FORMS, ...OPEN_CLOSE, ...DRAG, ...MOTION, ...SCROLL_AND_LOAD, ...MEDIA, ...DISPLAY,
};

/** What no proof here can close, and why. These stay red, with the reason in the cell. */
export const NOT_PROVEN: Readonly<Record<string, string>> = {
  beforexrselect: 'needs an immersive session and a device',
  beforematch: 'needs hidden="until-found", and React writes hidden as a boolean, so a stored page cannot hold it',
  encrypted: 'needs encrypted media and a key system, which the format has neither of',
  waitingforkey: 'needs encrypted media and a key system, which the format has neither of',
  slotchange: 'is not composed, so reaching it means walking open shadow roots in the runtime',
  securitypolicyviolation: 'its only cause is a custom code block trying to leave, which slice C5 proves',
  contextlost: 'needs a drawing context, which only custom code can make',
  contextrestored: 'needs a drawing context, which only custom code can make',
};
