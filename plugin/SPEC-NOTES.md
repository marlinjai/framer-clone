# Agent Plugins spec notes for lumitra-sites

These are the rules `plugin/validate.mjs` enforces, with the sources they were read from, so an integrator can re-verify against upstream. The validator and most of these notes are carried over from Lumitra Studio's plugin (`lumitra-studio/plugin/SPEC-NOTES.md`, fetched 2026-08-20); what differs for Lumitra Sites (a remote server, a header credential, mirror files kept in this repository) is in "What differs from Studio" below, re-checked on 2026-11-03.

## Sources

| What | URL |
|---|---|
| Agent Plugins overview | https://agent-plugins.org/ |
| Normative spec v1.0.0 (section numbers below refer to it) | https://agent-plugins.org/specification |
| Manifest authoring page | https://agent-plugins.org/plugin-authors/manifest |
| MCP authoring page | https://agent-plugins.org/plugin-authors/mcp-servers |
| Canonical manifest schema (JSON Schema 2020-12) | https://agent-plugins.org/schemas/1.0.0/plugin.schema.json |
| Canonical mcp.json schema | https://agent-plugins.org/schemas/1.0.0/mcp.schema.json |
| Spec repository | https://github.com/agentplugins/agent-plugins-spec |
| Agent Skills spec (SKILL.md) | https://agentskills.io/specification |
| Agent Skills reference validator | https://github.com/agentskills/agentskills/tree/main/skills-ref |
| Claude Code MCP configuration (variable expansion) | https://code.claude.com/docs/en/mcp |
| Claude Code plugin manifest | https://code.claude.com/docs/en/plugins-reference |

## Plugin layout (spec sections 6.1, 7.1, 7.2)

```
<plugin>/
  plugin.json              required, at the ROOT (not in a subdirectory)
  skills/<name>/SKILL.md   zero or more; only immediate children of skills/ are scanned
  mcp.json                 optional, at the root
  <reverse.domain>/        optional client extension directories
```

- Skills: "Each immediate child directory containing a path named exactly `SKILL.md` that resolves to a regular file is treated as one skill." Clients MUST NOT recurse deeper. A non-conforming skill is skipped; it does not fail the plugin.
- "`plugin.json` cannot override these locations or contain inline component configuration" (6.1). So the manifest does NOT list skills or MCP servers. See "Ambiguities resolved" below.

## plugin.json (schema `plugin.schema.json`, spec section 5)

Top-level fields are CLOSED (`additionalProperties: false`). Permitted: `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`.

| Field | Required | Rule |
|---|---|---|
| `$schema` | yes | const `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` |
| `name` | yes | 1-64 chars, pattern `^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$` (lowercase a-z, 0-9, `-`, `.`; alphanumeric start and end; no `--` or `..`) |
| `version` | no | string; SHOULD be Semantic Versioning (10.2) |
| `description` | no | string |
| `author` | no | object with optional `name`, `email`, `url` strings; no other keys |
| `homepage`, `repository`, `license` | no | strings; license: SPDX identifier recommended |
| `keywords` | no | array of strings |
| `extensions` | no | object keyed by reverse-domain namespace, each value an object; clients ignore namespaces they do not implement (8.1) |

Unknown fields: clients MUST report and ignore them and continue loading (5.2). The validator here treats them as errors anyway, because we want to ship a clean manifest.

## mcp.json (schema `mcp.schema.json`, spec sections 7.2.1 and 9)

Top level: exactly `$schema` (const `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`) and `mcpServers` (object: server id to server object). No other top-level fields. The version in its `$schema` MUST match the one in `plugin.json` (10.1).

| `type` | Required | Optional | Notes |
|---|---|---|---|
| `stdio` | `command` | `args` (string[]), `env` (string map), `cwd` | `command` is ONE executable token: a bare name (`npx`) or a plugin-relative `./path`; never a shell string. `cwd` must match `^(?:\./|\$\{PLUGIN_ROOT\}(?:/|$)|\$\{PLUGIN_DATA\}(?:/|$))`; omitted cwd = plugin root. |
| `streamable-http` | `url` | `headers` (string map) | absolute http(s) URL, no userinfo, no fragment |
| `sse` | `url` | `headers` | legacy HTTP+SSE |

- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded by the client in `args` elements, `env` values and `cwd` only (9.2). Not in `command`, not in env keys.
- `env` MUST NOT contain keys `PLUGIN_ROOT` or `PLUGIN_DATA` (schema `propertyNames`).
- "Agent Plugins 1.0.0 defines no portable OAuth or credential-reference fields. Authentication remains client-managed." There is no standard way to declare "this server needs the user's API key". See ambiguities.

## SKILL.md (Agent Skills spec)

YAML frontmatter followed by a Markdown body:

| Field | Required | Rule |
|---|---|---|
| `name` | yes | 1-64 chars, `a-z`, `0-9`, `-` only; no leading/trailing hyphen; no `--`; MUST equal the parent directory name |
| `description` | yes | 1-1024 chars, what it does and when to use it |
| `license` | no | short license name or bundled file reference |
| `compatibility` | no | 1-500 chars, only if there are environment requirements |
| `metadata` | no | map of string to string |
| `allowed-tools` | no | space-separated string, experimental |

Optional dirs: `scripts/`, `references/`, `assets/`. Keep SKILL.md under 500 lines, references one level deep, relative paths from the skill root.

### Frontmatter is real YAML, not `key: value` lines

The frontmatter is a YAML document, so a `description` may be written as a block
scalar. This is not theoretical: 30 of the 109 SKILL.md files in Anthropic's own
published plugin marketplace use `description: >` or `description: >-`, and
clients load them. `plugin/validate.mjs` therefore reads, and is tested against,
every form a real YAML client accepts for these fields:

