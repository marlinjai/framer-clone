#!/usr/bin/env node
/**
 * Tenant isolation guards for the framer-clone commerce code (CI lint).
 *
 * Commerce isolates every company in its own Postgres schema (`tg_<hex32>`,
 * one per auth-brain tenant group) through @marlinjai/tenant-db. That isolation
 * rests on a few rules the TypeScript compiler cannot see, so this script scans
 * the commerce source statically and FAILS (exit 1) on any banned pattern.
 *
 * VENDORED from @marlinjai/tenant-db `scripts/check-guards.mjs` (auth-brain,
 * packages/tenant-db, first published with tenant-db 0.1.0). The npm package
 * ships only `dist/`, so the scanner cannot be run from node_modules; plan
 * docs/plans/2026-06-27-commerce-tenant-db-migration-plan.md (CM-13) says to
 * vendor it. Deliberate differences from upstream, each for this repo:
 *
 *   - KNOWN_TENANT_TABLES is not a hand-kept list: it is READ from the
 *     per-tenant migration set (every `CREATE TABLE` in
 *     src/server/commerce/migrations/tenant), so a new commerce table is
 *     guarded the moment its migration lands.
 *   - G1 has no "core package" exemption. Upstream exempts files under its own
 *     package root; vendored here that root would be this whole repository and
 *     silently switch G1 off. Nothing in this repository may call withSchema.
 *   - G2 also bans `SET LOCAL search_path`. Upstream allows it for migration
 *     transactions, but commerce never runs a migration itself (the tenant-db
 *     runner injects the path), so in commerce code it can only be a leftover
 *     of the retired Prisma seam. Two non-runtime forms stay allowed:
 *     `ALTER ROLE ... SET search_path` (the role default, the prescribed fix)
 *     and a function's `SET search_path FROM CURRENT` clause.
 *   - G3 is keyword aware: `ORDER BY` is not the `order` table, a QUOTED bare
 *     name (`FROM "order"`) is caught (upstream skipped any name after a
 *     double quote), and `${...}` interpolations are blanked before matching so
 *     JavaScript identifiers inside them never count.
 *   - G3 covers every SQL template tag, not only a tag literally named `sql`:
 *     Kysely's `sql` under any import alias (`import { sql as q }`), and
 *     postgres.js tags (`tx`, `owner`, any identifier assigned from
 *     `postgres(...)`, typed `Sql` / `TransactionSql`, or bound by
 *     `.begin(async (x) => ...)`). An interpolated identifier helper with a
 *     literal tenant table (`${tx('stock_movement')}`) counts as that table.
 *   - G3 accepts a schema qualifier only when it is an interpolation (the
 *     tenant schema reference); a literal qualifier such as `commerce.product`
 *     or `public.stock_movement` in front of a tenant table is flagged.
 *   - G3 also flags SQL the scanner cannot read: `sql.raw(`, `sql.table(` (any
 *     alias) and postgres.js `.unsafe(`. G2 also flags
 *     `set_config('search_path', ...)`.
 *   - The CLI walks directories itself (no shell glob expansion), and with no
 *     arguments it scans DEFAULT_ROOTS (all of src and scripts, minus the
 *     explicit exclusions below), which is what `pnpm lint:guards` and CI run.
 *
 * ALLOWANCES (narrow, path-scoped, each with its reason; see ALLOWANCES):
 *   - src/server/commerce/provisioning/backfill-demo.ts and its itest: the
 *     one-shot backfill reads and seeds the LEGACY shared `commerce` schema by
 *     design and builds its copy statements dynamically, so `.unsafe(` is
 *     allowed there (G3-raw only).
 *   - src/server/cms/withTenant.ts: the CMS (not commerce) Prisma seam that
 *     pins a CMS schema with SET LOCAL inside a Prisma transaction; it is out
 *     of the commerce isolation model, so G2 is allowed there only.
 *
 * Rules:
 *  G1: no `.withSchema` anywhere (scoped handles come from commerceTenantDb /
 *      tenantDb, which own the only withSchema call, inside tenant-db).
 *  G2: no runtime `SET search_path` / `SET LOCAL search_path` / set_config.
 *  G3: no bare (or literally qualified) tenant table inside a SQL template
 *      (qualify it with tenantSchemaRef(tgId)), and no unscannable raw SQL
 *      (sql.raw / sql.table / .unsafe).
 *  G4: no `GRANT ... ON ALL SCHEMAS` (grants are per schema only).
 *  G5: a Workers postgres config must set `prepare: false`.
 *
 * Excluded from the scan: src/server/commerce/migrations/tenant. Those bodies
 * are DDL that the tenant-db runner executes inside a transaction that already
 * holds `SET LOCAL search_path = <tg_id>, ext`, so bare table names are their
 * contract (plan section 4.2), and their trigger functions pin a path with
 * `SET search_path FROM CURRENT`.
 *
 * A deliberate hazard FIXTURE (a test proving that an unqualified fragment
 * leaks) may opt out of one line with a `tenant-db-guard-disable-next-line`
 * comment on the line above. Never in application code.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the per-tenant commerce DDL lives (source of KNOWN_TENANT_TABLES). */
