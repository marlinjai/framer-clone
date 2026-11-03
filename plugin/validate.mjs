#!/usr/bin/env node
// Validates plugin/lumitra-sites against the Agent Plugins 1.0.0 manifest and
// mcp.json schemas and the Agent Skills SKILL.md spec, and the Claude Code files
// of the public mirror (plugin/lumitra-sites-mirror) against the payload. No
// dependencies. Adapted from Lumitra Studio's plugin/validate.mjs; rules and
// their sources: plugin/SPEC-NOTES.md.
//
// Usage: node plugin/validate.mjs [pluginDir [mirrorDir]]
// Exit 0 when valid, 1 with one "ERROR: ..." line per violation on stderr.
// Exported `validatePlugin(dir)` and `validateMirror(pluginDir, mirrorDir)` each
// return { errors: string[], warnings: string[] }.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_VERSION = "1.0.0";
const PLUGIN_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/plugin.schema.json`;
const MCP_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/mcp.schema.json`;
const NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SKILL_NAME_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const CWD_RE = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MANIFEST_KEYS = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
const AUTHOR_KEYS = new Set(["name", "email", "url"]);
const SKILL_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const OUR_NAMESPACE = "co.lumitra.sites";
// A ${NAME} reference a client expands from its environment. ${PLUGIN_ROOT} and
// ${PLUGIN_DATA} are the spec's own and need no declaration.
const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;
const SPEC_VARS = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);
// Header names that carry a credential: their value must come from a ${NAME}
// reference, never be written into the file.
const CREDENTIAL_HEADER_RE = /authorization|token|key|secret|cookie/i;

const isStr = (v) => typeof v === "string";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStrMap = (v) => isObj(v) && Object.values(v).every(isStr);

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`${path}: not valid JSON (${e.message})`);
    return undefined;
  }
}

function checkManifest(dir, errors, warnings) {
  const path = join(dir, "plugin.json");
  if (!existsSync(path)) { errors.push(`${path}: missing (plugin.json must live at the plugin root)`); return undefined; }
  const m = readJson(path, errors);
  if (!isObj(m)) { if (m !== undefined) errors.push(`${path}: must be a JSON object`); return undefined; }
  for (const k of Object.keys(m)) if (!MANIFEST_KEYS.has(k)) errors.push(`plugin.json: unknown top-level field "${k}" (schema is closed)`);
  if (m.$schema !== PLUGIN_SCHEMA) errors.push(`plugin.json: $schema must be "${PLUGIN_SCHEMA}"`);
  if (!isStr(m.name) || m.name.length < 1 || m.name.length > 64 || !NAME_RE.test(m.name)) errors.push(`plugin.json: name must be 1-64 chars of [a-z0-9.-], alphanumeric start/end, no "--" or ".."`);
  for (const k of ["version", "description", "homepage", "repository", "license"]) if (k in m && !isStr(m[k])) errors.push(`plugin.json: ${k} must be a string`);
  if (isStr(m.version) && !SEMVER_RE.test(m.version)) warnings.push(`plugin.json: version "${m.version}" is not Semantic Versioning (spec SHOULD)`);
  if (!("version" in m)) warnings.push("plugin.json: no version field");
  if ("author" in m) {
    if (!isObj(m.author)) errors.push("plugin.json: author must be an object");
    else for (const [k, v] of Object.entries(m.author)) {
      if (!AUTHOR_KEYS.has(k)) errors.push(`plugin.json: author.${k} is not allowed (only name, email, url)`);
      else if (!isStr(v)) errors.push(`plugin.json: author.${k} must be a string`);
    }
  }
  if ("keywords" in m && !(Array.isArray(m.keywords) && m.keywords.every(isStr))) errors.push("plugin.json: keywords must be an array of strings");
  if ("extensions" in m) {
    if (!isObj(m.extensions)) errors.push("plugin.json: extensions must be an object");
    else for (const [ns, v] of Object.entries(m.extensions)) {
      if (!isObj(v)) errors.push(`plugin.json: extensions["${ns}"] must be an object`);
      if (!ns.includes(".")) warnings.push(`plugin.json: extension namespace "${ns}" is not reverse-domain shaped`);
    }
  }
  return m;
}

