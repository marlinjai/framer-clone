// @vitest-environment node
// A published page links its own sheet, src/app/(site)/site.css, and never the editor's
// globals.css. The editor's sheet follows whatever its UI uses: every utility, and the
// `@property` registrations some of them bring. While it shipped under every published page,
// a strict `<color>` registration of `--tw-gradient-from` painted an imported page's
// Tailwind 3 style gradients transparent. Three things hold that apart:
//
//   - the import graph of the published routes reaches the site sheet and no editor sheet,
//     and every editor page still reaches globals.css;
//   - the site sheet scans no code, so it holds no utility the editor adds, even when the
//     editor uses gradients (proven here against a globals.css that does);
//   - the committed score base (test/score/data/published-base.css) holds no editor rule.
//
// The build's own split (Next decides CSS links per route) is checked where the build runs,
// by `pnpm score:refresh-base`, and on a real build by test/behaviour/publishedSheet.spec.ts.

import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { beforeAll, describe, expect, it } from 'vitest';
import { EDITOR_SHEET_MARKERS, readPublishedBase } from '../../../test/score/lib/publishedBase';

const ROOT = process.cwd();
const APP = path.join(ROOT, 'src/app');
const SITE_SHEET = 'src/app/(site)/site.css';
const EDITOR_SHEET = 'src/app/globals.css';
/** What a published route may never link: the editor sheet and the CMS grid's sheets. */
const EDITOR_SHEETS = [EDITOR_SHEET, 'src/app/cms-grid-theme.css', '@marlinjai/data-table-react/dist/styles/'];
/** The files Next renders on a published route: the root layout and the `(site)` group. */
const PUBLISHED_ENTRIES = ['src/app/layout.tsx', 'src/app/(site)/layout.tsx', 'src/app/(site)/[...slug]/page.tsx', 'src/app/(site)/not-found.tsx'];

/** Every file the published route files import, transitively: what their bundle holds. */
async function publishedImports(): Promise<string[]> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: PUBLISHED_ENTRIES,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    outdir: 'out',
    // Packages stay out of the graph, except the CMS grid's sheets, which must show up if imported.
    plugins: [{
      name: 'externals',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith('@/')) return undefined;
          return args.path.endsWith('.css') ? { path: args.path, namespace: 'package-css' } : { path: args.path, external: true };
        });
        b.onLoad({ filter: /.*/, namespace: 'package-css' }, () => ({ contents: '', loader: 'empty' }));
      },
    }],
    jsx: 'automatic',
    tsconfig: 'tsconfig.json',
    logLevel: 'silent',
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
  });
  return Object.keys(result.metafile.inputs).map((input) => input.replace(/^package-css:/, ''));
}

async function compile(file: string, extra = ''): Promise<{ css: string; scanned: string[] }> {
  const absolute = path.join(ROOT, file);
  const result = await postcss([tailwindcss({ base: ROOT })]).process(`${fs.readFileSync(absolute, 'utf8')}\n${extra}`, { from: absolute });
  const scanned = result.messages.filter((message) => message.type === 'dependency').map((message) => path.relative(ROOT, message.file as string).split(path.sep).join('/'));
  return { css: result.css, scanned };
}

const GRADIENT_PROPERTY = /@property\s+--tw-gradient-from\b/;

describe('the published routes', () => {
  let imports: string[];

  beforeAll(async () => {
    imports = await publishedImports();
  }, 60_000);

  it('import the site sheet', () => {
    expect(imports).toContain(SITE_SHEET);
  });

  it('import no editor sheet', () => {
    expect(imports.filter((input) => EDITOR_SHEETS.some((sheet) => input.includes(sheet)))).toEqual([]);
  });

  it('import no other stylesheet, so nothing else reaches a visitor', () => {
    expect(imports.filter((input) => input.endsWith('.css'))).toEqual([SITE_SHEET]);
  });
});

/** Every page file outside `(site)`, with the files that must import the editor sheet for it. */
function editorPages(): { page: string; carriers: string[] }[] {
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '(site)' && entry.name !== '__tests__' && entry.name !== 'api') walk(full);
      } else if (/^page(\.harness)?\.tsx$/.test(entry.name)) {
        pages.push(full);
      }
    }
  };
  walk(APP);
  return pages.map((page) => {
    const carriers = [page];
    for (let dir = path.dirname(page); dir !== APP; dir = path.dirname(dir)) {
      const layout = path.join(dir, 'layout.tsx');
      if (fs.existsSync(layout)) carriers.push(layout);
    }
    return { page: path.relative(ROOT, page), carriers };
  });
}

/** Whether a file imports src/app/globals.css by a relative path. */
function importsEditorSheet(file: string): boolean {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/^import\s+['"](\.[^'"]*globals\.css)['"];?$/gm)].some((match) => path.resolve(path.dirname(file), match[1]) === path.join(ROOT, EDITOR_SHEET));
}

describe('the editor routes', () => {
  it('each reach globals.css through the page or a layout above it', () => {
    const pages = editorPages();
    expect(pages.length).toBeGreaterThan(5);
    // The Books engine harness draws no styled UI (it compares bytes), and only exists in its own build.
    const missing = pages.filter(({ page, carriers }) => !page.endsWith('.harness.tsx') && !carriers.some(importsEditorSheet)).map(({ page }) => page);
    expect(missing, 'an editor page renders without the editor sheet').toEqual([]);
  });

  it('the root layout imports no stylesheet, since it wraps the published routes too', () => {
    expect(fs.readFileSync(path.join(APP, 'layout.tsx'), 'utf8')).not.toMatch(/^import\s+['"][^'"]+\.css['"]/m);
  });
});

describe('the site sheet', () => {
  let site: { css: string; scanned: string[] };
  let editorWithGradient: { css: string; scanned: string[] };

  beforeAll(async () => {
    site = await compile(SITE_SHEET);
    // The editor's UI using a gradient: Tailwind 4 registers the gradient variables strictly.
    editorWithGradient = await compile(EDITOR_SHEET, '@source inline("bg-linear-to-r from-red-500 to-blue-500");');
  }, 60_000);

  it('scans no code: it reads only the sheets it imports', () => {
    expect(site.scanned.filter((file) => !file.endsWith('.css'))).toEqual([]);
    expect(site.scanned).toContain('src/app/theme-tokens.css');
  });

  it('holds the reset, the theme tokens, the base layer and the body utility', () => {
    expect(site.css).toContain('@layer base');
    expect(site.css).toContain('--background:');
    expect(site.css).toMatch(/\.dark\s*\{/);
    expect(site.css).toMatch(/\.antialiased\s*\{/);
  });

  it('holds no editor rule and no @property registration', () => {
    for (const marker of EDITOR_SHEET_MARKERS) expect(site.css).not.toContain(marker);
    expect(site.css).not.toContain('@property');
  });

  it('stays free of the gradient registration when the editor uses gradients', () => {
    expect(editorWithGradient.css, 'the control: the editor sheet registers it').toMatch(GRADIENT_PROPERTY);
    expect(site.css).not.toMatch(GRADIENT_PROPERTY);
  });
});

describe('the committed published base in the score', () => {
  it('holds no editor rule and no gradient registration', () => {
    const { css } = readPublishedBase();
    for (const marker of EDITOR_SHEET_MARKERS) expect(css).not.toContain(marker);
    expect(css).not.toMatch(GRADIENT_PROPERTY);
  });
});
