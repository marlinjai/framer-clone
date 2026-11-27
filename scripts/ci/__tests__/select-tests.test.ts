// scripts/ci/select-tests.mjs places the long proofs in tiers. These hold what makes that safe: the main tier
// asks every spec and gate file there is (nothing was deleted to get fast), the pull request tier fails open,
// and the render gate's selection gives the same probes for the same seed.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as select from '../select-tests.mjs';
import { describeSelection, readSelection, selectEngines, selectProbes } from '../../../test/renderGate/selection';

const ROOT = path.resolve(__dirname, '../../..');
const durations = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/test-durations.json'), 'utf8')).behaviour as Record<string, number>;

type Entry = { name: string; files: string; install: string; engines: string; seed: string; sample: string; slice: string; full: string };
type Shard = { name: string; files: string; engines: string };

const specs: string[] = select.behaviourSpecs();
const gates: string[] = select.gateFiles();
const fxSpecs = specs.filter((spec) => /\/fx[^/]*\.spec\.ts$/.test(spec));
const coreSpecs = specs.filter((spec) => !fxSpecs.includes(spec));
const filesOf = (shards: Shard[]) => shards.flatMap((s) => s.files.split(' '));

describe('the files there are', () => {
  it('finds the specs and gate files the configs include', () => {
    expect(specs.length).toBeGreaterThan(30);
    expect(gates.length).toBeGreaterThan(12);
    expect(specs).toContain('test/behaviour/fx.spec.ts');
    expect(gates).toContain('test/renderGate/editor.gate.ts');
    expect(fxSpecs.length).toBeGreaterThan(5);
    expect(coreSpecs.length).toBeGreaterThan(15);
  });

  it('measures only specs that exist, and shards a spec it has not measured yet at the default', () => {
    // A new spec on another branch is not a failure here: it counts 60 s until the durations are measured again.
    expect(Object.keys(durations).filter((spec) => !specs.includes(spec))).toEqual([]);
    const [only] = select.shard(['test/behaviour/new.spec.ts'], durations);
    expect(only.ms).toBe(60_000);
  });

  it('reads each spec engines from its playwright import', () => {
    expect(select.enginesOf('test/behaviour/headItems.spec.ts')).toContain('firefox');
    expect(select.enginesOf('test/behaviour/fxScoped.spec.ts')).toEqual(['chromium']);
    // Through its stage module, which launches the browser for it.
    expect(select.enginesOf('test/behaviour/fxScopedMounted.spec.ts')).toEqual(['chromium']);
    for (const spec of specs) expect(select.enginesOf(spec)).toContain('chromium');
  });
});

describe('main and nightly ask everything', () => {
  for (const tier of ['main', 'nightly'] as const) {
    it(`${tier}: every behaviour spec, exactly once`, () => {
      const plan = select.plan({ tier, seed: 7 });
      const asked = filesOf(plan.behaviour);
      expect([...asked].sort()).toEqual(specs);
      expect(new Set(asked).size).toBe(asked.length);
    });

    it(`${tier}: every gate file in chromium and webkit, and the bridge in firefox, every probe`, () => {
      const plan = select.plan({ tier, seed: 7 });
      const entries = plan.renderGate as Entry[];
      for (const engine of ['chromium', 'webkit']) {
        const mine = entries.filter((e) => e.engines === engine);
        expect([...new Set(mine.flatMap((e) => e.files.split(' ')))].sort()).toEqual(gates);
        expect(mine.every((e) => e.sample === '')).toBe(true);
        // The editor gate's slices cover 1..n of n.
        const editorSlices = mine.filter((e) => e.files === 'test/renderGate/editor.gate.ts').map((e) => e.slice);
        expect(editorSlices).toEqual(Array.from({ length: select.EDITOR_SLICES }, (_, i) => `${i + 1}/${select.EDITOR_SLICES}`));
        const fuzzSlices = mine.filter((e) => e.files === 'test/renderGate/fuzz.gate.ts').map((e) => e.slice);
        const n = select.FUZZ_SLICES[tier];
        expect(fuzzSlices).toEqual(n === 1 ? [''] : Array.from({ length: n }, (_, i) => `${i + 1}/${n}`));
      }
      expect(entries.filter((e) => e.engines === 'firefox').map((e) => e.files)).toEqual(['test/renderGate/customCodeBridge.gate.ts']);
      if (tier === 'nightly') {
        expect(entries.filter((e) => e.files.includes('fuzz.gate')).every((e) => e.full === '1' && e.seed === '7')).toBe(true);
      } else {
        expect(entries.every((e) => e.full === '' && e.seed === '')).toBe(true);
      }
    });
  }

  it('nightly draws a fresh seed when none is given, and prints it', () => {
    const a = select.plan({ tier: 'nightly' });
    expect(a.seed).toMatch(/^\d+$/);
  });
});

