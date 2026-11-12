// src/lib/fxScene/claim.ts
//
// One WebGL context per surface: of all the elements that could draw an FX scene on
// one surface (a published page has its own rule in FxIsland; this is for the
// editor's canvas and its preview), exactly one holds the claim and draws. The same
// node can be drawn many times on one surface (a repeated child, a component placed
// twice), so the claim is held by a rendered ELEMENT, never by a node id.
//
// The first to ask gets it; when its element goes away the claim is free and those
// still waiting are told, so one of them takes it. No engine code, no imports.

export class FxClaim {
  private holder: object | undefined;
  private listeners = new Set<() => void>();

  /** Whether `who` holds the claim now. */
  heldBy(who: object): boolean {
    return this.holder === who;
  }

  /** Whether anyone holds it. */
  get taken(): boolean {
    return this.holder !== undefined;
  }

  /** Take the claim when it is free. Returns whether `who` holds it afterwards. */
  claim(who: object): boolean {
    if (this.holder === undefined) {
      this.holder = who;
      this.tell();
    }
    return this.holder === who;
  }

  /** Give the claim up. Nothing happens when `who` does not hold it. */
  release(who: object): void {
    if (this.holder !== who) return;
    this.holder = undefined;
    this.tell();
  }

  /** Called on every change of the holder; returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The holder, for a subscriber's snapshot. */
  snapshot = (): object | undefined => this.holder;

  private tell(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
