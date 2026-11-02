// The consent runtime in real browsers: only the banner's own buttons record a choice.
// A stored node cannot carry these attributes any more (renderVocabulary.ts), but
// consent is a legal record, so the runtime does not rely on that.

import { describe, expect, it } from 'vitest';
import { chromium, webkit, type BrowserType } from 'playwright';
import { CONSENT_BANNER_ID, consentRuntimeScript } from '@/lib/consent/consent';

const page = (accept: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<div ${accept} style="position:fixed;inset:0;z-index:1"></div>
<div id="${CONSENT_BANNER_ID}" data-fc-consent="" style="position:fixed;bottom:0;z-index:2">
  <button type="button" data-fc-consent-decline="">No</button>
  <button type="button" id="yes" data-fc-consent-accept="">Yes</button>
</div>
<script>${consentRuntimeScript({} as never)}</script></body></html>`;

const choice = () => (window as unknown as { __lumitraConsent: { get: () => string | null } }).__lumitraConsent.get();

describe('consent', () => {
  it.each([['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][])('takes a choice only from the banner in %s', async (_name, type) => {
    const browser = await type.launch();
    try {
      const tab = await browser.newPage();
      await tab.route('https://consent.test/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: page('data-fc-consent-accept=""') }));
      await tab.goto('https://consent.test/');
      await tab.mouse.click(5, 5);
      expect(await tab.evaluate(choice)).toBeNull();
      await tab.click('#yes');
      expect(await tab.evaluate(choice)).toBe('granted');
    } finally {
      await browser.close();
    }
  });
});
