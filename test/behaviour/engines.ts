// Which engines a behaviour spec runs in. A spec whose engine list goes through `behaviourEngines` runs only those
// named in BEHAVIOUR_ENGINES when it is set: CI's pull request tier sets it to `chromium` for the long effects
// proofs (the standard's one browser before merge), and every engine runs after the merge on main
// (scripts/ci/select-tests.mjs, .github/workflows/proofs.yml). Unset or empty (proofs.yml sets it empty after the
// merge), a spec runs its whole list, as before.

const KNOWN = ['chromium', 'webkit', 'firefox'];

export function behaviourEngines<T extends readonly [string, unknown]>(engines: readonly T[], env: Record<string, string | undefined> = process.env): T[] {
  const asked = env.BEHAVIOUR_ENGINES?.split(',').map((name) => name.trim()).filter(Boolean);
  // Empty means unset: every push to main failed the four effects proofs on this until 2026-11-28 (run 46077045851).
  if (!asked || asked.length === 0) return [...engines];
  const unknown = asked.filter((name) => !KNOWN.includes(name));
  if (unknown.length > 0) throw new Error(`BEHAVIOUR_ENGINES names no engine it knows: ${env.BEHAVIOUR_ENGINES}`);
  const kept = engines.filter(([name]) => asked.includes(name));
  // A list left empty would run nothing and pass: refuse it, so a wrong value fails loudly.
  if (kept.length === 0) throw new Error(`BEHAVIOUR_ENGINES=${env.BEHAVIOUR_ENGINES} leaves this spec no engine`);
  return kept;
}