export const TENANT_MIGRATIONS_DIR = 'src/server/commerce/migrations/tenant';

/**
 * The scan covers ALL application code and operator scripts, so no commerce
 * caller (the editor routes under src/app/api/projects/[projectId]/commerce,
 * the render path under src/app/(site), anything added later) can sit outside
 * a hand-kept list.
 */
export const DEFAULT_ROOTS = ['src', 'scripts'];

/**
 * Paths never scanned (relative to the repository root, POSIX separators): the
 * tenant DDL (see header), this scanner, and its spec, whose string samples are
 * banned patterns on purpose.
 */
const EXCLUDED_PREFIXES = [
  `${TENANT_MIGRATIONS_DIR}/`,
  'scripts/check-guards.mjs',
  'src/server/commerce/__tests__/checkGuards.test.ts',
];

/**
 * Narrow, path-scoped allowances: path -> rule ids that do not apply there.
 * Every entry is justified in the header. Rule ids: G1, G2, G3 (table), G3-raw
 * (unscannable raw SQL), G4, G5.
 */
const ALLOWANCES = {
  'src/server/commerce/provisioning/backfill-demo.ts': ['G3-raw'],
  'src/server/commerce/provisioning/__tests__/backfill-demo.itest.ts': ['G3-raw'],
  'src/server/cms/withTenant.ts': ['G2'],
};

const SCANNED_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * Read the commerce tenant table names from the per-tenant migration set: every
 * `CREATE TABLE [IF NOT EXISTS] "name"` in TENANT_MIGRATIONS_DIR.
 * @param {string} [root]
 * @returns {string[]}
 */
export function readKnownTenantTables(root = REPO_ROOT) {
  const dir = join(root, TENANT_MIGRATIONS_DIR);
  const tables = new Set();
  for (const name of readdirSync(dir)) {
    if (!/\.ts$/.test(name)) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
    let m;
    while ((m = re.exec(text)) !== null) tables.add(m[1]);
  }
  if (tables.size === 0) {
    throw new Error(`check-guards: no CREATE TABLE found under ${TENANT_MIGRATIONS_DIR}`);
  }
  return [...tables].sort();
}

/**
 * @param {{ path: string, text: string, knownTables: string[], isWorkersConfig?: boolean }} file
 * @returns {Array<{ rule: string, line: number, message: string }>}
 */