describe('every gate test honours the engines a job asks', () => {
  // A job installs only the engines it asks (RENDER_GATE_ENGINES), so a test that launches an engine itself,
  // outside the file's engine list, must ask `asks('<engine>')` first: on 2026-11-27 two such Chromium-only tests
  // failed the WebKit and Firefox jobs with "Executable doesn't exist".
  for (const file of gates) {
    it(`${file} launches no engine it was not asked for`, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const engine of ['chromium', 'webkit', 'firefox']) {
        if (new RegExp(`\\b${engine}\\.launch\\(`).test(text)) expect(text).toContain(`asks('${engine}')`);
      }
    });
  }
});

describe('a gate file left with no engine skips, and does not fail as empty', () => {
  // vitest fails a file or suite that registers no test, which is what `describe.each` and `it.each` over an empty
  // engine list do (a Firefox-only run of the whole gate failed 13 suites this way). This holds that each file
  // narrowing a list calls the helper; whether it calls it in each such suite is seen by running the gate with
  // RENDER_GATE_ENGINES=firefox.
  for (const file of gates) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!text.includes('selectEngines(')) continue;
    it(`${file} registers a skip for an empty engine list`, () => {
      expect(text).toMatch(/\bskipWithoutEngines\(\w+\);/);
    });
  }
});

describe('a pull request asks what it can affect, and fails open', () => {
  const pr = (changed: string[]) => select.plan({ tier: 'pr', changed });

  it('docs and other suites tests ask nothing', () => {
    const plan = pr(['docs/plans/x.md', 'ROADMAP.md', 'src/lib/foo/__tests__/a.test.ts', 'test/integration/b.test.ts', 'src/server/c.itest.ts']);
    expect(plan.behaviour).toEqual([]);
    expect(plan.renderGate).toEqual([]);
  });

  it('a source path the map does not know asks the proofs that always run, and the short render gate', () => {
    const plan = pr(['src/server/somewhere/new.ts']);
    expect([...filesOf(plan.behaviour)].sort()).toEqual(coreSpecs);
    expect(plan.form).toBe('sample');
    expect(plan.renderGate).toHaveLength(1);
    expect(plan.renderGate[0]).toMatchObject({ engines: 'chromium', install: 'chromium', seed: select.PR_SEED, sample: select.PR_SAMPLE });
    expect(plan.renderGate[0].files.split(' ').sort()).toEqual(gates);
  });

  it('an effects path adds the effects proofs', () => {
    for (const file of ['src/lib/fx/ring.ts', 'src/lib/fxScene/edit.ts', 'src/components/fx/FxLayer.tsx', 'src/components/Canvas.tsx', 'src/models/ComponentModel/index.ts']) {
      expect([...filesOf(pr([file]).behaviour)].sort()).toEqual(specs);
    }
  });

  it('CI, the toolchain, the shared harness and the renderer ask everything, the render gate in its long form', () => {
    for (const file of ['.github/workflows/ci.yml', 'scripts/ci/select-tests.mjs', 'package.json', 'pnpm-lock.yaml', 'prisma/schema.prisma', 'src/lib/renderer/server/x.ts', 'src/middleware.ts']) {
      const plan = pr([file]);
      expect([...filesOf(plan.behaviour)].sort()).toEqual(specs);
      expect(plan.form).toBe('long');
      // Every probe in Chromium, nothing sampled: the main tier's Chromium jobs, with the fuzz in one job.
      const entries = plan.renderGate as Entry[];
      expect(entries.every((e) => e.engines === 'chromium' && e.install === 'chromium' && e.sample === '' && e.seed === '')).toBe(true);
      expect([...new Set(entries.flatMap((e) => e.files.split(' ')))].sort()).toEqual(gates);
      expect(entries.filter((e) => e.files.endsWith('editor.gate.ts')).map((e) => e.slice)).toEqual(['1/2', '2/2']);
      expect(entries.filter((e) => e.files.endsWith('fuzz.gate.ts')).map((e) => e.slice)).toEqual(['']);
      expect(entries).toHaveLength(4);
    }
  });

  it('the behaviour harness asks every behaviour proof and no render gate', () => {
    for (const file of ['test/behaviour/setup.ts', 'test/behaviour/site.ts', 'test/behaviour/pages.ts']) {
      const plan = pr([file]);
      expect([...filesOf(plan.behaviour)].sort()).toEqual(specs);
      expect(plan.renderGate).toEqual([]);
    }
  });

  it('a stored-node format or the gate itself asks the long render gate', () => {
    for (const file of ['src/models/ComponentModel/index.ts', 'src/lib/customCode/contract.ts', 'test/renderGate/probes.ts', 'vitest.renderGate.config.ts']) {
      expect(pr([file]).form).toBe('long');
    }
    // A change to the gate alone asks no behaviour proof.
    expect(pr(['test/renderGate/probes.ts']).behaviour).toEqual([]);
  });

  it('a changed spec runs, and a behaviour-only change asks no render gate', () => {
    const plan = pr(['test/behaviour/maps.spec.ts']);
    expect(filesOf(plan.behaviour)).toEqual(['test/behaviour/maps.spec.ts']);
    expect(plan.renderGate).toEqual([]);
    expect([...filesOf(pr(['test/behaviour/fxPick.entry.tsx']).behaviour)].sort()).toEqual(fxSpecs);
    expect([...filesOf(pr(['test/behaviour/fxScopedStage.ts']).behaviour)].sort()).toEqual(fxSpecs);
  });
});

