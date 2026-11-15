# Domain docs

## Before exploring

Read the root `GLOSSARY.md` and the ADRs in `docs/adr/` that touch the area
you are working in. If either is absent, proceed silently; domain-modeling
creates documentation when terms or decisions are resolved.

## Layout

This is a single-context repo:

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/`: architectural decisions.

## Use the vocabulary

Use the terms defined in `GLOSSARY.md` in issues, proposals, hypotheses, and
test names. Avoid synonyms the glossary rejects. If a concept is missing,
reconsider the terminology or note the gap for domain-modeling.

## Flag ADR conflicts

If a proposed change contradicts an existing ADR, identify the ADR and explain
why it may be worth reopening.