function checkMcp(dir, errors, warnings) {
  const path = join(dir, "mcp.json");
  if (!existsSync(path)) return undefined;
  const c = readJson(path, errors);
  if (!isObj(c)) { if (c !== undefined) errors.push("mcp.json: must be a JSON object"); return undefined; }
  for (const k of Object.keys(c)) if (k !== "$schema" && k !== "mcpServers") errors.push(`mcp.json: unknown top-level field "${k}"`);
  if (c.$schema !== MCP_SCHEMA) errors.push(`mcp.json: $schema must be "${MCP_SCHEMA}" (version must match plugin.json)`);
  if (!isObj(c.mcpServers)) { errors.push("mcp.json: mcpServers must be an object"); return c; }
  if (Object.keys(c.mcpServers).length === 0) warnings.push("mcp.json: mcpServers is empty");
  for (const [id, s] of Object.entries(c.mcpServers)) {
    const p = `mcp.json: mcpServers["${id}"]`;
    if (!isObj(s)) { errors.push(`${p} must be an object`); continue; }
    if (s.type === "stdio") {
      for (const k of Object.keys(s)) if (!["type", "command", "args", "env", "cwd"].includes(k)) errors.push(`${p}: unknown field "${k}" for stdio`);
      if (!isStr(s.command) || s.command.length === 0) errors.push(`${p}: command is required`);
      else {
        if (/\s/.test(s.command)) errors.push(`${p}: command must be a single executable token, not a shell string`);
        if (s.command.includes("/") && !s.command.startsWith("./")) errors.push(`${p}: command path must be plugin-relative and start with "./"`);
        if (s.command.startsWith("./") && !existsSync(join(dir, s.command))) errors.push(`${p}: command "${s.command}" does not exist in the plugin`);
        if (s.command.includes("${")) errors.push(`${p}: variable expansion is not applied to command`);
      }
      if ("args" in s && !(Array.isArray(s.args) && s.args.every(isStr))) errors.push(`${p}: args must be an array of strings`);
      if ("env" in s) {
        if (!isStrMap(s.env)) errors.push(`${p}: env must be a string-to-string map`);
        else for (const k of Object.keys(s.env)) if (k === "PLUGIN_ROOT" || k === "PLUGIN_DATA") errors.push(`${p}: env must not define reserved "${k}"`);
      }
      if ("cwd" in s && !(isStr(s.cwd) && CWD_RE.test(s.cwd))) errors.push(`${p}: cwd must start with "./", "\${PLUGIN_ROOT}" or "\${PLUGIN_DATA}"`);
    } else if (s.type === "streamable-http" || s.type === "sse") {
      for (const k of Object.keys(s)) if (!["type", "url", "headers"].includes(k)) errors.push(`${p}: unknown field "${k}" for ${s.type}`);
      if (!isStr(s.url) || s.url.length === 0) errors.push(`${p}: url is required`);
      else {
        let u;
        try { u = new URL(s.url); } catch { errors.push(`${p}: url is not an absolute URL`); }
        if (u) {
          if (u.protocol !== "http:" && u.protocol !== "https:") errors.push(`${p}: url must be http or https`);
          if (u.username || u.password) errors.push(`${p}: url must not contain userinfo`);
          if (u.hash) errors.push(`${p}: url must not contain a fragment`);
        }
      }
      if ("headers" in s) {
        if (!isStrMap(s.headers)) errors.push(`${p}: headers must be a string-to-string map`);
        else for (const [h, v] of Object.entries(s.headers)) {
          if (CREDENTIAL_HEADER_RE.test(h) && !/^(?:Bearer[ \t]+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v)) errors.push(`${p}: header "${h}" must take its credential from a \${NAME} reference, never a literal value`);
        }
      }
    } else {
      errors.push(`${p}: type must be "stdio", "streamable-http" or "sse"`);
    }
  }
  return c;
}

