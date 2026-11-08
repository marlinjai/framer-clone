# Lumitra Sites Agent Plugin

An [Agent Plugin](https://agent-plugins.org/) (v1.0.0) that lets an AI agent build, edit and publish
websites in [Lumitra Sites](https://app.lumitra.co), the visual website editor at app.lumitra.co.
The agent reads a site, writes it in small validated batches on a version lock (so it never
overwrites a person editing the same site), checks the preview in a browser, and publishes only
when the person asks and approves it themselves.

It ships four components, discovered at the fixed locations the spec defines:

| Component | Path | What it does |
|---|---|---|
| Skill `build-a-site` | `skills/build-a-site/SKILL.md` | From a brief to a checked draft: design direction, vocabulary, structure, small batches, the preview at every breakpoint, publish only when asked. |
| Skill `edit-a-site` | `skills/edit-a-site/SKILL.md` | Targeted changes to an existing site: read first, outline, targeted batches, verify. |
| Skill `redesign-a-site` | `skills/redesign-a-site/SKILL.md` | Screenshot every breakpoint, critique, revise in passes, look again. |
| MCP server `lumitra-sites` | `mcp.json`, `.mcp.json` | The remote Lumitra Sites server at `https://app.lumitra.co/api/mcp` (Streamable HTTP). Nothing runs on your machine. |

## Tools

| Tool | What it does |
|---|---|
| `list_sites` | The sites of your company: id, name, status, last change, address. |
| `get_site` | A site's pages, breakpoints, theme tokens, components, address and current version. |
| `get_page` | An outline of one page with node ids and styles per breakpoint, in parts for long pages. |
| `describe_vocabulary` | How to write: the batch operations, the node format, tags, fonts, motion, and a site's own breakpoints, tokens and components. |
| `create_site` | A new, empty draft site with one home page. |
| `apply_batch` | Up to 200 edit operations in one all or nothing write, on the version you read. |
| `announce_sections` | Placeholders in the open editor for the sections you are about to write; writes nothing. |
| `clear_sections` | Removes the placeholders of a plan you announced. |
| `generate_page` | A page or section drafted from a brief by the editor's own generator. |
| `find_images` | Credited stock photos (Unsplash), with the props that place them. |
| `preview_url` | The editor preview link of the draft. |
| `publish` | Publish the draft, with the person's approval. |
| `list_revisions` | The published versions of a site, and which one is live. |
| `rollback` | Serve an earlier published version again, with the person's approval. |

## Before you start: a company API key

The server acts for one company: the company your API key belongs to. Keys come from
[auth.lumitra.co](https://auth.lumitra.co), Lumitra's sign-in service, not from the editor:

1. Sign in at auth.lumitra.co and open your company's settings, then **API Keys**.
2. Create a key with the **owner** or **admin** role. A key with the member role reaches no sites
   workspace, so every call with it is refused.
3. Give it the **`sites`** grant (the app it may use). Lumitra Sites must also be enabled for your
   company; while it is not, calls answer `sites_not_enabled`.
4. Copy the key once into your password manager or secrets store. Never paste it into a chat with
   an agent, into a repository or into a shared file.

Then set it in the environment that launches your agent client:

```bash
export LUMITRA_SITES_API_KEY="..."   # read from your secrets store, not typed into history
```

## Install

### Claude Code (plugin, recommended)

This repository is a plugin marketplace of one:

```
/plugin marketplace add marlinjai/lumitra-sites-plugin
/plugin install lumitra-sites@lumitra-sites
```

That installs the three skills and the server entry in `.mcp.json`:

```json
{ "type": "http", "url": "https://app.lumitra.co/api/mcp", "headers": { "Authorization": "Bearer ${LUMITRA_SITES_API_KEY}" } }
```

Claude Code expands `${LUMITRA_SITES_API_KEY}` from its own environment each time it connects, so
the key is never written into a configuration file. Start Claude Code from a shell where the
variable is set.

**When the variable is not set,** Claude Code still loads the server, shows a missing-variable
warning for it in `claude mcp list`, and sends the text `${LUMITRA_SITES_API_KEY}` itself as the
key. The server answers that with 401 `a valid company API key is required`, so every tool call
fails until you set the variable and restart Claude Code. Nothing else is sent.

### Claude Code (server only, without the skills)

```bash
claude mcp add --transport http lumitra-sites https://app.lumitra.co/api/mcp \
  --header "Authorization: Bearer $LUMITRA_SITES_API_KEY"
```

Here your shell expands the variable when you run the command, so the key itself is stored in
Claude Code's configuration file in plain text. The plugin does not do that, which is why it is
the recommended path. If you use this form, add `--scope user` or `--scope local` (the default),
never `--scope project`, which writes the key into the repository's `.mcp.json`.

### Cursor and other clients that send a header

Any MCP client that connects to a Streamable HTTP server and can send an `Authorization` header
works. In Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "lumitra-sites": {
      "url": "https://app.lumitra.co/api/mcp",
      "headers": { "Authorization": "Bearer ${env:LUMITRA_SITES_API_KEY}" }
    }
  }
}
```

and copy the `skills/` directories to where the client looks for Agent Skills. Variable syntax
differs per client (`${VAR}` in Claude Code, `${env:VAR}` in Cursor); a client that does not
expand it sends the literal text and gets the 401 described above.

### Clients that sign in with OAuth

claude.ai connectors and Claude Desktop's connectors sign in with OAuth. The Lumitra Sites server
accepts a company API key only and offers no OAuth sign-in yet, so those clients cannot connect
for now.

### Any other Agent Plugins client

Point the client's "add plugin from directory" flow at the repository root: `plugin.json` and
`mcp.json` are the [agent-plugins.org](https://agent-plugins.org/) 1.0.0 manifests (the server as
`streamable-http`), and `.claude-plugin/` plus `.mcp.json` are the Claude Code equivalents of the
same thing.

## How publishing works

The agent never publishes on its own say. `publish` and `rollback` need the person's approval:

- **In a client with a confirmation dialog** (MCP elicitation), the server asks the person there,
  with a summary of what goes live.
- **Otherwise** the tool answers `approvalRequired` with an `approvalUrl` and a `summary`. The
  agent gives both to the person, who opens the link on app.lumitra.co. Approving there needs the
  editor sign-in of someone allowed to publish that site, from the last 15 minutes (an older
  sign-in is asked to sign in again), and only the page's button records the decision. The agent
  then calls the tool again with the `approvalId`.
- An approval is for exactly one site at one version (and, for a rollback, one revision). Any
  edit after it, or five minutes passing, makes it invalid, and the agent has to ask again.
- Nothing the agent reads (page text, tool answers) can approve anything. The skills tell the agent
  never to open an approval link itself.

A publish can be undone: `rollback` serves an earlier published version again.

## Limits

- Writes: 60 a minute per key, one at a time; a batch holds at most 200 operations and is all or
  nothing. Reads: 300 a minute. Stock photo searches: 30 per ten minutes. Approval links: 10 per
  ten minutes. Generations: one at a time per key. Section announcements: 20 a minute, at most 20
  sections each and 3 announced plans per site; a plan ends three minutes after the agent's last
  call.
- Every write names the version it was based on. If anyone changed the site since, it is refused
  with `site_changed` and nothing is written; the agent reads again and redoes the change.
- Deleting sites or domains is not possible through the server.
- The preview link needs an editor sign-in at app.lumitra.co; an agent without a signed-in browser
  hands the link to you.

## Troubleshooting

| Answer | Meaning |
|---|---|
| 401 `a valid company API key is required` | No key, a wrong key, or the variable was not expanded (see above). |
| 403 `sites_not_enabled` | The key lacks the `sites` grant, or Lumitra Sites is not enabled for the company. |
| 403 `no_sites_workspace` | The company has no sites workspace the key can act in (a member key, or a brand-new company; retry shortly). |
| 429 / `rate_limited` | Too many calls; wait the seconds the answer names. |
| 503 `auth_unavailable` | The sign-in service is briefly unavailable; retry shortly. |

## Where this comes from

This repository is the published mirror of the plugin. It is generated from `plugin/lumitra-sites`
and `plugin/lumitra-sites-mirror` in the Lumitra Sites source repository
([marlinjai/framer-clone](https://github.com/marlinjai/framer-clone)) and checked against them on
every sync, so the two cannot drift. Changes go to the source repository. Lumitra Sites
itself (the server these tools call) is a hosted service at
[app.lumitra.co](https://app.lumitra.co); nothing in this repository runs it.

## Links

- Lumitra Sites: https://app.lumitra.co
- Agent Plugins spec: https://agent-plugins.org/specification
- Agent Skills spec: https://agentskills.io/specification
- Model Context Protocol: https://modelcontextprotocol.io
