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
// Only constants go into the script. PURE and client-safe: no React, no MST.

import { START_STATE_TIMEOUT_MS } from '@/lib/effects/effects';
import { NODE_ATTR } from './behaviourDom';

/** Stands on `html` while state rules apply. */
export const GATE_ATTR = 'data-fc-b';
/** What the script leaves for the runtime. */
export const GATE_GLOBAL = '__fcB';

/** The inline script. `<` is escaped so the text can never close the script element. */
export function behaviourBootScript(): string {
  const gate = JSON.stringify(GATE_ATTR);
  const selector = JSON.stringify(`[${NODE_ATTR}]`);
  const body =
    '(function(){try{' +
    'var d=document,h=d.documentElement,q=[],seen={},fell=false,moved=false,started=false,dead=false,timer;' +
    'function hold(e){var t=e.target;' +
    `if(seen[e.type]||!t||!t.closest||!t.closest(${selector}))return;seen[e.type]=true;q.push(e)}` +
    'function move(){moved=true;drop(move,"scroll");drop(move,"keydown")}' +
    'function drop(f,n){d.removeEventListener(n,f,true)}' +
    'function stop(){clearTimeout(timer);drop(hold,"click");drop(hold,"keydown")}' +
    `window.${GATE_GLOBAL}={queue:q,` +
    'ready:function(){started=true;stop();if(dead||(fell&&moved))return false;' +
    `h.setAttribute(${gate},"");return true},` +
    `fail:function(){dead=true;stop();h.removeAttribute(${gate})}};` +
    'd.addEventListener("click",hold,true);d.addEventListener("keydown",hold,true);' +
    `h.setAttribute(${gate},"");` +
    'timer=setTimeout(function(){if(started)return;fell=true;' +
    `h.removeAttribute(${gate});` +
    'console.error("Page behaviour did not start: showing everything.");' +
    'd.addEventListener("scroll",move,true);d.addEventListener("keydown",move,true)' +
    `},${START_STATE_TIMEOUT_MS})` +
    '}catch(e){}})();';
  return body.replace(/</g, '\\u003c');
}