// YAML frontmatter reader for the Agent Skills field set: top-level "key: value",
// one level of indented "key: value" under a mapping key, and the multi-line
// scalar forms a real YAML client accepts. Block scalars (">" folded and "|"
// literal, with the chomping indicators "-" and "+" and an optional explicit
// indentation indicator), quoted scalars that run over several lines, plain
// continuations and block sequences are all read here. Published plugins ship
// descriptions and allowed-tools written that way, so a reader that rejects them
// rejects valid skills.
//
// Structure deeper than the field set (a mapping inside a mapping, a sequence of
// mappings) is consumed and typed as null rather than reported line by line, so
// it surfaces as the one type error that applies instead of a wall of noise.
const BLOCK_HEADER_RE = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?[ \t]*(?:#.*)?$/;
const ENTRY_RE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;
const ITEM_RE = /^-(?:[ \t]+(.*))?$/;
const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => !line.trim() || line.trimStart().startsWith("#");
// Only a whitespace-separated hash starts a comment in a plain scalar.
const stripPlainComment = (line) => line.replace(/(?:^|[ \t]+)#.*$/, "").trim();

// Folds a block scalar body the way ">" does: one line break between two lines
// at the block indent becomes a space, a run of N empty lines becomes N
// newlines, and a break next to a more-indented line stays a break.
function foldBody(body) {
  let out = "";
  let breaks = 0;
  let prevMore = false;
  let started = false;
  for (const line of body) {
    if (line === "") { breaks++; continue; }
    const more = /^[ \t]/.test(line);
    if (!started) out = "\n".repeat(breaks) + line;
    else if (breaks > 0) out += "\n".repeat(breaks) + line;
    else out += (more || prevMore ? "\n" : " ") + line;
    started = true;
    breaks = 0;
    prevMore = more;
  }
  return out;
}

// Body of a "|" or ">" block: every following line indented deeper than the key.
// The block indent is the explicit indicator when given, else the indent of the
// first non-empty line. Chomping: "-" strips the trailing break, "+" keeps every
// trailing break, the default clips to exactly one.
function readBlockScalar(lines, start, parentIndent, style, chomp, explicit) {
  const content = [];
  let indent = explicit ? parentIndent + explicit : 0;
  let j = start;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === "") { content.push(""); continue; }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (!indent) indent = ind;
    if (ind < indent) break;
    content.push(line.slice(indent));
  }
  let end = content.length;
  while (end > 0 && content[end - 1] === "") end--;
  const body = content.slice(0, end);
  const trailing = content.length - end;
  let value = style === "|" ? body.join("\n") : foldBody(body);
  if (chomp === "+") value += "\n".repeat((body.length ? 1 : 0) + trailing);
  else if (chomp !== "-" && body.length) value += "\n";
  return { value, next: j };
}

// Index of the closing quote in a quoted scalar, or -1 when it does not close in
// this buffer. Honours "\" escapes in double quotes and "''" in single quotes.
function quotedEnd(s, q) {
  for (let k = 1; k < s.length; k++) {
    if (q === '"' && s[k] === "\\") { k++; continue; }
    if (s[k] !== q) continue;
    if (q === "'" && s[k + 1] === "'") { k++; continue; }
    return k;
  }
  return -1;
}