describe('one browser for the long effects proofs on a pull request', () => {
  const narrowed = specs.filter((spec) => select.narrowable(spec));

  it('narrows the four long effects proofs, and only through the helper', () => {
    expect(narrowed).toEqual(['test/behaviour/fx.spec.ts', 'test/behaviour/fxCanvas.spec.ts', 'test/behaviour/fxOracle.spec.ts', 'test/behaviour/fxRingOracle.spec.ts']);
  });

  it('a pull request sets chromium on every shard and installs only chromium for a narrowed spec', () => {
    const plan = select.plan({ tier: 'pr', changed: ['src/lib/fx/ring.ts'] });
    expect(plan.behaviour.every((s: Shard & { behaviour_engines: string }) => s.behaviour_engines === 'chromium')).toBe(true);
    for (const s of plan.behaviour as Shard[]) {
      const want = [...new Set(s.files.split(' ').flatMap((f) => (narrowed.includes(f) ? ['chromium'] : select.enginesOf(f))))].sort().join(' ');
      expect(s.engines).toBe(want);
    }
  });

  it('the deploy proof command, a child process that launches its own browsers, is given the engines of its spec', () => {
    // It runs both engines by default, and a narrowed shard installs only chromium (shard 1 of run 46077892655).
    const spec = fs.readFileSync(path.join(ROOT, 'test/behaviour/fx.spec.ts'), 'utf8');
    expect(spec).toMatch(/'test\/fx-proof\/run\.ts'.*'--engines', engines/);
    expect(spec).toContain("const engines = ENGINES.map(([name]) => name).join(',');");
  });

  it('main and nightly narrow nothing', () => {
    for (const tier of ['main', 'nightly'] as const) {
      expect(select.plan({ tier, seed: 1 }).behaviour.every((s: { behaviour_engines: string }) => s.behaviour_engines === '')).toBe(true);
    }
  });

  it('the helper narrows a list, refuses an unknown engine and a list it would empty', async () => {
    const { behaviourEngines } = await import('../../../test/behaviour/engines');
    const list = [['chromium', 1], ['webkit', 2]] as const;
    expect(behaviourEngines(list, {})).toHaveLength(2);
    // What proofs.yml sets after the merge: every engine, never a refusal.
    expect(behaviourEngines(list, { BEHAVIOUR_ENGINES: '' })).toHaveLength(2);
    expect(behaviourEngines(list, { BEHAVIOUR_ENGINES: ' ' })).toHaveLength(2);
    expect(behaviourEngines(list, { BEHAVIOUR_ENGINES: 'chromium' })).toEqual([['chromium', 1]]);
    expect(() => behaviourEngines(list, { BEHAVIOUR_ENGINES: 'edge' })).toThrow();
    expect(() => behaviourEngines(list, { BEHAVIOUR_ENGINES: 'firefox' })).toThrow(/no engine/);
  });
});

