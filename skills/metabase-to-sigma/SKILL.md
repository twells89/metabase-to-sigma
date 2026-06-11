---
name: metabase-to-sigma
description: >-
  Migrate Metabase content to Sigma. Use when the user has Metabase questions,
  models, or dashboards and wants to recreate them in Sigma. Converts MBQL
  cards/models (+ database metadata) → Sigma data model and dashboards → Sigma
  workbooks, translating MBQL expressions/aggregations and flagging constructs
  with no clean Sigma analog. Discovery via the Metabase REST API (API key or
  session token) — works on open-source and Pro/EE alike.
user-invocable: true
---

# Metabase → Sigma migration

Convert Metabase **models + questions** into a Sigma **data model**, then convert the
**dashboards** that sit on them into matching Sigma **workbooks**. Translate what maps
cleanly; **flag what doesn't** (cum-sum/offset windows, saved segment refs, funnel/gauge
viz, click behaviors) instead of emitting wrong logic.

> **Status: extraction side production-validated** against a live 7k-card / 1.5k-
> dashboard Metabase Cloud estate (v1.61.4 — 100% pMBQL); the normalizer,
> template-tag handling, and field-id fallback chain come from that contact
> (`refs/design-notes.md` §9). **The Sigma BUILD path (POST DM + workbook) is
> still fixture-validated only — no end-to-end parity migration yet.** On your
> first live POST, diff real payloads against `refs/` and fix drift there first.

> Read `refs/` before relying on shapes: `design-notes.md` (translation surface +
> decisions + production findings), `rest-api.md` (endpoints + auth + version
> gotchas), `mbql-shapes.md` (real card/dashboard JSON structures incl. pMBQL),
> `expression-dsl.md` (MBQL → Sigma formula mapping table), `template-tags.md`
> (native {{tags}} → Sigma controls). For canonical Sigma data-model + workbook
> spec shapes, defer to the companion `sigma-data-models` / `sigma-workbooks` skills.

---

## Prerequisites