const decodeQuoted = (s, q) =>
  q === "'" ? s.replace(/''/g, "'") : s.replace(/\\(["\\/nrt])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c);

const unquoteInline = (v) => {
  const q = v[0];
  if (q !== '"' && q !== "'") return v;
  const end = quotedEnd(v, q);
  return end === -1 ? v : decodeQuoted(v.slice(1, end), q);
};

// Quoted scalar, which may run over several lines. Continuations fold onto one
// line the way a plain scalar does; a blank line inside one becomes a break.
function readQuoted(lines, i, parentIndent, rest, fail) {
  const q = rest[0];
  let buf = rest;
  let end = quotedEnd(buf, q);
  let j = i + 1;
  let afterBreak = false;
  while (end === -1 && j < lines.length) {
    const line = lines[j];
    if (line.trim() === "") { buf += "\n"; afterBreak = true; j++; continue; }
    if (indentOf(line) <= parentIndent) break;
    buf += (afterBreak ? "" : " ") + line.trim();
    afterBreak = false;
    j++;
    end = quotedEnd(buf, q);
  }
  if (end === -1) { fail(`unterminated quoted value`); return { value: rest, next: j }; }
  return { value: decodeQuoted(buf.slice(1, end), q), next: j };
}

// Plain (unquoted) scalar: continuation lines are the deeper-indented lines that
// follow, folded onto one line. A blank line ends it, so blank separators before
// the next key are never swallowed.
function readPlain(lines, start, parentIndent, first) {
  let value = stripPlainComment(first);
  let j = start;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === "" || indentOf(line) <= parentIndent) break;
    const part = stripPlainComment(line);
    if (part) value += (value ? " " : "") + part;
  }
  return { value, next: j };
}

// Consumes every following line indented deeper than parentIndent.
function skipBlock(lines, start, parentIndent) {
  let j = start;
  for (; j < lines.length; j++) {
    if (lines[j].trim() === "") continue;
    if (indentOf(lines[j]) <= parentIndent) break;
  }
  return j;
}

const nextSignificant = (lines, start) => {
  for (let j = start; j < lines.length; j++) if (!isBlank(lines[j])) return j;
  return -1;
};

// Block sequence of inline scalars ("- item" lines). A sequence of anything else
// is consumed and typed null: the field set has no such shape.
function readSequence(lines, start, parentIndent) {
  const items = [];
  let j = start;
  while (j < lines.length) {
    const raw = lines[j];
    if (isBlank(raw)) { j++; continue; }
    if (indentOf(raw) <= parentIndent) break;
    const item = ITEM_RE.exec(raw.trimStart());
    if (!item) break;
    const rest = (item[1] ?? "").trim();
    if (rest === "" || ENTRY_RE.test(rest)) return { value: null, next: skipBlock(lines, start, parentIndent) };
    items.push(rest[0] === '"' || rest[0] === "'" ? unquoteInline(rest) : stripPlainComment(rest));
    j++;
  }
  return { value: items, next: j };
}

function readValue(lines, i, parentIndent, rest, fail, allowNested) {
  if (rest.startsWith("#")) rest = "";
  const header = BLOCK_HEADER_RE.exec(rest);
  if (header) return readBlockScalar(lines, i + 1, parentIndent, header[1], header[2] ?? header[5] ?? "", Number(header[3] ?? header[4] ?? 0));
  if (rest !== "") {
    if (rest[0] === '"' || rest[0] === "'") return readQuoted(lines, i, parentIndent, rest, fail);
    return readPlain(lines, i + 1, parentIndent, rest);
  }
  const k = nextSignificant(lines, i + 1);
  if (k === -1 || indentOf(lines[k]) <= parentIndent) return { value: {}, next: i + 1 };
  if (ITEM_RE.test(lines[k].trimStart())) return readSequence(lines, i + 1, parentIndent);
  if (!allowNested) return { value: null, next: skipBlock(lines, i + 1, parentIndent) };
  return readMapping(lines, i + 1, indentOf(lines[k]), fail, false);
}

function readMapping(lines, start, indent, fail, allowNested) {
  const out = {};
  let j = start;
  while (j < lines.length) {
    const raw = lines[j];
    if (isBlank(raw)) { j++; continue; }
    const ind = indentOf(raw);
    if (ind < indent) break;
    const entry = ind === indent ? ENTRY_RE.exec(raw.trimStart()) : null;
    if (!entry) { fail(`cannot parse frontmatter line "${raw}"`); j++; continue; }
    const r = readValue(lines, j, ind, entry[2], fail, allowNested);
    out[entry[1]] = r.value;
    j = r.next;
  }
  return { value: out, next: j };
}

export function parseFrontmatter(text, file, errors) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) { errors.push(`${file}: missing YAML frontmatter delimited by ---`); return undefined; }
  const lines = m[1].replace(/\r?\n$/, "").split(/\r?\n/);
  return readMapping(lines, 0, 0, (why) => errors.push(`${file}: ${why}`), true).value;
}