| Form | Example | Result |
|---|---|---|
| plain | `description: one line` | the line |
| plain continuation | `description: one` + deeper-indented lines | folded onto one line |
| quoted | `description: "x"`, `'x'`, and either running over several lines | unquoted and folded |
| folded block | `description: >` | line breaks folded to spaces, blank lines kept as breaks |
| literal block | `description: \|` | line breaks kept |
| chomping | `>-` `\|-` strip, `>` `\|` clip to one break, `>+` `\|+` keep all | as YAML defines |
| indentation indicator | `>2`, `\|2-`, `>-2` | block indent is explicit rather than detected |
| block sequence | `allowed-tools:` + `- Bash(x *)` lines | array (which the string rule below then rejects, clearly) |

Shapes deeper than this field set (a mapping inside `metadata`, a sequence of
mappings) are consumed and typed `null` instead of being reported line by line,
so an author gets the one type error that applies (`metadata must be a
string-to-string map`) rather than a wall of "cannot parse frontmatter line".

The reader stays dependency-free on purpose: `node plugin/validate.mjs` has to
run against a bare checkout of the plugin directory with no install step, which a
`yaml` dependency would break.

## What differs from Studio

1. **A remote server, two type names.** The server is the hosted endpoint `https://app.lumitra.co/api/mcp`, so `mcp.json` declares it as `streamable-http`, the spec's name. Claude Code's `.mcp.json` calls the same transport `http` and rejects `streamable-http`, so Studio's trick of shipping one file under both names does not work here. `plugin/lumitra-sites-mirror/.mcp.json` is the Claude Code file, and `validateMirror` requires it to carry the same servers, address and headers as `mcp.json` with only the type name translated.

2. **The credential is a header, from an environment variable.** `headers.Authorization` is `Bearer ${LUMITRA_SITES_API_KEY}`. The spec defines no credential field and only guarantees `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` (9.2), so expansion of any other variable is client behaviour:
   - **Claude Code** expands `${VAR}` and `${VAR:-default}` in a server's `url` and `headers`, plugin servers included, at connect time, so the key never lands in a configuration file. With the variable unset and no default, the config still loads, `claude mcp list` shows `Missing environment variables: LUMITRA_SITES_API_KEY` for the server (verified 2026-11-03 with Claude Code 2.1.316), and the literal text `${LUMITRA_SITES_API_KEY}` is sent as the bearer.
   - **The server** refuses that literal before it reaches auth-brain (it fails the key shape check in `verifyCompanyKey`, `src/lib/auth-machine.ts`) and answers 401 `a valid company API key is required` (verified against production on 2026-11-03). So a client that does not expand the variable fails closed with a clear error; it never sends anything but that literal. It also counts toward the per-address refused-key throttle.
   - **Cursor** uses `${env:VAR}` instead; the README shows that form.
   - The validator requires every header whose name looks like a credential (authorization, token, key, secret, cookie) to take its value from a `${NAME}` reference, and every `${NAME}` in a url or header to be declared in `extensions["co.lumitra.sites"].requiredEnv` or `optionalEnv` (and every declared one to be used). Claude Code's own `userConfig` with `sensitive: true` (a masked prompt, stored in the system keychain) was considered and not used for now: the environment variable form also works for `claude mcp add` and for other clients, so one setup serves every path the README documents. It remains an option for a later version.

3. **The mirror files live here.** Studio's mirror repository holds hand-written Claude Code manifests that its sync skips, which is how they drifted to an old version (2026-09-19). Here every file of the mirror comes from this repository: `plugin/lumitra-sites` (the payload) and `plugin/lumitra-sites-mirror` (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `LICENSE`). `scripts/sync-plugin-repo.sh` lays both into one tree and compares or pushes the whole of it, and `validateMirror` requires one version in `plugin.json`, the mirror's `.claude-plugin/plugin.json` and its marketplace entry, and no file in both folders. The payload's `README.md` is the mirror's README.

4. **Version.** The plugin starts at `0.1.0` and is versioned on its own: there is no npm package to follow (Studio pins to `@marlinjai/studio-mcp`), and the server's `serverInfo.version` (`src/server/mcp/handler.ts`) describes the endpoint, not the skills. Bump `plugin.json` and the two mirror files together when the skills or the server entry change; the validator fails when they differ.

5. **Marketplace name.** The mirror's marketplace is named `lumitra-sites`, not `lumitra` like Studio's, because Claude Code keys marketplaces by name and two different repositories with the same name collide for a user who adds both. Listing Sites inside Studio's `lumitra` marketplace as well is a change in Studio's mirror (a plugin entry with a GitHub source pointing at `marlinjai/lumitra-sites-plugin`).

6. **`claude plugin validate` is not run in CI.** It needs the Claude Code binary. It was run by hand on the composed mirror tree on 2026-11-03 and passed; its plugin directory checks warned only about a missing listing icon and privacy policy URL, which matter for a submission to Anthropic's directory, not for loading.

## Ambiguities resolved (carried over from Studio, still true here)

1. **Listing the skills and the server in the manifest.** The v1.0.0 manifest schema is closed and section 6.1 forbids inline component configuration, so the component list lives under `extensions["co.lumitra.sites"]` and the validator cross-checks it against `skills/` and `mcp.json`.
2. **License.** `MIT`; the LICENSE text lives in `plugin/lumitra-sites-mirror/LICENSE` and ships in the mirror.
3. **Client install paths.** agent-plugins.org documents no per-client install directories; the README gives the portable rule plus the Claude Code and Cursor mechanics and says which part is client-specific.
