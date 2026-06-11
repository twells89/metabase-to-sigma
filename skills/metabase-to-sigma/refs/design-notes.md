# Design notes — Metabase → Sigma

## Status: built from public docs, NOT yet live-validated

This plugin was authored from the public Metabase API/MBQL documentation and the
proven structure of its sibling converters (cognos/qlik/quicksight/…). Every
sibling was hardened by live parity testing; **this one has not had that pass
yet**. Treat the fixture-driven tests as shape checks, not proof. The
first live engagement should follow the validation loop in the repo README
(Docker Metabase → point at the Sigma-connected warehouse → migrate → parity).

## What maps to what

| Metabase | Sigma | Carrier |
|---|---|---|
| Database / table | DM `warehouse-table` element | `GET /api/database/{id}/metadata` (schema + field ids) |
| **Model** (curated dataset) | DM element (table / join / sql) | the model's own `dataset_query` |
| Question (MBQL) used by dashboards | DM element + metrics, or workbook element sourced from the DM | `dataset_query.query` |
| Question (native SQL) | DM **`sql` element** (Custom SQL) | `dataset_query.native.query`; `{{tags}}` → controls |
| MBQL `joins` | DM `join` source (left/right/inner/full) | join condition field pairs |
| FK metadata (`fk_target_field_id`) | DM **relationships** (+ derived view) | database metadata — Metabase's implicit-join graph |
| `expressions` (custom columns) | calc columns | `translateMbqlExpr` |
| `aggregation` (+ named wrappers) | element **metrics** | |
| Dashboard | workbook page(s) — one page per dashboard **tab** | `dashcards` grid → 24-col Sigma layout, 1:1 |
| Dashcard | chart/table/pivot/KPI/text element | `display` + `visualization_settings` |
| Dashboard `parameters` | workbook **controls** + targets | `parameter_mappings` name the filtered column per card |
| Collections | folder suggestion only (Sigma folder = POST `folderId`) | not auto-created |

## Decisions (and why)

1. **Field-id resolution is a hard prerequisite.** MBQL refs columns by integer
   id. The converter REQUIRES `--metadata metadata.json`
   (`GET /api/database/{id}/metadata`) and falls back to the card's
   `result_metadata` names when an id is missing — with a warning, because
   fallback names lose the table qualifier.
2. **Models become the DM; ad-hoc questions become workbook elements.** A
   Metabase model is the semantic-layer object — it maps to a DM element other
   elements source. Questions that only a dashboard uses convert as workbook
   elements wired to the DM element for their source table (keeps the DM small
   instead of one element per question — mirrors how the tableau/qlik
   converters treat sheet-level calcs).
3. **Nested questions (`source-table: "card__N"`)** convert to an element
   sourced from card N's element (`source: {kind:"table", elementId}`) when card
   N is in the input set; otherwise flagged with the card id so discovery can
   fetch it.
4. **Joins: MBQL explicit joins → DM join sources; FK metadata → DM
   relationships.** Two different Metabase features, two different Sigma
   carriers. The derived "join view" (`buildDerivedElements`) skips the
   relationship's own key column (cross-element passthrough of a join key
   compiles to type `error` — learned on qlik/oac, baked into `sigma-ids.ts`).
5. **Number formats**: `column_settings` (`number_style`, `decimals`, `suffix`)
   are the primary signal → Sigma d3 `formatString`; name/formula heuristics
   (`inferSigmaFormat`) only fill gaps. Mirrors the powerbi `format` lesson
   (beads-sigma-4q7k).
6. **Never faked**: cum-sum/offset/segment/metric refs, binning, click
   behaviors, funnel/gauge/progress/waterfall viz → loud warnings + readable
   placeholders (flagged table for unsupported viz), exactly like the cognos
   converter's contract. See `expression-dsl.md` for the full table.