function checkSkills(dir, errors, warnings) {
  const root = join(dir, "skills");
  const found = [];
  if (!existsSync(root)) { warnings.push("skills/: directory missing, plugin ships no skills"); return found; }
  for (const entry of readdirSync(root)) {
    const skillDir = join(root, entry);
    if (!statSync(skillDir).isDirectory()) continue;
    const file = join(skillDir, "SKILL.md");
    const rel = `skills/${entry}/SKILL.md`;
    if (!existsSync(file) || !statSync(file).isFile()) { warnings.push(`skills/${entry}: no SKILL.md, clients will skip it`); continue; }
    const text = readFileSync(file, "utf8");
    const fm = parseFrontmatter(text, rel, errors);
    if (!fm) continue;
    for (const k of Object.keys(fm)) if (!SKILL_KEYS.has(k)) warnings.push(`${rel}: non-standard frontmatter field "${k}"`);
    if (!isStr(fm.name) || fm.name.length < 1 || fm.name.length > 64 || !SKILL_NAME_RE.test(fm.name)) errors.push(`${rel}: name must be 1-64 chars of [a-z0-9-], no leading/trailing/double hyphen`);
    else if (fm.name !== entry) errors.push(`${rel}: name "${fm.name}" must match directory "${entry}"`);
    if (!isStr(fm.description) || fm.description.trim().length < 1 || fm.description.length > 1024) errors.push(`${rel}: description is required, 1-1024 chars`);
    if ("compatibility" in fm && (!isStr(fm.compatibility) || fm.compatibility.length < 1 || fm.compatibility.length > 500)) errors.push(`${rel}: compatibility must be 1-500 chars`);
    if ("license" in fm && !isStr(fm.license)) errors.push(`${rel}: license must be a string`);
    if ("allowed-tools" in fm && !isStr(fm["allowed-tools"])) errors.push(`${rel}: allowed-tools must be a space-separated string`);
    if ("metadata" in fm && !isStrMap(fm.metadata)) errors.push(`${rel}: metadata must be a string-to-string map`);
    const lines = text.split(/\r?\n/).length;
    if (lines > 500) warnings.push(`${rel}: ${lines} lines, spec recommends under 500`);
    if (/[\u2013\u2014]/.test(text)) errors.push(`${rel}: contains an em-dash or en-dash`);
    // Every scripts/... or references/... path mentioned in the body must exist.
    // Only skill-root-relative paths count (not URL path segments like /api/x/references/upload).
    for (const ref of new Set([...text.matchAll(/(?<![\w/{}$])((?:scripts|references|assets)\/[A-Za-z0-9_./-]+)/g)].map((x) => x[1]))) {
      if (!existsSync(join(skillDir, ref))) errors.push(`${rel}: references "${ref}" which does not exist`);
    }
    for (const sub of ["scripts"]) {
      const sdir = join(skillDir, sub);
      if (!existsSync(sdir)) continue;
      for (const f of readdirSync(sdir)) {
        const fp = join(sdir, f);
        if (f.endsWith(".sh") && !(statSync(fp).mode & 0o111)) errors.push(`skills/${entry}/${sub}/${f}: not executable`);
      }
    }
    found.push(entry);
  }
  return found;
}

function checkDashes(dir, errors) {
  for (const f of ["README.md", "plugin.json", "mcp.json"]) {
    const p = join(dir, f);
    if (existsSync(p) && /[\u2013\u2014]/.test(readFileSync(p, "utf8"))) errors.push(`${f}: contains an em-dash or en-dash`);
  }
}

