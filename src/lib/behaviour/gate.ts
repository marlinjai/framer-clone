// src/lib/behaviour/gate.ts
//
// The gate of a page with a trigger. See docs/plans/2026-11-02-behaviour-model.md,
// "The gate and no-JavaScript". A rule that hides by state applies only while
// `data-fc-b` stands on `html`, and this inline script is what sets it, ahead of the
// content, so without JavaScript nothing is hidden and the initial state shows with
// no flash when there is.
//
// It does not stop at reduced motion, as the effects boot script does: this gate is
// about state, not motion. The rest is what the runtime needs from before it arrived:
//
//   window.__fcB.queue    the first click and the first keydown on a `[data-fc-n]`,
//                         for the runtime to replay, for state verbs only
//   window.__fcB.ready()  the runtime started. True when it may go on: false when the
//                         gate already fell and the visitor has scrolled or typed, so
//                         panels never collapse under a reader
//   window.__fcB.fail()   the runtime broke: the gate comes down for this visit
//
// The stored page can hold what breaks a plain call: `<img name="removeEventListener">`
// shadows that method on `document`, and a field named `closest` on its form. So every
// method used after the content arrives is taken from its prototype first, `fail` lowers
// the gate before anything else, and a keydown in a field is not kept: it may be the first
// character someone typed.
//
// Only constants go into the script. PURE and client-safe: no React, no MST.

import { START_STATE_TIMEOUT_MS } from '@/lib/effects/effects';
import { NODE_ATTR } from './behaviourDom';

/** Stands on `html` while state rules apply. */
export const GATE_ATTR = 'data-fc-b';
/** What the script leaves for the runtime. */
export const GATE_GLOBAL = '__fcB';

/** The inline script. `<` is escaped so the text can never close the script element. */
export function behaviourBootScript(): string {
  const FIELD = JSON.stringify('input,textarea,select,[contenteditable]');
  const gate = JSON.stringify(GATE_ATTR);
  const selector = JSON.stringify(`[${NODE_ATTR}]`);
  const body =
    '(function(){try{' +
    'var d=document,h=d.documentElement,q=[],seen={},fell=false,moved=false,started=false,dead=false,timer,' +
    'T=EventTarget.prototype,on=T.addEventListener,off=T.removeEventListener,near=Element.prototype.closest;' +
    'function hold(e){var t=e.target;' +
    'if(seen[e.type]||!t||t.nodeType!==1)return;' +
    `if(!near.call(t,${selector}))return;` +
    `if(e.type==="keydown"&&near.call(t,${FIELD}))return;` +
    'seen[e.type]=true;q.push(e)}' +
    'function move(){moved=true;drop(move,"scroll");drop(move,"keydown")}' +
    'function drop(f,n){off.call(d,n,f,true)}' +
    'function stop(){clearTimeout(timer);try{drop(hold,"click");drop(hold,"keydown")}catch(e){}}' +
    `window.${GATE_GLOBAL}={queue:q,` +
    'ready:function(){started=true;stop();if(dead||(fell&&moved))return false;' +
    `h.setAttribute(${gate},"");return true},` +
    `fail:function(){h.removeAttribute(${gate});dead=true;stop()}};` +
    'on.call(d,"click",hold,true);on.call(d,"keydown",hold,true);' +
    `h.setAttribute(${gate},"");` +
    'timer=setTimeout(function(){if(started)return;fell=true;' +
    `h.removeAttribute(${gate});` +
    'console.error("Page behaviour did not start: showing everything.");' +
    'on.call(d,"scroll",move,true);on.call(d,"keydown",move,true)' +
    `},${START_STATE_TIMEOUT_MS})` +
    '}catch(e){}})();';
  return body.replace(/</g, '\\u003c');
}
