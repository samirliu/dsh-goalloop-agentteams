# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

**single-context** — this repo keeps one shared domain document at the repo root, and one architecture-decision record directory at `docs/adr/`. There is no `CONTEXT-MAP.md` and no per-subproject domain document: the whole repository is one context. (`CONTEXT.md` is the glossary/domain file this workspace uses; if a `GLOSSARY.md` appears at the root later it plays the same role.)

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the shared domain glossary and vocabulary, or
- **`GLOSSARY.md`** at the repo root, if that is the file that exists instead.
- **`docs/adr/`** — read the ADRs that touch the area you're about to work in.
- The repo's `skills/` and `docs/` prose where it names domain concepts; prefer its vocabulary over invented synonyms.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved — this setup run deliberately created neither `CONTEXT-MAP.md` nor any `CONTEXT.md`.

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md          ← shared glossary / domain model (created on first real entry)
├── docs/
│   ├── adr/            ← architecture decisions
│   └── agents/         ← this skill configuration
└── src/
```

Multi-context repo (a root `CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context) does **not** apply here.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the domain document. Don't drift to synonyms it explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
