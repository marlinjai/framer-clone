import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishProject } from '@/lib/renderer/publish/projectPublisher';
import { makeSampleProject } from './fixtures/sampleProject';
import type { ExperimentConfig } from '@/lib/renderer/publish/experiments';

const AT = '2026-06-24T00:00:00.000Z';

function htmlFiles(files: Record<string, string | Uint8Array>): string[] {
  return Object.keys(files).filter((k) => k.endsWith('index.html'));
}

describe('publishProject — directory layout', () => {
  it('emits the spec directory shape (root + nested pages, css per page, manifest)', async () => {
    const { files } = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
    });
    const keys = Object.keys(files).sort();
    expect(keys).toContain('index.html');
    expect(keys).toContain('style.css');
    expect(keys).toContain('about/index.html');
    expect(keys).toContain('about/style.css');
    expect(keys).toContain('contact/index.html');
    expect(keys).toContain('contact/style.css');
    expect(keys).toContain('manifest.json');
    // home is the root page, never nested under /home/
    expect(keys).not.toContain('home/index.html');
  });

  it('puts no inline styles in any emitted HTML and a style.css beside each page', async () => {
    const { files } = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
    });
    for (const key of htmlFiles(files)) {
      expect(files[key] as string).not.toContain('style="');
      const cssKey = key.replace(/index\.html$/, 'style.css');
      expect(files[cssKey]).toBeDefined();
    }
  });

  it('produces a valid manifest matching the declared shape', async () => {
    const { manifest, files } = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
    });
    expect(manifest.projectId).toBe('proj_sample');
    expect(manifest.publishedAt).toBe(AT);
    expect(manifest.pages).toHaveLength(3);

    const home = manifest.pages.find((p) => p.slug === 'home')!;
    expect(home.path).toBe('/index.html');
    expect(home.breakpoints).toEqual([{ id: 'bp-desktop', minWidth: 1280 }]);
    expect(home.assets).toEqual(['/media/banner.png', '/media/hero.jpg']);

    const about = manifest.pages.find((p) => p.slug === 'about')!;
    expect(about.path).toBe('/about/index.html');

    // manifest.json file parses to the same object
    expect(JSON.parse(files['manifest.json'] as string)).toEqual(manifest);
  });

  it('is idempotent: two runs with a fixed timestamp produce identical bytes', async () => {
    const a = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
    });
    const b = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
    });
    expect(Object.keys(a.files).sort()).toEqual(Object.keys(b.files).sort());
    for (const key of Object.keys(a.files)) {
      expect(a.files[key]).toEqual(b.files[key]);
    }
  });
});

describe('publishProject — per-variant emit', () => {
  const experiments: ExperimentConfig[] = [
    { experimentKey: 'hero-cta', status: 'running', variants: [{ key: 'a' }, { key: 'b' }] },
  ];

  it('emits a keyed artifact set per variant plus the control baseline', async () => {
    const { files, manifest } = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
      experiments,
    });
    // control baseline
    expect(files['index.html']).toBeDefined();
    // variant arms, per page
    expect(files['_exp/hero-cta/a/index.html']).toBeDefined();
    expect(files['_exp/hero-cta/a/style.css']).toBeDefined();
    expect(files['_exp/hero-cta/b/index.html']).toBeDefined();
    expect(files['_exp/hero-cta/a/about/index.html']).toBeDefined();
    expect(files['_exp/hero-cta/b/contact/index.html']).toBeDefined();

    expect(manifest.experiments?.arms).toEqual([
      { experimentKey: 'hero-cta', variant: 'a' },
      { experimentKey: 'hero-cta', variant: 'b' },
    ]);
    expect(manifest.experiments?.capped).toBe(false);
  });

  it('logs (and flags) when the arm cap is exceeded, never silently truncating', async () => {
    const big: ExperimentConfig[] = [
      {
        experimentKey: 'big',
        status: 'running',
        variants: Array.from({ length: 4 }, (_, i) => ({ key: `v${i}` })),
      },
    ];
    const logs: string[] = [];
    const { manifest } = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
      experiments: big,
      maxVariantArms: 2,
      logger: (m) => logs.push(m),
    });
    expect(manifest.experiments?.capped).toBe(true);
    expect(manifest.experiments?.requested).toBe(4);
    expect(logs.some((l) => /capped/.test(l))).toBe(true);
  });
});

