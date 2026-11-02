// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindSpacePan, isActivatableControl, spaceBelongsToTarget } from '../spacePan';

function makeUI() {
  const ui = {
    previewOpen: false,
    toolBeforeTemporaryGrab: undefined as string | undefined,
    tool: 'select',
    beginTemporaryGrab() {
      if (ui.toolBeforeTemporaryGrab !== undefined) return;
      ui.toolBeforeTemporaryGrab = ui.tool;
      ui.tool = 'grab';
    },
    endTemporaryGrab() {
      if (ui.toolBeforeTemporaryGrab === undefined) return;
      ui.tool = ui.toolBeforeTemporaryGrab;
      ui.toolBeforeTemporaryGrab = undefined;
    },
  };
  return ui;
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

// Dispatches on the element the way a browser does for a focused element:
// the event bubbles to the window listener with the element as target.
function key(target: EventTarget, type: 'keydown' | 'keyup', init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe('spaceBelongsToTarget', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('leaves the body, the canvas and plain panel text to the pan', () => {
    const host = mount('<div data-ground="true"><div id="layer">Hi</div></div><p id="text">Panel</p>');
    expect(spaceBelongsToTarget(document.body)).toBe(false);
    expect(spaceBelongsToTarget(host.querySelector('[data-ground]'))).toBe(false);
    expect(spaceBelongsToTarget(host.querySelector('#layer'))).toBe(false);
    expect(spaceBelongsToTarget(host.querySelector('#text'))).toBe(false);
    expect(spaceBelongsToTarget(null)).toBe(false);
    expect(spaceBelongsToTarget(window)).toBe(false);
  });

  it.each([
    ['a button', '<button id="t">Go</button>'],
    ['an icon inside a button', '<button><svg id="t"></svg></button>'],
    ['a link', '<a id="t" href="/x">Go</a>'],
    ['a summary', '<details><summary id="t">More</summary></details>'],
    ['an input', '<input id="t" />'],
    ['a select', '<select id="t"><option>a</option></select>'],
    ['a textarea', '<textarea id="t"></textarea>'],
    ['a contenteditable', '<div id="t" contenteditable="true">x</div>'],
    ['a checkbox role', '<div id="t" role="checkbox" tabindex="0"></div>'],
    ['a switch role', '<button id="t" role="switch" aria-checked="false"></button>'],
    ['a radio role', '<div id="t" role="radio" tabindex="0"></div>'],
    ['a menu item', '<div id="t" role="menuitem" tabindex="-1">Copy</div>'],
    ['a menu item checkbox', '<div id="t" role="menuitemcheckbox" tabindex="-1">Show</div>'],
    ['an option', '<div id="t" role="option" tabindex="-1">One</div>'],
    ['a tab', '<div id="t" role="tab" tabindex="0">One</div>'],
    ['plain text inside a dialog', '<div role="dialog"><p id="t">Sure?</p></div>'],
    ['plain text inside an alert dialog', '<div role="alertdialog"><p id="t">Sure?</p></div>'],
    ['plain text inside a modal', '<div aria-modal="true"><p id="t">Sure?</p></div>'],
    ['a native dialog', '<dialog open><p id="t">Sure?</p></dialog>'],
    ['an open menu', '<div role="menu" tabindex="-1" id="t"></div>'],
    ['a listbox', '<div role="listbox" tabindex="0" id="t"></div>'],
  ])('keeps Space for %s', (_label, html) => {
    const host = mount(html);
    expect(spaceBelongsToTarget(host.querySelector('#t'))).toBe(true);
  });

  it('pans over a button or link of the site drawn on the canvas, but keeps text editing there', () => {
    const host = mount('<div data-ground="true"><button id="b">Buy</button><a id="a" href="/x">Go</a><p id="p" contenteditable="true">Edit</p></div>');
    expect(spaceBelongsToTarget(host.querySelector('#b'))).toBe(false);
    expect(spaceBelongsToTarget(host.querySelector('#a'))).toBe(false);
    expect(spaceBelongsToTarget(host.querySelector('#p'))).toBe(true);
  });

  it('isActivatableControl matches controls outside the canvas only', () => {
    const host = mount('<button id="b">Go</button><div role="menuitem" id="m">Copy</div><div data-ground="true"><button id="c">Buy</button></div><p id="p">x</p>');
    expect(isActivatableControl(host.querySelector('#b'))).toBe(true);
    expect(isActivatableControl(host.querySelector('#m'))).toBe(true);
    expect(isActivatableControl(host.querySelector('#c'))).toBe(false);
    expect(isActivatableControl(host.querySelector('#p'))).toBe(false);
    expect(isActivatableControl(document.body)).toBe(false);
  });
});

describe('bindSpacePan', () => {
  let ui: ReturnType<typeof makeUI>;
  let unbind: () => void;
  let dragging = false;

  beforeEach(() => {
    ui = makeUI();
    dragging = false;
    unbind = bindSpacePan(ui, window, () => dragging);
  });
  afterEach(() => {
    unbind();
    document.body.innerHTML = '';
  });

  it('holding Space with nothing focused pans and releases on keyup', () => {
    const down = key(document.body, 'keydown');
    expect(down.defaultPrevented).toBe(true);
    expect(ui.tool).toBe('grab');
    key(document.body, 'keydown', { repeat: true });
    expect(ui.tool).toBe('grab');
    const up = key(document.body, 'keyup');
    expect(up.defaultPrevented).toBe(true);
    expect(ui.tool).toBe('select');
  });

  it('holding Space over the canvas pans', () => {
    const host = mount('<div data-ground="true"><div id="layer"></div></div>');
    key(host.querySelector('#layer')!, 'keydown');
    expect(ui.tool).toBe('grab');
    key(host.querySelector('#layer')!, 'keyup');
    expect(ui.tool).toBe('select');
  });

  it.each([
    ['a focused button', '<button id="t">Go</button>'],
    ['a focused switch', '<button id="t" role="switch" aria-checked="false"></button>'],
    ['a focused checkbox', '<input id="t" type="checkbox" />'],
    ['a menu item in an open menu', '<div role="menu"><div id="t" role="menuitem" tabindex="-1">Copy</div></div>'],
    ['a field inside a dialog', '<div role="dialog"><input id="t" /></div>'],
    ['text being edited', '<p id="t" contenteditable="true">Hi</p>'],
  ])('Space on %s is left to it, down and up', (_label, html) => {
    const host = mount(html);
    const target = host.querySelector('#t')!;
    const down = key(target, 'keydown');
    expect(down.defaultPrevented).toBe(false);
    expect(ui.tool).toBe('select');
    expect(ui.toolBeforeTemporaryGrab).toBeUndefined();
    const up = key(target, 'keyup');
    expect(up.defaultPrevented).toBe(false);
    expect(ui.tool).toBe('select');
  });

  it('a pan that began on the canvas still ends when focus moved to a button meanwhile', () => {
    const host = mount('<button id="b">Go</button>');
    key(document.body, 'keydown');
    expect(ui.tool).toBe('grab');
    const up = key(host.querySelector('#b')!, 'keyup');
    expect(up.defaultPrevented).toBe(true);
    expect(ui.tool).toBe('select');
  });

  it('does not pan in the preview, with a modifier, during a drag or when Space was already handled', () => {
    ui.previewOpen = true;
    expect(key(document.body, 'keydown').defaultPrevented).toBe(false);
    expect(ui.tool).toBe('select');
    ui.previewOpen = false;

    key(document.body, 'keydown', { metaKey: true });
    key(document.body, 'keydown', { ctrlKey: true });
    key(document.body, 'keydown', { altKey: true });
    expect(ui.tool).toBe('select');

    dragging = true;
    expect(key(document.body, 'keydown').defaultPrevented).toBe(true);
    expect(ui.tool).toBe('select');
    dragging = false;

    const handled = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(ui.tool).toBe('select');
  });

  it('losing window focus releases a held pan, and unbinding releases and detaches', () => {
    key(document.body, 'keydown');
    expect(ui.tool).toBe('grab');
    window.dispatchEvent(new Event('blur'));
    expect(ui.tool).toBe('select');

    key(document.body, 'keydown');
    unbind();
    expect(ui.tool).toBe('select');
    key(document.body, 'keydown');
    expect(ui.tool).toBe('select');
    unbind = () => {};
  });

  it('Space keyup without a pan does nothing', () => {
    const up = key(document.body, 'keyup');
    expect(up.defaultPrevented).toBe(false);
    expect(ui.tool).toBe('select');
  });
});