describe('shards', () => {
  it('put the longest first into the emptiest shard and stay within the cap', () => {
    const shards = select.shard(specs, durations);
    expect(shards.length).toBeLessThanOrEqual(10);
    const longest = Math.max(...specs.map((spec) => durations[spec]));
    const loads = shards.map((s: { ms: number }) => s.ms);
    // No shard is more than the longest file over the lightest one: the greedy bound.
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(longest);
  });

  it('use one shard for a single file and none for nothing', () => {
    expect(select.shard([], durations)).toEqual([]);
    expect(select.shard(['test/behaviour/maps.spec.ts'], durations)).toHaveLength(1);
  });
});

describe('render gate selection', () => {
  const list = Array.from({ length: 1000 }, (_, i) => i);

  it('asks everything in the built order with nothing set', () => {
    expect(selectProbes(list, readSelection({}))).toEqual(list);
    expect(selectEngines([['chromium', 1], ['webkit', 2]] as const, readSelection({}))).toHaveLength(2);
  });

  it('gives the same sample for the same seed, and another for another seed', () => {
    const a = selectProbes(list, readSelection({ RENDER_GATE_SEED: '20261127', RENDER_GATE_SAMPLE: '0.125' }));
    const b = selectProbes(list, readSelection({ RENDER_GATE_SEED: '20261127', RENDER_GATE_SAMPLE: '0.125' }));
    const c = selectProbes(list, readSelection({ RENDER_GATE_SEED: '1', RENDER_GATE_SAMPLE: '0.125' }));
    expect(a).toHaveLength(125);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('slices partition the list: every probe in exactly one slice', () => {
    const seen = [1, 2, 3, 4, 5, 6].flatMap((k) => selectProbes(list, readSelection({ RENDER_GATE_SLICE: `${k}/6` })));
    expect([...seen].sort((x, y) => x - y)).toEqual(list);
    const shuffled = [1, 2, 3].flatMap((k) => selectProbes(list, readSelection({ RENDER_GATE_SEED: '9', RENDER_GATE_SLICE: `${k}/3` })));
    expect([...shuffled].sort((x, y) => x - y)).toEqual(list);
  });

  it('narrows engines and refuses what it cannot read', () => {
    expect(selectEngines([['chromium', 1], ['webkit', 2], ['firefox', 3]] as const, readSelection({ RENDER_GATE_ENGINES: 'webkit' }))).toEqual([['webkit', 2]]);
    expect(() => readSelection({ RENDER_GATE_ENGINES: 'edge' })).toThrow();
    expect(() => readSelection({ RENDER_GATE_SAMPLE: '0.5' })).toThrow(/needs RENDER_GATE_SEED/);
    expect(() => readSelection({ RENDER_GATE_SEED: '1', RENDER_GATE_SAMPLE: '2' })).toThrow();
    expect(() => readSelection({ RENDER_GATE_SLICE: '7/6' })).toThrow();
    expect(() => readSelection({ RENDER_GATE_SEED: 'x' })).toThrow();
  });

  it('says what it asked, so a seed can be asked again', () => {
    expect(describeSelection(readSelection({ RENDER_GATE_SEED: '5', RENDER_GATE_SLICE: '2/3' }), 10, 30)).toBe('10 of 30 probes, RENDER_GATE_SEED=5, RENDER_GATE_SLICE=2/3');
  });
});