- **Metabase REST access** — an **API key** (v49+: Admin → Settings → Authentication →
  API keys; preferred, durable) or a username/password session. Capture either with
  `scripts/get-metabase-session.sh`. Open-source Metabase is fully sufficient — no
  Pro/EE features required (serialization export is EE-only; this skill doesn't use it).
- **Sigma** API token (via the `sigma-api` skill) to POST the data model + workbook.
- **The same warehouse on both sides.** Sigma reads the warehouse live; parity only
  means something when the Sigma connection reaches the database Metabase queries.
  (Metabase's bundled H2 Sample Database is NOT reachable from Sigma — pick content
  on a real warehouse, or land the data first.)
- **Node** for the converter (`converter/`: `npm install` once).

---

## Phase 0 — Discover (Metabase REST)

```bash
export MB_BASE="https://<host>"        # + MB_KEY, or MB_USER/MB_PASS
eval "$(scripts/get-metabase-session.sh)"
scripts/metabase-discover.sh databases                  # find the warehouse connection
scripts/metabase-discover.sh metadata 2 > metadata.json # FIELD IDS — required by the converter
scripts/metabase-discover.sh collections                # folder tree
scripts/metabase-discover.sh items 5                    # cards/models/dashboards in a collection
scripts/metabase-discover.sh card 123      > orders-model.card.json
scripts/metabase-discover.sh dashboard 9   > exec.dashboard.json
```

- **Always fetch `metadata <dbId>` first** — MBQL references columns by integer field
  id; without the metadata map the converter falls back to per-card `result_metadata`
  names (lossy, warned).
- Models (`type: "model"`, or `dataset: true` pre-v50) are the semantic layer — fetch
  them even when no dashboard uses them directly; questions stack on them via
  `source-table: "card__N"`.
- For estate-wide inventory + a migration shortlist, run the `metabase-assessment`
  skill first — its `specs/` directory feeds this skill directly.

## Phase 1 — Convert models/cards → Sigma data model

```bash
cd converter && npm install
node --import tsx/esm cli.ts ../bundle.json --metadata ../metadata.json \
  --connection <SIGMA_CONN> --database <DB> --schema <SCHEMA>
```

`bundle.json` is `{ "cards": [ <card JSONs> ] }` (or pass a single card file). Emits
the Sigma data-model JSON on stdout; stats + warnings on stderr. Read the warnings
aloud to the user — they are the parts that need manual authoring (cum-sum/offset
windows, segment/metric refs to inline, binned breakouts, field-filter SQL tags).

## Phase 1.5 — Reuse an existing DM? (avoid sprawl)

Before POSTing a NEW data model in Phase 2, check whether an existing Sigma DM already
covers the same warehouse tables (don't add a 4th near-identical DM for the same schema):

```bash
python3 scripts/metabase-dm-signature.py --dm-spec dm.json --out dm-signature.json
eval "$(scripts/get-token.sh)"
ruby scripts/find-or-pick-dm.rb --workbook-signature dm-signature.json \
  --out dm-match.json --auto-pick           # exit 0 = candidate ≥ min-score
```

- **Score ≥ 0.6** → **ASK the user** reuse-vs-new: surface the candidate name, matched
  cols (N/M), and the inherited-extras warning. If they reuse, run a **shape preflight**
  (read the candidate spec back; every column the dashboard references must resolve with
  no `type=error`), then **skip Phase 2** and run Phase 3 against the matched
  `recommended_dm_id`.
- **Score < 0.6** → POST new (Phase 2) and TELL the user no reusable DM was found.

## Phase 2 — POST the data model + read back ids (hard gate)

```bash
eval "$(scripts/get-token.sh)"                 # SIGMA_BASE_URL + SIGMA_API_TOKEN
node scripts/post-and-readback.mjs --type datamodel --spec dm.json \
  --folder <folderId> --out dm-map.json
```

POSTs to `/v2/dataModels/spec`, reads the spec back, and **fails on any `type=error`
column** (a spec can POST 200 yet have formulas that don't resolve at query time — the
readback scan catches it, derived view included). `dm-map.json` carries the real
`dataModelId` + element ids (Sigma reassigns them on POST). Do not proceed past a
non-zero exit.

## Phase 3 — Convert the dashboard → Sigma workbook, wired to the DM

```bash
node --import tsx/esm cli.ts ../exec.dashboard.json --metadata ../metadata.json --dm <dataModelId> > wb.json
node scripts/remap-wb-to-dm-ids.mjs --wb wb.json --dm-id <dataModelId> --out wb.remapped.json
node scripts/post-and-readback.mjs --type workbook --spec wb.remapped.json --folder <folderId>
node scripts/apply-layout.mjs --workbook <workbookId>
```

Each dashcard becomes the matching Sigma element sourced from the migrated DM element
(KPI/bar/line/area/pie/combo/scatter/table/pivot/map; text cards → text elements;
funnel/gauge/progress/waterfall → flagged tables). The converter emits each element's
`source.elementId` as the source card/table **name** (a placeholder) —
`remap-wb-to-dm-ids.mjs` rewrites those to real ids from Phase 2's readback. Dashboard
**parameters** become Sigma controls wired by controlId, with per-card targets from
`parameter_mappings`. Metabase's 24-col dashcard grid maps 1:1 onto Sigma's layout —
`apply-layout.mjs` writes it and confirms it survives readback.

## Phase 4 — Verify parity (hard gate — the real proof)

```bash
node scripts/assert-parity.mjs --plan --type workbook --id <workbookId>   # emits per-element SQL
# run each via mcp-v2 query (or the Sigma query API), save totals to actual.json
node scripts/assert-parity.mjs --check --actual actual.json --expected metabase.json --tol 0.01
```

A migration is **GREEN only when** (a) `assert-parity --check` passes AND (b) the
workbook came back with a clean layout (`apply-layout.mjs` reported
`layoutOnReadback: true`) — never on a 200 POST alone. `metabase.json` = the numbers
from the Metabase cards (run each card via `POST /api/card/{id}/query` — the one
non-GET this skill may use, read-only in effect — or read them off the dashboard).
Mind caching: Metabase serves cached results by default; Sigma reads live. A delta
that matches rows landed since the cache filled is freshness, not a failure.

---

## What converts, what's flagged (never faked)

**Converted (per the contract in `refs/expression-dsl.md` — fixture-tested; extraction
production-validated, Sigma POST shapes pending first live build):**
- **pMBQL ("lib/" MBQL)** — the modern wire format (100% of the reference production
  estate) — normalized to legacy MBQL at intake (`converter/pmbql-normalize.mjs`;
  the server's `legacy_query` is preferred when present). Multi-stage queries are
  flagged, never mistranslated.
- **MBQL questions/models** → DM elements: explicit `joins` → join sources
  (left/right/inner/full), `expressions` → calc columns, `aggregation` → metrics
  (incl. named `aggregation-options`, `count-where`/`sum-where` → `CountIf`/`SumIf`,
  `share` → ratio + `%` format), temporal-unit breakouts → `DateTrunc` columns.
- **FK metadata → DM relationships** (+ derived join view; the relationship's own key
  column is skipped — a cross-element join-key passthrough compiles to type `error`).
- **Native SQL questions** → Custom SQL elements (no element name, bare `[Display Name]`
  refs); the dialect passes through verbatim (same-warehouse migrations — e.g.
  BigQuery `project.dataset.table` refs — are near-verbatim). Plain
  `{{text/number/date/boolean}}` template tags keep their `{{tag}}` (Sigma custom SQL
  uses the SAME syntax) and emit matching controls; **field-filter (dimension) tags**
  are neutralized to `1=1` + recreated as control + element filter; `{{#card}}` tags
  are inlined when the referenced card is a tag-free native card in the input set;
  optional `[[…]]` blocks are kept-active or dropped per Metabase's empty-value
  semantics (always warned). See `refs/template-tags.md`.
- **Dashboards** → workbooks: one page per tab, 24-col grid 1:1, scalar/smartscalar →
  KPI (`value: {columnId}`), pivot → pivot-table (`rowsBy`/`columnsBy` `{id}` objects +
  bare-string `values`), `row` display → horizontal bar, maps → region-/point-map,
  text/heading cards → text elements (markdown carries over), parameters → controls +
  per-card target filters. Parameters that drive native template tags (the DOMINANT
  production pattern) are recorded in the result's `parameterWiring` + ONE aggregated
  warning per parameter.
- **Formats**: `column_settings` (currency incl. symbol, decimals, prefix/suffix) →
  Sigma d3 formats first, name/formula heuristics second; `series_settings` titles
  rename series (colors flagged); `table.column_formatting` single threshold rules →
  `conditionalFormats` (gradient/range scales flagged).

**Flagged with a warning (and a readable placeholder), never faked:**
`cum-sum`/`cum-count`/`offset` (rebuild with `CumulativeSum`/window calcs in the
date-grouped consuming element), `["segment", id]` / legacy `["metric", id]` refs
(inline their MBQL from `/api/segment/{id}` / `/api/legacy-metric/{id}`), binned
breakouts (→ `BinFixed`/`BinCount`), multi-stage queries (→ chained Sigma elements),
`click_behavior` (→ Sigma actions, manual), smartscalar previous-period comparisons,
`object` detail views (→ flagged detail table), and viz with no native Sigma element:
**funnel, gauge, progress, waterfall, sankey** → flagged table. Unknown MBQL ops emit
`/* unmapped: <op> */` + a loud warning.

## Security: Row-Level Security (sandboxing)

Row security is **never silently dropped and never silently ported** — and it is handled
by the **skill**, not baked into the converted model. Metabase **sandboxing is Pro/EE
only** (`GET /api/mt/gtap` lists sandboxes; group-based). The converter only **detects
and reports** (`security.json` + a loud `SECURITY:` line) when sandbox data is provided;
on OSS there is nothing to detect — but **ask the customer anyway** (RLS is sometimes
faked with per-group collections + duplicated filtered questions; inventory those by hand).

**Flow (only when security was detected or found manually — zero overhead otherwise):**
1. Convert + post the DM. Capture `dataModelId` + `security.json`
   (manual entries use the same shape: `[{ "type": "row-filter", "name": …, "expression": …, "groups": […] }]`).
2. **Gate (opt-in/out, default Port).** Plain-English summary of each rule + proposed
   Sigma user-attribute mapping → **Port** / **Customize** / **Skip**. Reuse existing
   Sigma user attributes/teams before creating new ones.
3. Provision + apply with the shared engine:
   ```bash
   eval "$(scripts/get-token.sh)"
   python3 scripts/apply_sigma_rls.py --from-security security.json --dm-id <id>            # plan only
   python3 scripts/apply_sigma_rls.py --from-security security.json --dm-id <id> --provision --apply
   ```
4. Assign per-user attribute values from Metabase group membership
   (`GET /api/permissions/group/{id}` lists members with emails — reconcile to Sigma members).

**Skip is loud:** opting out leaves the migrated model showing ALL rows to everyone. Confirm first.

## Gap scout — close a flagged expression

For a flagged construct you want to actually resolve (an offset window, a segment ref,
an unmapped op), spawn the **gap-scout subagent** (`scripts/gap-scout.md`): it proposes
a Sigma formula, validates it against the customer's live Sigma via
`scripts/scout-validate-and-persist.mjs`, and on success persists the rule to
`~/.metabase-to-sigma/learned-rules.json` — which the converter CLI auto-applies
*before* the built-in translator on the next run. If no formula validates, it returns
an opt-in `scripts/escalate-gap.py` command to file a tracking issue (ask first).