function checkOurExtension(manifest, mcp, skills, errors) {
  const ext = manifest?.extensions?.[OUR_NAMESPACE];
  if (!ext) return;
  for (const s of ext.skills ?? []) if (!skills.includes(s)) errors.push(`plugin.json: extensions["${OUR_NAMESPACE}"].skills lists "${s}" but skills/${s}/SKILL.md is missing`);
  for (const id of ext.mcpServers ?? []) if (!mcp?.mcpServers?.[id]) errors.push(`plugin.json: extensions["${OUR_NAMESPACE}"].mcpServers lists "${id}" but mcp.json has no such server`);
  const declared = new Set([...(ext.requiredEnv ?? []), ...(ext.optionalEnv ?? [])]);
  const used = new Set();
  for (const [id, s] of Object.entries(mcp?.mcpServers ?? {})) {
    if (!isObj(s)) continue;
    for (const k of Object.keys(s.env ?? {})) {
      used.add(k);
      if (!declared.has(k)) errors.push(`mcp.json: mcpServers["${id}"].env.${k} is not declared in extensions["${OUR_NAMESPACE}"] requiredEnv/optionalEnv`);
    }
    // A remote server has no env: the variables it needs are the ${NAME}
    // references in its url and headers, and each must be declared.
    for (const name of envRefs(s)) {
      used.add(name);
      if (!declared.has(name)) errors.push(`mcp.json: mcpServers["${id}"] references \${${name}} which is not declared in extensions["${OUR_NAMESPACE}"] requiredEnv/optionalEnv`);
    }
  }
  for (const name of declared) if (!used.has(name)) errors.push(`plugin.json: extensions["${OUR_NAMESPACE}"] declares ${name} but no MCP server uses it`);
}

/** The ${NAME} references in a server's url and header values, without the spec's own variables. */
function envRefs(server) {
  const texts = [server.url, ...Object.values(isStrMap(server.headers) ? server.headers : {})].filter(isStr);
  const names = new Set();
  for (const t of texts) for (const m of t.matchAll(ENV_REF_RE)) if (!SPEC_VARS.has(m[1])) names.add(m[1]);
  return names;
}

// ---------- the public mirror's Claude Code files ----------
//
// The mirror repository is the payload plus a few files Claude Code reads that
// the Agent Plugins spec does not define: .claude-plugin/plugin.json,
// .claude-plugin/marketplace.json, .mcp.json (with type "http" where the spec
// says "streamable-http") and LICENSE. They live in plugin/lumitra-sites-mirror
// so they are reviewed and versioned here instead of hand-edited in the mirror.

const MIRROR_FILES = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".mcp.json", "LICENSE"];

// Header maps have no ordering; malformed maps still fail validation.
const sameHeaders = (a, b) => isStrMap(a) && isStrMap(b)
  && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every((key) => Object.hasOwn(b, key) && a[key] === b[key]);

