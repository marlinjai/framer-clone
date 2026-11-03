// @vitest-environment node
//
// The dependency-free Agent Plugin validator (plugin/validate.mjs) against
// plugin/lumitra-sites and its mirror files, and proof that the validator
// rejects what it claims to catch (a validator that passes everything is
// worthless). Pure filesystem: no build, no database. That the skills and the
// README name exactly the server's tools is checked against the live tool list
// in src/server/mcp/__tests__/plugin.test.ts.
//
// Fake credentials are built at run time (knowledge-base standards/test-credentials.md).

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIRROR_DIR, DEFAULT_PLUGIN_DIR, parseFrontmatter, validateMirror, validatePlugin } from './validate.mjs';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch copy of the payload (`plugin`) and the mirror folder (`mirror`). */
function scratch(): { plugin: string; mirror: string } {
  const root = mkdtempSync(join(tmpdir(), 'lumitra-sites-plugin-'));
  tmpDirs.push(root);
  const plugin = join(root, 'plugin');
  const mirror = join(root, 'mirror');
  cpSync(DEFAULT_PLUGIN_DIR, plugin, { recursive: true });
  cpSync(DEFAULT_MIRROR_DIR, mirror, { recursive: true });
  return { plugin, mirror };
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));

describe('plugin/lumitra-sites', () => {
  it('is a valid Agent Plugins 1.0.0 package with no errors or warnings', () => {
    expect(validatePlugin(DEFAULT_PLUGIN_DIR)).toEqual({ errors: [], warnings: [] });
  });

  it('and its mirror files match it', () => {
    expect(validateMirror(DEFAULT_PLUGIN_DIR, DEFAULT_MIRROR_DIR)).toEqual({ errors: [], warnings: [] });
  });

  it('declares the fixed contract: the remote server, its address and the key variable', () => {
    const manifest = readJson(join(DEFAULT_PLUGIN_DIR, 'plugin.json'));
    const mcp = readJson(join(DEFAULT_PLUGIN_DIR, 'mcp.json'));
    const mirrorMcp = readJson(join(DEFAULT_MIRROR_DIR, '.mcp.json'));
    expect(manifest.name).toBe('lumitra-sites');
    expect(manifest.extensions['co.lumitra.sites'].requiredEnv).toEqual(['LUMITRA_SITES_API_KEY']);
    const server = {
      url: 'https://app.lumitra.co/api/mcp',
      headers: { Authorization: 'Bearer ${LUMITRA_SITES_API_KEY}' },
    };
    expect(mcp.mcpServers).toEqual({ 'lumitra-sites': { type: 'streamable-http', ...server } });
    expect(mirrorMcp.mcpServers).toEqual({ 'lumitra-sites': { type: 'http', ...server } });
  });

  it('carries one version in the payload, the mirror manifest and the marketplace entry', () => {
    const version = readJson(join(DEFAULT_PLUGIN_DIR, 'plugin.json')).version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readJson(join(DEFAULT_MIRROR_DIR, '.claude-plugin/plugin.json')).version).toBe(version);
    const market = readJson(join(DEFAULT_MIRROR_DIR, '.claude-plugin/marketplace.json'));
    expect(market.name).toBe('lumitra-sites');
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]).toMatchObject({ name: 'lumitra-sites', source: './', version });
  });

  it('never ships private material or a credential-shaped literal', () => {
    const files = [
      'README.md',
      'plugin.json',
      'mcp.json',
      ...['build-a-site', 'edit-a-site', 'redesign-a-site'].map((s) => `skills/${s}/SKILL.md`),
    ].map((f) => readFileSync(join(DEFAULT_PLUGIN_DIR, f), 'utf8'));
    files.push(readFileSync(join(DEFAULT_MIRROR_DIR, '.mcp.json'), 'utf8'));
    for (const text of files) {
      for (const leak of ['infisical', 'secrets-proxy', 'cc.sh', 'hermes', 'tailscale']) expect(text.toLowerCase(), leak).not.toContain(leak);
      // A bearer is only ever a ${NAME} reference or the shell's $NAME.
      for (const m of text.matchAll(/Bearer\s+(\S+)/g)) expect(m[1], m[0]).toMatch(/^"?\$\{?(?:env:)?[A-Z_]+\}?/);
      expect(text).not.toMatch(/\b(?:sk|lsk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/);
    }
  });
});