7. **Charts**: `display` + `graph.dimensions`/`graph.metrics` (names matched
   through `result_metadata`) drive the Sigma viz: bar/row→bar (row = horizontal
   — Sigma's only `orientation` enum value), line→line, area→area,
   combo→combo (`series_settings` per-series display → dual-axis string/object
   yAxis form), scatter→scatter, pie→pie, scalar/smartscalar→kpi-chart,
   pivot→pivot-table (`pivot_table.column_split` → rowsBy/columnsBy `{id}`
   objects + bare-string values), map→region-map/point-map (`map.type`).
8. **Sandboxing (RLS) is EE-only and detect-only here**: `GET /api/mt/gtap`
   (sandboxes) + group memberships exist only on Pro/EE. When detected (or
   provided manually), the shared `apply_sigma_rls.py` engine ports it to Sigma
   user-attributes after the DM is posted — same opt-in/out gate as every
   sibling skill (never silent, never slow).

## Known unknowns to verify on first live run

- Exact `dashcards` field names on the customer's version (`size_x` vs `sizeX`).
- Whether `result_metadata` is always populated (cards never run may have none).
- `pivot_table.column_split` ref format variants (field refs vs column names —
  both handled, but the split is version-sensitive).
- Sigma funnel support: if/when a native funnel element verifies end-to-end,
  upgrade `funnel` from flagged→converted.
- **Native SQL column refs**: emitted as bare `[Display Name]` (the
  sigma-data-model-manager production rule). Prior qlik live work used
  `[Custom SQL/ALIAS]` where the SQL emits matching double-quoted aliases — if
  the first live POST rejects bare refs on a sql element, that prefix is the fix.
- **Join-source spec shape** `{kind:'join', joins:[{left, right, joinType,
  on:[{left,right}]}]}` follows the manager's contract; not yet round-tripped
  through a live POST from this converter.
- **100% stacking**: `stackable.stack_type:"normalized"` → `stacking:'percent'`
  with a verify-warning — the exact Sigma enum value is unconfirmed.
- **Layout application**: the workbook converter emits a 1:1 24-col `layout`
  HINT block (element ids change on POST, so pre-baked layout XML would break);
  `scripts/apply-layout.mjs` currently computes its own per-kind heights — add
  an exact-grid mode that consumes the hints to preserve the Metabase geometry.

## 9. First production contact (2026-06, Metabase Cloud v1.61.4 — 7,023 cards / 1,548 dashboards)

Empirical findings folded back into the converter + assessment:

- **pMBQL is the wire format.** 100% of the estate's `dataset_query`s were
  `{"lib/type":"mbql/query","stages":[…]}`. `pmbql-normalize.mjs` (intake, both
  skills) converts to the legacy shape; `legacy_query` (server's own
  down-conversion, a JSON string, present on ~70% of cards) is preferred when
  parseable. Sniff `lib/type` per card — a list response may mix formats.
- **Template tags are the dominant feature** (45% of cards): text 5,629 ·
  date 2,364 · dimension 1,914 · number 1,002 · card 384 · boolean 47; 1,705
  cards use optional `[[…]]` blocks. See `template-tags.md` for the mapping.
- **Dashboard parameters target tags, not columns**: 13,474 of 14,600
  `parameter_mappings` targets were `["variable",["template-tag",…]]`; 1,057
  `dimension`; 69 `text-tag` (flagged). 53% of dashboards carry parameters;
  17% use tabs; 6,189 virtual (text/heading) dashcards.
- **Display histogram** (cards): table 2999 · bar 1604 · line 1176 · combo 449 ·
  scalar 259 · pie 135 · row 130 · funnel 83 · area 67 · pivot 39 · object 37 ·
  waterfall 15 · sankey 13 · gauge 11 · scatter 3 · progress 3.
- **Engines**: BigQuery was the warehouse — `project.dataset.table` refs and
  trailing-comma SELECTs pass straight through, because the converter emits
  native SQL **verbatim** into Sigma custom SQL (same-warehouse migrations are
  near-verbatim; cross-warehouse needs a transpile pass first).
- **Auth**: API keys send `x-api-key` (NOT a Bearer header). Scoped keys can
  403 on `/api/database/{id}/metadata`; `GET /api/field/{id}` still worked for
  restricted DBs — hence the field-resolution fallback chain.
- **Discovery at scale**: the per-item walk took >1hr; bulk `GET /api/card`
  (110MB, streamed + split locally) + parallel dashboard GETs ≈ 1 minute.

**Unvalidated remainder (honesty ledger):** Sigma POST shapes for DM `control`
elements emitted from template tags (`text`/`number`/`date`/`switch`
controlTypes) and `conditionalFormats` built from `table.column_formatting`
are doc-derived — verify on the first live Sigma POST; no end-to-end
Metabase→Sigma parity migration has been run yet.
