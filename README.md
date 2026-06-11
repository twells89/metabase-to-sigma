# metabase-to-sigma

Claude Code plugin for migrating **Metabase** (open source or Pro/EE) to
**Sigma**, in the same format and phase structure as the
[sigma-migration-skills](https://github.com/twells89/sigma-migration-skills)
converters (Tableau, Power BI, Qlik, ThoughtSpot, QuickSight, Looker, Cognos).
Built standalone so it can graduate into that marketplace's `plugins/` once
live-validated.

## Status: discovery / extraction / scoring production-validated — conversion build path fixture-validated

The READ side has now survived first production contact: discovery, extraction,
and coverage scoring were **validated against a live 7k-card / 1.5k-dashboard
Metabase Cloud estate (v1.61.4)** — which is where the pMBQL normalizer, the
bulk-endpoint discovery fast path (>1hr → ~1min), the template-tag → control
mapping, and the field-id fallback chain all come from (see
`skills/metabase-to-sigma/refs/design-notes.md` §9).

**Honesty ledger:** the conversion BUILD path (POST data model + workbook to
Sigma) is still fixture-validated only — **no end-to-end Metabase→Sigma parity
migration has been run yet**. Until the loop below has completed once, treat
converter output as a strong first draft: post it, read it back, verify parity
— the skill's own hard gates assume nothing.

**The self-serve validation loop (no vendor gating — Metabase is OSS):**

```bash
# 1. Run Metabase locally, pointed at a Sigma-reachable warehouse (e.g. Snowflake)
docker run -d -p 3000:3000 --name metabase metabase/metabase
# → Admin → add the warehouse database; build a model + dashboard on real tables

# 2. Extract → convert → post → parity (Phases 0–4 in the skill)
# 3. Diff real API payloads against refs/mbql-shapes.md; fix drift in refs first,
#    then converter; add a fixture reproducing every discrepancy found.
```

## What's in the box

| Skill | What it does |
|---|---|
| [`skills/metabase-to-sigma`](skills/metabase-to-sigma/SKILL.md) | The converter: MBQL questions/models → Sigma data model; dashboards → Sigma workbooks. Phased (Discover → Convert → DM-reuse check → POST+readback gate → workbook wiring → parity gate), with RLS (sandboxing) port flow and a gap-scout loop for unmapped expressions. |
| [`skills/metabase-assessment`](skills/metabase-assessment/SKILL.md) | Read-only estate inventory + migration-readiness readout: bulk-fetches every card/dashboard definition via REST (7k-card estate in ~1 minute), scores each against the converter's exact coverage (auto/hint/manual/unhandled), renders a branded HTML report with an effort/wave plan. |

## Quick start

```bash
# Auth (API key preferred — Metabase v49+, Admin → Settings → Authentication → API keys)
export MB_BASE="https://<your-metabase>" MB_KEY="mb_…"
eval "$(skills/metabase-to-sigma/scripts/get-metabase-session.sh)"

# Assess the estate (read-only)
bash skills/metabase-assessment/scripts/discover-metabase.sh --out /tmp/mb-assess
node skills/metabase-assessment/scripts/score-coverage.mjs --in /tmp/mb-assess/specs --out /tmp/mb-assess
node skills/metabase-assessment/scripts/render-report.mjs --out /tmp/mb-assess   # → readout.html

# Migrate (see skills/metabase-to-sigma/SKILL.md for the full phase walkthrough)
```

Or install as a Claude Code plugin and just ask: *"migrate my Metabase dashboard
to Sigma"* / *"assess my Metabase estate."*

## Design contract

The conversion surface is specified in `skills/metabase-to-sigma/refs/`:

- `rest-api.md` — endpoints (incl. the bulk fast path), auth (`x-api-key`), version gotchas (`dashcards` vs `ordered_cards`, …)
- `mbql-shapes.md` — card/dashboard JSON + MBQL structures the converter parses, incl. the **pMBQL** ("lib/") format modern instances actually return
- `expression-dsl.md` — the MBQL-op → Sigma-formula mapping table (translated vs flagged)
- `template-tags.md` — native `{{tags}}` → Sigma controls (Sigma custom SQL uses the same `{{}}` syntax)
- `design-notes.md` — architecture decisions + §9 first-production-contact findings + the honesty ledger of still-unverified Sigma POST shapes

Core principle (shared with every sibling): **flag, never fake.** Anything
without a clean Sigma analog (cum-sum/offset windows, segment refs,
funnel/gauge/progress/waterfall/sankey viz, object detail views, multi-stage
queries, click behaviors) is surfaced as a loud warning with a readable
placeholder — never silently wrong numbers.

## License

MIT
