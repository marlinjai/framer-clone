---
title: Custom code author API
description: How to write a sandboxed custom code block, the lumitra bridge, the declaration, the limits and every refusal
order: 3
summary: Reference for authors of sandboxed custom code blocks in Lumitra Sites. A block's HTML and JavaScript run in an isolated frame on the published page and talk to the page only through window.lumitra (read, onState, setState, emit, resize, ready) within what the block declares. Covers the declaration, the limits, what the editor and the server refuse and why, and how a block falls back.
type: documentation
tags: [framer-clone, custom-code, sandbox, author-api]
projects: [framer-clone]
---

# Custom code author API

A custom code block runs your own HTML and JavaScript on a published page, inside an isolated frame
(an `iframe` with `sandbox="allow-scripts"`, served from its own origin). Your code cannot reach the
page, its cookies, the visitor's storage or the network. It talks to the page through one object,
`window.lumitra`, and only about what the block **declares**. Design decisions: plan
`docs/plans/2026-11-02-sandboxed-custom-code.md`.

Custom code is off until a site is switched on (slice C7). Writing a block needs the workspace admin
role. On a server where `CUSTOM_CODE_AVAILABLE` is not `1`, the editor offers no block at all.

## Adding a block

1. In the Components panel, choose **Custom code** (it adds the block inside or after the selected
   element). The new block holds no code yet and shows its **fallback**: the elements inside it, a
   paragraph in the site's language to begin with. Visitors see the fallback whenever the code cannot run.
2. In the properties panel's **Custom code** section, give the block a title. The title is what a screen
   reader announces for the frame, so it is required.
3. Write the code, choose what it reads, changes and fires, and press **Save code**. The page is saved
   first, then the code is stored under its hash. Publish the page to put it live.

The code never runs inside the editor. The canvas shows a tile with the title. The standalone preview
(`/projects/<id>/preview`) shows the fallback. **Show the fallback on the canvas** lets you edit the
fallback's elements in place. The switch lives in the editor only and is never saved.