export function scanText(file) {
  const violations = [];
  // Lines opted out via a `tenant-db-guard-disable-next-line` comment (scanned
  // on the raw text, before comments are stripped).
  const disabledLines = new Set();
  file.text.split('\n').forEach((ln, idx) => {
    if (/tenant-db-guard-disable-next-line/.test(ln)) disabledLines.add(idx + 2);
  });

  // Blank every comment (keeping line numbers and offsets) so documentation that
  // NAMES a banned pattern never trips a rule.
  const code = stripComments(file.text);
  const lines = code.split('\n');
  const allowed = new Set(ALLOWANCES[toPosix(relative(REPO_ROOT, resolve(REPO_ROOT, file.path)))] ?? []);
  const push = (rule, idx, message) => {
    if (disabledLines.has(idx + 1) || allowed.has(rule)) return;
    violations.push({ rule, line: idx + 1, message });
  };

  // G1: any reach for withSchema, over the WHOLE comment-stripped text so a
  // newline before the `(` cannot hide a call. Three shapes: a call, computed
  // member access, and reading the property into an alias.
  const g1Patterns = [
    /\.withSchema\s*\(/g,
    /\[\s*["'`]withSchema["'`]\s*\]/g,
    /\.withSchema\s*(?!\s*\()/g,
  ];
  for (const re of g1Patterns) {
    let m;
    while ((m = re.exec(code)) !== null) {
      push('G1', lineOf(code, m.index), 'no .withSchema outside @marlinjai/tenant-db; use commerceTenantDb(tgId) / tenantDb()');
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  lines.forEach((line, idx) => {
    // G2: a runtime search_path SET, LOCAL or not. Allowed: the role default
    // (ALTER ROLE ... SET search_path) and a function's SET search_path FROM CURRENT.
    if (
      /\bSET\s+(?:LOCAL\s+|SESSION\s+)?search_path\b/i.test(line) &&
      !/\bALTER\s+ROLE\b[\s\S]*?\bSET\s+search_path\b/i.test(line) &&
      !/\bSET\s+search_path\s+FROM\s+CURRENT\b/i.test(line)
    ) {
      push('G2', idx, 'no runtime SET [LOCAL] search_path in commerce; the scoped handle qualifies every table, and the locked path is a ROLE DEFAULT');
    }
    if (/set_config\s*\(\s*['"`]search_path['"`]/i.test(line)) {
      push('G2', idx, "no set_config('search_path', ...): it is a runtime search_path SET");
    }

    // G4: all-schema grants.
    if (/GRANT[\s\S]*?ON\s+ALL\s+SCHEMAS\b/i.test(line)) {
      push('G4', idx, 'no GRANT ON ALL SCHEMAS; grant per-schema USAGE + table privileges only');
    }
  });

  const tags = sqlTagNames(code);
  const kyselyTags = kyselySqlAliases(code);

  // G3-raw: SQL the scanner cannot read.
  const rawPatterns = [
    ...kyselyTags.map((t) => ({ re: new RegExp(`\\b${escapeRe(t)}\\s*\\.\\s*(raw|table)\\s*\\(`, 'g'), what: `${t}.raw( / ${t}.table(` })),
    { re: /\.\s*unsafe\s*(?:<[^>()]*(?:<[^>()]*>[^>()]*)*>)?\s*\(/g, what: '.unsafe(' },
  ];
  for (const { re, what } of rawPatterns) {
    let m;
    while ((m = re.exec(code)) !== null) {
      push('G3-raw', lineOf(code, m.index), `raw SQL string (${what}) cannot be checked for tenant tables; use a tagged template with tenantSchemaRef / an identifier helper`);
    }
  }

  // G3: a bare or literally qualified tenant table inside any SQL template.
  for (const tpl of allTaggedTemplates(code, tags)) {
    const body = substituteInterpolations(tpl.body, file.knownTables);
    for (const t of file.knownTables) {
      // Unquoted: a whole word, not the ORDER of `ORDER BY`, and not a
      // single-quoted string value ('order' is data, not a table). Quoted: `"t"`.
      const re = new RegExp(`(?<![\\w"$'])(?:\\b${t}\\b(?!\\s+by\\b)(?!["'])|"${t}")`, 'gi');
      let m;
      while ((m = re.exec(body)) !== null) {
        const before = body.slice(0, m.index);
        const qualifier = /([A-Za-z_][\w$]*|"[^"]*")\s*\.\s*$/.exec(before);
        if (qualifier && qualifier[1] === INTERP) continue; // ${tenantSchemaRef(...)}.t
        const line = lineOf(code, tpl.start) + (before.match(/\n/g)?.length ?? 0);
        push(
          'G3',
          line,
          qualifier
            ? `tenant table "${t}" qualified by the literal schema ${qualifier[1]} in a SQL template; qualify it as \${tenantSchemaRef(tgId)}.${t}`
            : `bare tenant table "${t}" in a SQL template; qualify it as \${tenantSchemaRef(tgId)}.${t}`,
        );
        break; // one report per table per template
      }
    }
  }

  // G5: a Workers postgres config literal must set prepare:false.
  if (file.isWorkersConfig && !/prepare\s*:\s*false/.test(file.text)) {
    push('G5', 0, 'Workers postgres config must set prepare: false');
  }

  return violations;
}

/**
 * Blank comments (line and block), preserving line numbers and offsets. Not
 * string-aware (a `//` inside a string is blanked too), which is acceptable for
 * a lint heuristic and matches upstream.
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Placeholder an interpolation becomes before G3 matches (word chars only). */
const INTERP = '__interp__';

/**
 * Replace each `${...}` (nesting aware) with INTERP, keeping its newlines. An
 * identifier helper called with a literal tenant table (`${tx('order')}`,
 * `${sql.id("product")}`, `${sql.table('price')}`) becomes that table, quoted,
 * so a bare or literally qualified use of it is still caught.
 */
function substituteInterpolations(body, knownTables) {
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 0;
      let j = i;
      for (; j < body.length; j++) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const end = Math.min(j, body.length - 1);
      const expr = body.slice(i + 2, end);
      const helper = /^\s*[\w$.!]+\s*\(\s*['"`]([A-Za-z_][\w]*)['"`]\s*\)\s*$/.exec(expr);
      const newlines = (expr.match(/\n/g) ?? []).join('');
      out += (helper && knownTables.includes(helper[1]) ? `"${helper[1]}"` : INTERP) + newlines;
      i = end + 1;
      continue;
    }
    out += body[i];
    i++;
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Local names Kysely's `sql` is imported under (always includes `sql`). */
function kyselySqlAliases(code) {
  const names = new Set(['sql']);
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]kysely['"]/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const part of m[1].split(',')) {
      const alias = /^\s*sql\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part);
      if (alias) names.add(alias[1]);
    }
  }
  return [...names];
}

/**
 * Every identifier used as a SQL template tag in this file: the Kysely aliases,
 * the postgres.js defaults `tx` / `owner`, names assigned from `postgres(...)`,
 * names typed `Sql` / `TransactionSql`, and `.begin(...)` callback parameters.
 */
function sqlTagNames(code) {
  const names = new Set([...kyselySqlAliases(code), 'tx', 'owner']);
  const patterns = [
    /\b([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*postgres\s*\(/g,
    /\b([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*(?:postgres\s*\.\s*)?(?:Sql|TransactionSql)\b/g,
    /\.begin\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) names.add(m[1]);
  }
  return [...names];
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length - 1;
}

/**
 * Extract the bodies of every template tagged by one of `tags`, including the
 * typed form sql<Row>`...` with nested generics (sql<Array<Row>>`...`). Missing
 * the typed form would be a dangerous false negative.
 */
function allTaggedTemplates(text, tags) {
  const out = [];
  // `tag`, `tag!` (non-null assertion) and `obj.tag` all count; the optional
  // generic list is handled below.
  const tagRe = new RegExp(`(?<![\\w$])(?:${tags.map(escapeRe).join('|')})\\s*!?\\s*`, 'g');
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    let cursor = m.index + m[0].length;
    if (text[cursor] === '<') {
      let angle = 0;
      let j = cursor;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (ch === '<') angle++;
        else if (ch === '>') {
          angle--;
          if (angle === 0) {
            j++;
            break;
          }
        } else if (ch === '`') {
          angle = -1;
          break;
        }
      }
      if (angle !== 0) continue;
      cursor = j;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    }
    if (text[cursor] !== '`') continue;
    const start = cursor + 1;
    let i = start;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '`' && depth === 0) break;
      if (c === '$' && text[i + 1] === '{') {
        depth++;
        i++;
        continue;
      }
      if (c === '}' && depth > 0) depth--;
    }
    out.push({ start, body: text.slice(start, i) });
  }
  return out;
}

// --- file discovery + CLI ---------------------------------------------------

function toPosix(p) {
  return p.split(sep).join('/');
}

function isExcluded(absPath, root) {
  const rel = toPosix(relative(root, absPath));
  return EXCLUDED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix));
}

/**
 * Expand files and directories into the list of source files to scan.
 * @param {string[]} targets
 * @param {string} [root]
 * @returns {string[]}
 */
export function collectFiles(targets, root = REPO_ROOT) {
  const files = [];
  const walk = (abs) => {
    if (isExcluded(abs, root)) return;
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (/(^|\/)(node_modules|\.next|dist)$/.test(toPosix(abs))) return;
      for (const name of readdirSync(abs).sort()) walk(join(abs, name));
      return;
    }
    if (SCANNED_EXTENSIONS.test(abs)) files.push(abs);
  };
  for (const target of targets) {
    const abs = resolve(root, target);
    try {
      statSync(abs);
    } catch {
      throw new Error(`check-guards: path does not exist: ${target}`);
    }
    walk(abs);
  }
  return files;
}

/**
 * @param {string[]} paths
 * @param {{ knownTables: string[], isWorkersConfig?: (p: string) => boolean }} opts
 */
export function scanFiles(paths, opts) {
  const isWorkersConfig = opts.isWorkersConfig ?? defaultIsWorkersConfig;
  const all = [];
  for (const p of paths) {
    const text = readFileSync(p, 'utf8');
    const v = scanText({ path: p, text, knownTables: opts.knownTables, isWorkersConfig: isWorkersConfig(p) });
    for (const x of v) all.push({ ...x, path: p });
  }
  return all;
}

function defaultIsWorkersConfig(p) {
  return /workers/i.test(p) && /connection|db|client/i.test(p);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : DEFAULT_ROOTS;
  const knownTables = readKnownTenantTables();
  const files = collectFiles(targets);
  const violations = scanFiles(files, { knownTables });
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`[${v.rule}] ${toPosix(relative(REPO_ROOT, v.path))}:${v.line} ${v.message}\n`);
    }
    process.stderr.write(`\ntenant-db guards: ${violations.length} violation(s)\n`);
    process.exit(1);
  }
  process.stdout.write(
    `tenant-db guards: clean (${files.length} files, ${knownTables.length} tenant tables, rules G1 to G5)\n`,
  );
}
