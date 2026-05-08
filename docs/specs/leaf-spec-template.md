---
name: <slug-matching-filename>
track: <cms|multiplayer|data-bindings|static-html|ai-pattern-a|lumitra-studio>
wave: <1|2|3>
priority: <P0|P1|P2>
status: draft
depends_on: []
estimated_value: <1-10>
estimated_cost: <1-10>
owner: <unassigned|name|agent-id>
---

# <Spec title>

## Goal

One paragraph. What is this spec trying to achieve and why does it matter for Phase 1.

## Scope

**In:**
- bullet
- bullet

**Out (explicitly deferred):**
- bullet (to wave N or Phase 2)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/...` | new / edit / delete | <what changes> |

## API surface

```ts
// Types, function signatures, exported symbols this spec adds or modifies.
```

## Data shapes

```ts
// Schemas, JSON shapes, DB columns, MST node shape, Yjs shape, etc.
```

## Test plan

- [ ] Unit: <what is tested, in which file>
- [ ] Integration: <what flow, with what fixture>
- [ ] Manual: <if UI / drag-drop / interaction, what the human verifies>

## Definition of done

- [ ] Code lands and typechecks
- [ ] Tests pass (`pnpm test` and any spec-specific suites)
- [ ] No regressions in <relevant areas>
- [ ] Docs updated where the API surface changed
- [ ] Status field moved to `done` in STATUS.md

## Open questions

- <Decision-needed items the worker must NOT silently resolve. Surface to Marlin.>

## References

- Plan: `docs/plans/...`
- Memory: `memory/...`
- Code touchpoints: `src/...`
- External: <library docs URL if relevant>