describe('validate.mjs catches spec violations', () => {
  it('rejects an unknown manifest field and a bad name', () => {
    const { plugin } = scratch();
    const p = join(plugin, 'plugin.json');
    const m = readJson(p);
    m.skills = ['build-a-site'];
    m.name = 'Lumitra--Sites';
    writeJson(p, m);
    const { errors } = validatePlugin(plugin);
    expect(errors.some((e) => e.includes('unknown top-level field "skills"'))).toBe(true);
    expect(errors.some((e) => e.includes('name must be'))).toBe(true);
  });

  it('rejects a literal credential in a header, and the Claude Code type name in mcp.json', () => {
    const { plugin } = scratch();
    const p = join(plugin, 'mcp.json');
    const c = readJson(p);
    c.mcpServers['lumitra-sites'].headers.Authorization = `Bearer ${randomBytes(24).toString('hex')}`;
    writeJson(p, c);
    expect(validatePlugin(plugin).errors.some((e) => e.includes('must take its credential from a ${NAME} reference'))).toBe(true);
    c.mcpServers['lumitra-sites'].type = 'http';
    writeJson(p, c);
    expect(validatePlugin(plugin).errors.some((e) => e.includes('type must be "stdio", "streamable-http" or "sse"'))).toBe(true);
  });

  it('rejects a header variable that is not declared, and a declared one no server uses', () => {
    const { plugin } = scratch();
    const p = join(plugin, 'mcp.json');
    const c = readJson(p);
    c.mcpServers['lumitra-sites'].headers.Authorization = 'Bearer ${SOME_OTHER_KEY}';
    writeJson(p, c);
    const { errors } = validatePlugin(plugin);
    expect(errors.some((e) => e.includes('references ${SOME_OTHER_KEY} which is not declared'))).toBe(true);
    expect(errors.some((e) => e.includes('declares LUMITRA_SITES_API_KEY but no MCP server uses it'))).toBe(true);
  });

  it.each(['prefix', 'suffix', 'second-reference', 'fallback'])('rejects a credential reference mixed with %s', (kind) => {
    const { plugin } = scratch();
    const p = join(plugin, 'mcp.json');
    const c = readJson(p);
    const literal = randomBytes(24).toString('hex');
    const reference = '${LUMITRA_SITES_API_KEY}';
    const values = {
      prefix: `Bearer ${literal}-${reference}`,
      suffix: `Bearer ${reference}-${literal}`,
      'second-reference': `${reference}${reference}`,
      fallback: `Bearer \${LUMITRA_SITES_API_KEY:-${literal}}`,
    };
    c.mcpServers['lumitra-sites'].headers.Authorization = values[kind as keyof typeof values];
    writeJson(p, c);
    expect(validatePlugin(plugin).errors.some((e) => e.includes('must take its credential from a ${NAME} reference'))).toBe(true);
  });

  it.each(['${LUMITRA_SITES_API_KEY}', 'Bearer ${LUMITRA_SITES_API_KEY}'])('accepts a complete credential reference: %s', (value) => {
    const { plugin } = scratch();
    const p = join(plugin, 'mcp.json');
    const c = readJson(p);
    c.mcpServers['lumitra-sites'].headers.Authorization = value;
    writeJson(p, c);
    expect(validatePlugin(plugin).errors).toEqual([]);
  });

  it('accepts a skill name with an inline comment before validating its directory', () => {
    const { plugin } = scratch();
    const p = join(plugin, 'skills/build-a-site/SKILL.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('name: build-a-site', 'name: build-a-site # site creation'));
    expect(validatePlugin(plugin)).toEqual({ errors: [], warnings: [] });
  });

  it('rejects a url with userinfo or a fragment', () => {
    const { plugin } = scratch();
    const p = join(plugin, 'mcp.json');
    const c = readJson(p);
    c.mcpServers['lumitra-sites'].url = 'https://user:pw@app.lumitra.co/api/mcp#x';
    writeJson(p, c);
    const { errors } = validatePlugin(plugin);
    expect(errors.some((e) => e.includes('userinfo'))).toBe(true);
    expect(errors.some((e) => e.includes('fragment'))).toBe(true);
  });

  it('rejects a skill whose name does not match its directory, a long dash, and a missing reference', () => {
    const { plugin } = scratch();
    const skillDir = join(plugin, 'skills', 'other-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: build-a-site\ndescription: x\n---\nSee references/missing.md — now\n`);
    const { errors } = validatePlugin(plugin);
    expect(errors.some((e) => e.includes('must match directory "other-skill"'))).toBe(true);
    expect(errors.some((e) => e.includes('em-dash or en-dash'))).toBe(true);
    expect(errors.some((e) => e.includes('references "references/missing.md"'))).toBe(true);
  });

  it('rejects extension listings that point at components which do not exist', () => {
    const { plugin } = scratch();
    const p = join(plugin, 'plugin.json');
    const m = readJson(p);
    m.extensions['co.lumitra.sites'].skills.push('ghost');
    m.extensions['co.lumitra.sites'].mcpServers.push('ghost-server');
    writeJson(p, m);
    const { errors } = validatePlugin(plugin);
    expect(errors.some((e) => e.includes('lists "ghost"'))).toBe(true);
    expect(errors.some((e) => e.includes('lists "ghost-server"'))).toBe(true);
  });

  it('fails cleanly when plugin.json is missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'lumitra-sites-empty-'));
    tmpDirs.push(d);
    expect(validatePlugin(d).errors.some((e) => e.includes('plugin.json') && e.includes('missing'))).toBe(true);
  });
});

describe('validateMirror catches drift between the payload and the mirror files', () => {
  it('compares header maps without depending on key order, but rejects changed values', () => {
    const { plugin, mirror } = scratch();
    const p = join(plugin, 'mcp.json');
    const m = join(mirror, '.mcp.json');
    const payload = readJson(p);
    const mirrored = readJson(m);
    payload.mcpServers['lumitra-sites'].headers.Accept = 'application/json';
    mirrored.mcpServers['lumitra-sites'].headers = {
      Accept: 'application/json',
      ...mirrored.mcpServers['lumitra-sites'].headers,
    };
    writeJson(p, payload);
    writeJson(m, mirrored);
    expect(validateMirror(plugin, mirror).errors).toEqual([]);
    mirrored.mcpServers['lumitra-sites'].headers.Accept = 'text/event-stream';
    writeJson(m, mirrored);
    expect(validateMirror(plugin, mirror).errors).toEqual(['mirror .mcp.json: server "lumitra-sites" headers must equal mcp.json\'s']);
  });

  it('treats omitted headers as an empty map and rejects malformed maps', () => {
    const { plugin, mirror } = scratch();
    const p = join(plugin, 'mcp.json');
    const m = join(mirror, '.mcp.json');
    const payload = readJson(p);
    const mirrored = readJson(m);
    delete payload.mcpServers['lumitra-sites'].headers;
    writeJson(p, payload);
    for (const headers of [undefined, {}]) {
      mirrored.mcpServers['lumitra-sites'].headers = headers;
      writeJson(m, mirrored);
      expect(validateMirror(plugin, mirror).errors).toEqual([]);
    }
    for (const headers of [[], '', 123]) {
      mirrored.mcpServers['lumitra-sites'].headers = headers;
      writeJson(m, mirrored);
      expect(validateMirror(plugin, mirror).errors.some((e) => e.includes('headers must equal'))).toBe(true);
    }
  });

  it('a version that moved in one place only', () => {
    const { plugin, mirror } = scratch();
    const p = join(plugin, 'plugin.json');
    writeJson(p, { ...readJson(p), version: '9.9.9' });
    const { errors } = validateMirror(plugin, mirror);
    expect(errors.some((e) => e.includes('.claude-plugin/plugin.json: version'))).toBe(true);
    expect(errors.some((e) => e.includes('.claude-plugin/marketplace.json: version'))).toBe(true);
  });

  it('a different address, header or type in .mcp.json', () => {
    const { plugin, mirror } = scratch();
    const p = join(mirror, '.mcp.json');
    const c = readJson(p);
    c.mcpServers['lumitra-sites'] = { type: 'streamable-http', url: 'https://example.com/mcp', headers: {} };
    writeJson(p, c);
    const { errors } = validateMirror(plugin, mirror);
    expect(errors.some((e) => e.includes('type "streamable-http" must be "http"'))).toBe(true);
    expect(errors.some((e) => e.includes('url must equal'))).toBe(true);
    expect(errors.some((e) => e.includes('headers must equal'))).toBe(true);
  });

  it('a server in only one of the two files, and a missing mirror file', () => {
    const { plugin, mirror } = scratch();
    const p = join(mirror, '.mcp.json');
    writeJson(p, { mcpServers: { other: { type: 'http', url: 'https://app.lumitra.co/api/mcp' } } });
    const { errors } = validateMirror(plugin, mirror);
    expect(errors.some((e) => e.includes('server "lumitra-sites" must exist in both'))).toBe(true);
    expect(errors.some((e) => e.includes('server "other" must exist in both'))).toBe(true);
    rmSync(join(mirror, 'LICENSE'));
    expect(validateMirror(plugin, mirror).errors).toEqual(['mirror LICENSE: missing']);
  });

  it('a file present in both the payload and the mirror folder', () => {
    const { plugin, mirror } = scratch();
    cpSync(join(mirror, 'LICENSE'), join(plugin, 'LICENSE'));
    expect(validateMirror(plugin, mirror).errors).toContain('LICENSE exists in both the payload and the mirror folder');
  });
});

describe('parseFrontmatter (carried over from Studio, pinned on the forms the skills use)', () => {
  const read = (body: string) => {
    const errors: string[] = [];
    const out = parseFrontmatter(`---\n${body}\n---\n`, 't/SKILL.md', errors);
    return { fm: (out ?? {}) as Record<string, unknown>, errors };
  };

  it('reads plain, folded and quoted values', () => {
    expect(read('name: a\ndescription: plain one line').fm.description).toBe('plain one line');
    expect(read('name: a\ndescription: >-\n  one two\n  three four').fm.description).toBe('one two three four');
    expect(read("name: a\ndescription: 'has a: colon'").fm.description).toBe('has a: colon');
  });

  it('reports a line it cannot read and an unterminated quote', () => {
    expect(read('name: a\nnot a key at all').errors).toEqual(['t/SKILL.md: cannot parse frontmatter line "not a key at all"']);
    expect(read('name: a\ndescription: "never closed').errors).toEqual(['t/SKILL.md: unterminated quoted value']);
  });

  it('strips plain scalar comments while keeping literal hashes in URLs, quotes and blocks', () => {
    expect(read('name: build-a-site # site creation\ndescription: Visit https://example.com/#section # comment\n  then read # another comment\n  # comment-only line\n  more').fm).toEqual({
      name: 'build-a-site', description: 'Visit https://example.com/#section then read more',
    });
    expect(read('description: "keep # this" # discard').fm.description).toBe('keep # this');
    expect(read("description: 'keep # this' # discard").fm.description).toBe('keep # this');
    expect(read('description: |- # discard\n  keep # this').fm.description).toBe('keep # this');
    expect(read('metadata: # comment\n  kind: site # comment').fm.metadata).toEqual({ kind: 'site' });
    expect(read('allowed-tools:\n  - Read # comment\n  - "Bash(# literal)" # comment').fm['allowed-tools']).toEqual(['Read', 'Bash(# literal)']);
  });

  it('reads every shipped skill with no error and a description within the limit', () => {
    for (const s of ['build-a-site', 'edit-a-site', 'redesign-a-site']) {
      const errors: string[] = [];
      const fm = parseFrontmatter(readFileSync(join(DEFAULT_PLUGIN_DIR, 'skills', s, 'SKILL.md'), 'utf8'), s, errors) as Record<string, string>;
      expect(errors, s).toEqual([]);
      expect(fm.name).toBe(s);
      expect(fm.description.length, s).toBeLessThanOrEqual(1024);
    }
  });
});
