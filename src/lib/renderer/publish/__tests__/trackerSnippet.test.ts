import { describe, it, expect } from 'vitest';
import { buildTrackerSnippet } from '@/lib/renderer/publish/trackerSnippet';

describe('buildTrackerSnippet', () => {
  it('injects __AP_VARIANTS and __AP_CONFIG with the public key', () => {
    const html = buildTrackerSnippet({
      ingestionKey: 'ap_live_abc123',
      ingestionEndpoint: 'https://ingest.lumitra.co',
      projectId: 'proj_x',
      variants: { 'hero-cta': 'b' },
    });
    expect(html).toContain('window.__AP_VARIANTS=');
    expect(html).toContain('window.__AP_CONFIG=');
    expect(html).toContain('ap_live_abc123');
    expect(html).toContain('"hero-cta":"b"');
    expect(html).toContain('proj_x');
  });

  it('ships an empty variants object for the control baseline', () => {
    const html = buildTrackerSnippet({
      ingestionKey: 'ap_live_abc123',
      ingestionEndpoint: 'https://ingest.lumitra.co',
    });
    expect(html).toContain('window.__AP_VARIANTS={}');
  });

  it('appends an async loader when trackerScriptSrc is given', () => {
    const html = buildTrackerSnippet({
      ingestionKey: 'ap_live_abc123',
      ingestionEndpoint: 'https://ingest.lumitra.co',
      trackerScriptSrc: 'https://cdn.lumitra.co/t.js',
    });
    expect(html).toContain('<script async src="https://cdn.lumitra.co/t.js">');
  });

  it('escapes angle brackets so the JSON cannot break out of the <script>', () => {
    const html = buildTrackerSnippet({
      ingestionKey: 'ap_live_abc123',
      ingestionEndpoint: 'https://ingest.lumitra.co',
      variants: { evil: '</script><img>' },
    });
    expect(html).not.toContain('</script><img>');
    expect(html).toContain('\\u003c');
  });

  it('REFUSES to embed a non-public (secret-shaped) key', () => {
    expect(() =>
      buildTrackerSnippet({
        ingestionKey: 'ap_account_secret_xyz',
        ingestionEndpoint: 'https://ingest.lumitra.co',
      }),
    ).toThrow(/non-public/);
  });

  it('throws when the ingestion key is missing', () => {
    expect(() =>
      buildTrackerSnippet({ ingestionKey: '', ingestionEndpoint: 'x' }),
    ).toThrow(/required/);
  });
});