The editor field is CodeMirror. Tab and Shift+Tab move to the next or previous field, as in any form.
Indent with Cmd+] (Ctrl+] on Windows and Linux) and outdent with Cmd+[. If the editor cannot load, a
plain text field takes its place and saves the same way.

## The document

What you write is the body of an HTML document. The box puts a small script in front of it, the
**shell**, which sets up `window.lumitra`. The box serves the document with this policy:

- scripts and styles inline only (`<script>` and `<style>` in the document);
- images, fonts and media as `data:` addresses only;
- no network at all (`fetch`, `XMLHttpRequest`, WebSocket, WebRTC and forms all fail);
- no cookies and no storage (`localStorage` and `indexedDB` throw in the frame's opaque origin), no access to `parent`'s document.

## `window.lumitra`

| Call | What it does |
| --- | --- |
| `lumitra.ready()` | A promise that resolves once the page has connected and sent every declared read its first value. Start here. |
| `lumitra.read(id)` | The latest value of a state the block **reads**, or `undefined` before `ready()`. |
| `lumitra.onState(id, fn)` | Calls `fn(value)` with every new value of a read state. It calls once at once with the value already known. Returns a function that stops it. |
| `lumitra.setState(id, value)` | Asks the page to set a state the block **can change**. The page checks the value against the state's type and its range (`min`, `max` or the choice's options), and drops a value that does not fit. Nothing is coerced or clamped. |
| `lumitra.emit(name)` | Fires `custom:<name>`, an event the block **fires** (`name` or `custom:name`). An interaction on the page reacts to it with the trigger "A custom event". |
| `lumitra.resize(height)` | Asks for a height in pixels, up to 10,000. Only for sizing **Follows its content**. |

Example, a counter that steps a number state and reacts to an on or off state:

```html
<button id="step" type="button">Next</button>
<p id="label"></p>
<script>
  lumitra.ready().then(function () {
    lumitra.onState('open', function (open) {
      document.getElementById('label').textContent = open ? 'Menu is open' : 'Menu is closed';
    });
    document.getElementById('step').addEventListener('click', function () {
      lumitra.setState('step', (lumitra.read('step') || 0) + 1);
      lumitra.emit('stepped');
    });
  });
</script>
```

Writes, resizes and emits are **coalesced**. The shell sends the latest value of each state, the latest
height and each event name once, about every 50 milliseconds, writes first. You may call `setState` from
every animation frame or every `input` of a slider: the last value always arrives. Several emits of one
name within a batch arrive as one, so to count, write a number state instead of emitting.

Calls made before the page connects wait and are sent once it does. An uncaught error in your code is
reported to the page's console, shortened, at most once a second.

## The declaration

The **Values it reads**, **Values it can change**, **Events**, **Height** and **Visitors can click into it**
controls make up the block's declaration. It is stored with the code, and the hash covers both: changing
the declaration alone stores a new block.

| Field | Meaning |
| --- | --- |
| reads | State ids the frame receives. Only on or off (boolean), number and choice states that stand on the block or above it. A text state never crosses into a frame. |
| writes | State ids the frame may set, under the same rule. |
| emits | Event names, lower case letters, digits, `-` and `_`, starting with a letter or digit, stored as `custom:<name>`. |
| sizing | **The box's own size** (`fixed`): the frame fills the block. **Follows its content** (`content`): the frame takes the height it asks for with `resize`. |
| interactive | On: visitors can click, scroll and type into the frame. Off: every pointer and key passes through it to the page, as for a scene behind the content. |

Each list holds at most 32 entries. When an id is declared on several levels, the declaration nearest the
block is the one used, as the page itself does.

## Limits

| Limit | Value |
| --- | --- |
| Code plus declaration, one block | 256 KB of UTF-8 (an umlaut counts two bytes, most emoji four) |
| All the code a site keeps (its working copy and its kept revisions) | 1 MB |
| Blocks drawn per page | 4. The renderer leaves the rest on their fallback. |
| Saves of new code per site | 30 an hour |
| Messages from a frame | 64 KB each, 30 a second. Past 90 the frame is removed. |
| Height through `resize` | 10,000 pixels, 10 a second |

## What makes a block show its fallback

The page removes a frame for good, and leaves the fallback, when the frame:

- does not say hello within 5 seconds of loading, or loads twice;
- leaves three pings (one every 5 seconds) unanswered, for example in an endless loop;
- sends more than 90 messages in a second;
- takes the keyboard from the visitor three times while they type in the page. A frame that is not
  interactive is removed the first time.

A block also shows its fallback when its hash was taken down, when the site's custom code is switched
off, when the server's kill switch `CUSTOM_CODE_DISABLED` is not `0`, and on any browser that refuses
the frame.

## Refusals when saving

Every refusal says why, in the panel, and the route answers with a code and a sentence.

| Code | Status | When |
| --- | --- | --- |
| `custom_code_unavailable` | 404 | The server's `CUSTOM_CODE_AVAILABLE` is not `1`. |
| `permission_denied` | 403 | You are not a workspace admin. |
| `forbidden` | 403 | The project does not exist or is not yours. |
| `title_invalid` | 400 | The title is empty, longer than 200 characters, or holds invisible or direction characters. |
| `document_empty` | 400 | The code is empty or only spaces. |
| `document_nul` | 400 | The code holds a NUL character. |
| `document_not_well_formed` | 400 | The code is not valid text (an unpaired surrogate). |
| `declaration_invalid` | 400 | The declaration does not follow the rules above. |
| `bad_json`, `bad_body` | 400 | The request is not what the route takes. |
| `too_large` | 413 | Code plus declaration is over 256 KB, or the request over 1 MB. |
| `site_budget` | 413 | Storing it would bring the site's code over 1 MB: the code the saved pages and components name plus the code any of the last 30 published versions names. A removed block stops counting once the page is saved if it was never published, and otherwise once none of the last 30 published versions holds it. |
| `branch_site` | 409 | The project is a branch. Custom code is written on the main site. |
| `custom_code_off` | 409 | The site's custom code is switched off. |
| `node_not_saved` | 409 | The saved page does not hold the block yet. Wait for "Saved" and save again. |
| `not_a_block` | 409 | The element is not a custom code block. |
| `replaces_mismatch` | 409 | The request says it replaces code the saved block does not name. Copy the code, reload the editor (a reload closes unsaved edits) and save again. |
| `blocked` | 410 | This exact code was taken down. |
| `declaration_state` | 422 | The declaration names a state that is not in reach of the block, or a text state. |
| `rate_limited` | 429 | 30 saves in the last hour. The answer's `Retry-After` header and the sentence say when. |
| `authz_unavailable` | 503 | The permission service did not answer. Nothing was saved; try again shortly. |
| `custom_code_failed` | 500 | An unexpected failure. Nothing was saved. |

A request without a session gets the sign-in answer every editor route gives (401). Reading one block
(`GET ?sha256=`) answers `bad_hash` (400) for a malformed hash and `blob_not_found` (404) when this site
holds no code under it, which is also what a branch answers for main's blocks.

Saving the same code and declaration again stores nothing new and answers `200` (a new one is `201`).
A change of the title alone is stored on the page, not as new code.