describe('publishProject — tracker injection', () => {
  it('does NOT inject the tracker when lumitra is disabled', async () => {
    const { files } = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
      analytics: {
        ingestionKey: 'ap_live_abc',
        ingestionEndpoint: 'https://ingest.lumitra.co',
      },
    });
    expect(files['index.html'] as string).not.toContain('__AP_CONFIG');
  });

  it('injects the tracker + per-arm __AP_VARIANTS when lumitra is enabled', async () => {
    const project = makeSampleProject();
    project.setLumitraEnabled(true);
    project.setLumitraProjectId('proj_analytics');

    const { files, manifest } = await publishProject(project, {
      target: { kind: 'memory' },
      publishedAt: AT,
      analytics: {
        ingestionKey: 'ap_live_abc',
        ingestionEndpoint: 'https://ingest.lumitra.co',
      },
      experiments: [
        { experimentKey: 'hero-cta', status: 'running', variants: [{ key: 'a' }, { key: 'b' }] },
      ],
    });

    const control = files['index.html'] as string;
    expect(control).toContain('__AP_CONFIG');
    expect(control).toContain('ap_live_abc');
    expect(control).toContain('window.__AP_VARIANTS={}');

    const armA = files['_exp/hero-cta/a/index.html'] as string;
    expect(armA).toContain('"hero-cta":"a"');
    const armB = files['_exp/hero-cta/b/index.html'] as string;
    expect(armB).toContain('"hero-cta":"b"');

    expect(manifest.analytics).toEqual({ enabled: true, projectId: 'proj_analytics' });
  });

  it('skips injection (and logs) when enabled but no key is resolved', async () => {
    const project = makeSampleProject();
    project.setLumitraEnabled(true);
    const logs: string[] = [];
    const { files, manifest } = await publishProject(project, {
      target: { kind: 'memory' },
      publishedAt: AT,
      logger: (m) => logs.push(m),
    });
    expect(files['index.html'] as string).not.toContain('__AP_CONFIG');
    expect(manifest.analytics?.enabled).toBe(false);
    expect(logs.some((l) => /skipping tracker injection/.test(l))).toBe(true);
  });
});

describe('publishProject — runtime island + assets', () => {
  it('injects the runtime island script when a runtimeBundle is supplied', async () => {
    const { files } = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
      runtimeBundle: { src: '/runtime/island.js', integrity: 'sha384-xyz' },
    });
    const html = files['index.html'] as string;
    expect(html).toContain('src="/runtime/island.js"');
    expect(html).toContain('integrity="sha384-xyz"');
  });

  it('bundles resolved assets and rewrites their URLs to /assets/...', async () => {
    const resolver = (url: string) =>
      url === '/media/hero.jpg' || url === '/media/banner.png'
        ? new Uint8Array([1, 2, 3])
        : undefined;

    const { files } = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
      assetResolver: resolver,
    });

    expect(files['assets/hero.jpg']).toBeInstanceOf(Uint8Array);
    expect(files['assets/banner.png']).toBeInstanceOf(Uint8Array);

    // img src rewritten in HTML
    expect(files['index.html'] as string).toContain('src="/assets/hero.jpg"');
    // backgroundImage url rewritten in the hoisted CSS
    expect(files['style.css'] as string).toContain('url(/assets/banner.png)');
    // external CDN URL is untouched
    expect(files['index.html'] as string).toContain('https://cdn.example.com/logo.png');
  });

  it('lists assets but does not bundle them in a dry run (no resolver)', async () => {
    const logs: string[] = [];
    const { files } = await publishProject(makeSampleProject(), {
      target: { kind: 'memory' },
      publishedAt: AT,
      logger: (m) => logs.push(m),
    });
    expect(files['assets/hero.jpg']).toBeUndefined();
    expect(files['index.html'] as string).toContain('src="/media/hero.jpg"');
    expect(logs.some((l) => /NOT bundled/.test(l))).toBe(true);
  });
});

describe('publishProject — disk target', () => {
  it('writes the bundle to a local directory', async () => {
    const outDir = path.join(os.tmpdir(), 'framer-publish-test-bundle');
    await fs.rm(outDir, { recursive: true, force: true });

    const { files } = await publishProject(makeSampleProject(), {
      target: { kind: 'disk', outDir },
      publishedAt: AT,
    });

    const onDisk = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(onDisk).toBe(files['index.html']);
    const manifestOnDisk = await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8');
    expect(JSON.parse(manifestOnDisk).projectId).toBe('proj_sample');
    const nested = await fs.readFile(path.join(outDir, 'about', 'index.html'), 'utf8');
    expect(nested).toContain('About us');

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
