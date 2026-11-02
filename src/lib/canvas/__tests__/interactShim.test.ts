// A canvas frame in the Interact tool: ids, links and forms (src/lib/canvas/interactShim.ts).
// The real input runs in test/behaviour/canvasInteract.spec.ts, in Chromium and WebKit. Here
// each branch, including what a browser test cannot reach cheaply: an unreadable address, a
// page that prevented the default itself, and an address that is not on the web.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageContentOf, startInteractFrame, wheelScrollsPage } from '../interactShim';

let frames: HTMLElement[];
let stops: (() => void)[];
const hooks = { sitePath: vi.fn(), refused: vi.fn() };

/** Two frames with the same page in them, as the canvas draws them. */
function frame(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-viewport-content-id', `v${frames.length}`);
  el.innerHTML = `
    <label for="agree">Agree</label><input id="agree" type="checkbox">
    <label for="name">Name</label><input id="name" type="text">
    <a id="about" href="/about">About</a><a id="away" href="https://away.test/x">Away</a>
    <a id="jump" href="#top">Jump</a><a id="mail" href="mailto:hi@example.test">Mail</a>
    <a id="broken" href="https://[bad">Broken</a>
    <form id="form"><button id="send" type="submit">Send</button></form>
    <div id="scroller"><p id="inner">Inner</p></div>`;
  document.body.appendChild(el);
  frames.push(el);
  stops.push(startInteractFrame(el, hooks));
  return el;
}

const click = (el: Element): MouseEvent => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  frames = [];
  stops = [];
  hooks.sitePath.mockReset();
  hooks.refused.mockReset();
  frame();
  frame();
});

afterEach(() => {
  stops.forEach((stop) => stop());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// By walking, not `#id`: jsdom's selector engine loses an id lookup in a tree where the same id repeats.
const inSecond = (id: string) => Array.from(frames[1].querySelectorAll('[id]')).find((el) => el.id === id) as HTMLElement;

describe('ids across frames', () => {
  it('a label in the second frame presses the checkbox of its own frame', () => {
    const event = click(frames[1].querySelector('label[for="agree"]')!);
    expect(event.defaultPrevented).toBe(true);
    expect((inSecond('agree') as HTMLInputElement).checked).toBe(true);
    expect((frames[0].querySelector('#agree') as HTMLInputElement).checked).toBe(false);
  });

  it('a label for a text field focuses the field of its own frame and presses nothing', () => {
    click(frames[1].querySelector('label[for="name"]')!);
    expect(document.activeElement).toBe(inSecond('name'));
  });

  it('leaves the first frame to the browser, which already finds its own control', () => {
    const event = click(frames[0].querySelector('label[for="agree"]')!);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('links', () => {
  it('a site path switches the editor to that page and never navigates it', () => {
    const event = click(inSecond('about'));
    expect(event.defaultPrevented).toBe(true);
    expect(hooks.sitePath).toHaveBeenCalledWith('/about');
  });

  it('an outside address opens a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const event = click(inSecond('away'));
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://away.test/x', '_blank', 'noopener,noreferrer');
  });

  it('an anchor and an address that is not on the web keep their default', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(click(inSecond('jump')).defaultPrevented).toBe(false);
    expect(click(inSecond('mail')).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(hooks.sitePath).not.toHaveBeenCalled();
  });

  it('an address the browser cannot read goes nowhere, and says so', () => {
    const event = click(inSecond('broken'));
    expect(event.defaultPrevented).toBe(true);
    expect(hooks.refused).toHaveBeenCalledWith(expect.stringContaining('cannot read'));
  });

  it('leaves a link alone when the page prevented its default, as a stored trigger may', () => {
    const link = inSecond('about');
    link.addEventListener('click', (event) => event.preventDefault(), true);
    click(link);
    expect(hooks.sitePath).not.toHaveBeenCalled();
  });
});

describe('forms', () => {
  it('a submit is prevented, and the editor says why', () => {
    const event = new SubmitEvent('submit', { bubbles: true, cancelable: true });
    inSecond('form').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(hooks.refused).toHaveBeenCalledWith(expect.stringContaining('does not send'));
  });

  it('stops listening when stopped', () => {
    stops.forEach((stop) => stop());
    stops = [];
    expect(click(inSecond('about')).defaultPrevented).toBe(false);
    expect(hooks.sitePath).not.toHaveBeenCalled();
  });
});

describe('the wheel over a page', () => {
  const sized = (el: HTMLElement, box: { scrollHeight: number; clientHeight: number; scrollTop: number }) => {
    for (const [name, value] of Object.entries(box)) Object.defineProperty(el, name, { configurable: true, value });
  };

  it('scrolls a scroller in the page that can still move that way', () => {
    const scroller = inSecond('scroller');
    scroller.style.overflowY = 'auto';
    sized(scroller, { scrollHeight: 300, clientHeight: 100, scrollTop: 0 });
    expect(wheelScrollsPage(inSecond('inner'), 0, 40)).toBe(true);
    expect(wheelScrollsPage(inSecond('inner'), 0, -40)).toBe(false);
    sized(scroller, { scrollHeight: 300, clientHeight: 100, scrollTop: 200 });
    expect(wheelScrollsPage(inSecond('inner'), 0, 40)).toBe(false);
  });

  it('pans over what does not scroll, and outside every frame', () => {
    expect(wheelScrollsPage(inSecond('inner'), 0, 40)).toBe(false);
    expect(wheelScrollsPage(document.body, 0, 40)).toBe(false);
    expect(pageContentOf(document.body)).toBeNull();
    expect(pageContentOf(inSecond('inner'))).toBe(frames[1]);
  });
});