export function validateMirror(pluginDir, mirrorDir) {
  const errors = [];
  const warnings = [];
  for (const f of MIRROR_FILES) if (!existsSync(join(mirrorDir, f))) errors.push(`mirror ${f}: missing`);
  if (errors.length) return { errors, warnings };
  // Payload and mirror files land in one directory; a file in both would be overwritten.
  for (const f of MIRROR_FILES) if (existsSync(join(pluginDir, f))) errors.push(`${f} exists in both the payload and the mirror folder`);

  const payload = readJson(join(pluginDir, "plugin.json"), errors);
  const payloadMcp = readJson(join(pluginDir, "mcp.json"), errors);
  const manifest = readJson(join(mirrorDir, ".claude-plugin/plugin.json"), errors);
  const market = readJson(join(mirrorDir, ".claude-plugin/marketplace.json"), errors);
  const mcp = readJson(join(mirrorDir, ".mcp.json"), errors);
  if (![payload, payloadMcp, manifest, market, mcp].every(isObj)) return { errors, warnings };

  // One version everywhere: the payload's plugin.json is the source of truth.
  const entry = Array.isArray(market.plugins) ? market.plugins.find((p) => isObj(p) && p.name === payload.name) : undefined;
  if (manifest.name !== payload.name) errors.push(`mirror .claude-plugin/plugin.json: name "${manifest.name}" must be "${payload.name}"`);
  if (manifest.version !== payload.version) errors.push(`mirror .claude-plugin/plugin.json: version ${manifest.version} must equal plugin.json's ${payload.version}`);
  if (!isStr(market.name) || !market.name) errors.push("mirror .claude-plugin/marketplace.json: name is required");
  if (!entry) errors.push(`mirror .claude-plugin/marketplace.json: no plugin entry named "${payload.name}"`);
  else {
    if (entry.version !== payload.version) errors.push(`mirror .claude-plugin/marketplace.json: version ${entry.version} must equal plugin.json's ${payload.version}`);
    if (entry.source !== "./") errors.push('mirror .claude-plugin/marketplace.json: the plugin source must be "./" (the mirror root is the plugin root)');
  }
  for (const [label, m] of [["plugin.json", manifest], ["marketplace.json entry", entry ?? {}]]) {
    for (const k of ["homepage", "repository", "license"]) if (k in m && m[k] !== payload[k]) errors.push(`mirror ${label}: ${k} "${m[k]}" must equal plugin.json's "${payload[k]}"`);
  }

  // The same servers, the same address, the same headers; only the type name differs.
  const ours = isObj(payloadMcp.mcpServers) ? payloadMcp.mcpServers : {};
  const theirs = isObj(mcp.mcpServers) ? mcp.mcpServers : {};
  if (Object.keys(mcp).some((k) => k !== "mcpServers")) errors.push('mirror .mcp.json: only "mcpServers" is allowed at the top level');
  const ids = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const id of ids) {
    const a = ours[id];
    const b = theirs[id];
    if (!isObj(a) || !isObj(b)) { errors.push(`mirror .mcp.json: server "${id}" must exist in both mcp.json and .mcp.json`); continue; }
    const expectedType = a.type === "streamable-http" ? "http" : a.type;
    if (b.type !== expectedType) errors.push(`mirror .mcp.json: server "${id}" type "${b.type}" must be "${expectedType}" (Claude Code's name for mcp.json's "${a.type}")`);
    if (b.url !== a.url) errors.push(`mirror .mcp.json: server "${id}" url must equal mcp.json's`);
    if (!sameHeaders(b.headers ?? {}, a.headers ?? {})) errors.push(`mirror .mcp.json: server "${id}" headers must equal mcp.json's`);
    for (const k of Object.keys(b)) if (!["type", "url", "headers"].includes(k)) errors.push(`mirror .mcp.json: server "${id}" has an unexpected field "${k}"`);
  }

  for (const f of MIRROR_FILES) {
    const text = readFileSync(join(mirrorDir, f), "utf8");
    if (/[\u2013\u2014]/.test(text)) errors.push(`mirror ${f}: contains an em-dash or en-dash`);
  }
  return { errors, warnings };
}

export function validatePlugin(dir) {
  const errors = [];
  const warnings = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { errors: [`${dir}: not a directory`], warnings };
  const manifest = checkManifest(dir, errors, warnings);
  const mcp = checkMcp(dir, errors, warnings);
  const skills = checkSkills(dir, errors, warnings);
  if (!existsSync(join(dir, "README.md"))) warnings.push("README.md: missing");
  checkDashes(dir, errors);
  checkOurExtension(manifest, mcp, skills, errors);
  return { errors, warnings };
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PLUGIN_DIR = join(here, "lumitra-sites");
export const DEFAULT_MIRROR_DIR = join(here, "lumitra-sites-mirror");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? DEFAULT_PLUGIN_DIR);
  const mirrorDir = resolve(process.argv[3] ?? DEFAULT_MIRROR_DIR);
  const plugin = validatePlugin(dir);
  const mirror = plugin.errors.length ? { errors: [], warnings: [] } : validateMirror(dir, mirrorDir);
  const errors = [...plugin.errors, ...mirror.errors];
  const warnings = [...plugin.warnings, ...mirror.warnings];
  for (const w of warnings) console.warn(`WARN: ${w}`);
  for (const e of errors) console.error(`ERROR: ${e}`);
  if (errors.length) { console.error(`${errors.length} error(s) in ${dir} or ${mirrorDir}`); process.exit(1); }
  console.log(`OK: ${dir} is a valid Agent Plugin ${SPEC_VERSION} package and ${mirrorDir} matches it (${warnings.length} warning(s))`);
}
