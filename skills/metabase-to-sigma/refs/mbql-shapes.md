# Metabase source-format shapes (card + dashboard JSON, MBQL)

What the converter parses. Written from the public MBQL reference and API docs;
shapes marked ⚠ have version variants. **Not yet verified against a live
instance** — when you get one, diff a real `GET /api/card/{id}` against this and
fix drift here first (this file is the contract `converter/` + the assessment
scorer are built to).

## Card JSON (`GET /api/card/{id}`)

```jsonc
{
  "id": 123, "name": "Revenue by Month", "description": null,
  "collection_id": 5, "database_id": 2, "table_id": 45,
  "type": "question",            // "question" | "model" | "metric"  (⚠ v46–49: models use "dataset": true)
  "display": "line",             // table|bar|row|line|area|combo|scatter|pie|scalar|smartscalar|gauge|progress|funnel|waterfall|map|pivot|trend
  "dataset_query": {
    "type": "query",             // "query" = MBQL | "native" = SQL
    "database": 2,
    "query": { ... MBQL, below ... },
    "native": {                  // only when type = "native"
      "query": "SELECT ... WHERE category = {{cat}} AND {{date_range}}",
      "template-tags": {
        "cat":        { "name": "cat", "display-name": "Category", "type": "text", "default": "Widget" },
        "date_range": { "name": "date_range", "type": "dimension", "widget-type": "date/range",
                        "dimension": ["field", 80, null] }   // "field filter" — expands to a WHERE clause
      }
    }
  },
  "result_metadata": [           // per-result column — the id→name fallback when db metadata is absent
    { "name": "CREATED_AT", "display_name": "Created At", "base_type": "type/DateTime", "field_ref": ["field", 80, {"temporal-unit": "month"}] }
  ],
  "visualization_settings": { ... display config, below ... }
}
```

## MBQL query (`dataset_query.query`)

```jsonc
{
  "source-table": 45,                  // integer table id — OR "card__123" (a nested question/model)
  "joins": [{
    "source-table": 50,
    "alias": "Products",               // join alias — field refs carry {"join-alias": "Products"}
    "strategy": "left-join",           // left-join | right-join | inner-join | full-join (default left)
    "condition": ["=", ["field", 90, null], ["field", 91, {"join-alias": "Products"}]],
    "fields": "all"                    // "all" | "none" | explicit field refs
  }],
  "expressions": {                     // custom columns — see expression-dsl.md
    "Profit": ["-", ["field", 72, null], ["field", 73, null]]
  },
  "aggregation": [
    ["sum", ["field", 72, null]],
    ["count"],
    ["aggregation-options", ["sum-where", ["field",72,null], ["=", ["field",81,null], "Widget"]],
      { "name": "widget_rev", "display-name": "Widget Revenue" }]   // named aggregation wrapper
  ],
  "breakout": [ ["field", 80, { "temporal-unit": "month" }] ],     // group-bys
  "filter": ["and",
    ["=", ["field", 81, null], "Widget", "Gadget"],                 // = with >1 value ⇒ IN
    ["time-interval", ["field", 80, null], -30, "day"],
    ["segment", 7]                                                  // saved segment ref (flag)
  ],
  "order-by": [ ["desc", ["aggregation", 0]] ],
  "limit": 100,
  "fields": [ ["field", 72, null], ... ]                            // explicit column list (no aggregation)
}
```

**Field refs** — the core shape: `["field", <id-int | "name-string">, opts|null]`.
Opts: `"temporal-unit"` (`day|week|month|quarter|year|hour|…` — bucketing),
`"join-alias"`, `"base-type"` (set when the id is a literal name, e.g. columns of
a nested card), `"binning"` (`{"strategy":"num-bins","num-bins":10}` — numeric
histogram). Integer ids resolve via `GET /api/database/{id}/metadata`
(`fieldIndex`); string names resolve directly. `["expression", "Profit"]` refs a
custom column; `["aggregation", 0]` refs an aggregation by position (order-by only).

**Aggregations**: `count`, `sum`, `avg`, `distinct`, `min`, `max`, `median`,
`stddev`, `var`, `percentile` (`["percentile", field, 0.95]`), `share` (ratio of
rows matching a condition), `count-where`, `sum-where`, `cum-sum`, `cum-count`,
legacy `["metric", id]`. Named via the `aggregation-options` wrapper.

## Dashboard JSON (`GET /api/dashboard/{id}`)

```jsonc
{
  "id": 9, "name": "Exec Overview",
  "parameters": [                          // dashboard-level filters → Sigma controls
    { "id": "abc123", "name": "Date", "slug": "date", "type": "date/range", "default": "past30days" },
    { "id": "def456", "name": "Category", "slug": "cat", "type": "string/=" }
  ],
  "tabs": [ { "id": 1, "name": "Overview" } ],   // ⚠ v49+; dashcards carry dashboard_tab_id
  "dashcards": [                                 // ⚠ pre-v48: "ordered_cards" with sizeX/sizeY
    {
      "id": 1, "card_id": 123,
      "row": 0, "col": 0, "size_x": 8, "size_y": 6,   // 24-col grid → maps 1:1 to Sigma's 24-col layout
      "dashboard_tab_id": 1,
      "card": { ...full card JSON embedded... },
      "parameter_mappings": [
        { "parameter_id": "abc123", "card_id": 123,
          "target": ["dimension", ["field", 80, null]] }   // which column this control filters on this card
      ],
      "visualization_settings": {
        "virtual_card": { "display": "text" }, "text": "## Section header"   // text/heading cards have card_id: null
      }
    }
  ]
}
```

## `visualization_settings` keys the converter reads

| Key | Display | Meaning |
|---|---|---|
| `graph.dimensions` / `graph.metrics` | bar/line/area/combo/row/scatter/waterfall | x-axis column names / series column names (match `result_metadata.name`) |
| `stackable.stack_type` | bar/area | `"stacked"` \| `"normalized"` (100%) |
| `series_settings` | combo | per-series `{"display": "line"\|"bar"}` overrides |
| `pie.dimension` / `pie.metric` | pie | slice dim + value |
| `pivot_table.column_split` | pivot | `{"rows": [field refs], "columns": [...], "values": [...]}` → rowsBy/columnsBy/values |
| `scalar.field` | scalar | which column is THE number |
| `map.type` | map | `"region"` → region-map; `"pin"` → point-map |
| `column_settings` | any | per-column `{"number_style": "currency", "decimals": 2, "suffix": …}` → Sigma format |
| `table.columns` | table | column order + `enabled` (hidden cols) |

## Things that look like data but aren't

- **Text/heading dashcards** — `card_id: null` + `visualization_settings.virtual_card`
  → Sigma `text` elements (markdown passes through).
- **Click behavior** (`click_behavior` in viz settings — cross-filter / link) →
  flagged, not converted (Sigma actions are a manual follow-up).
- **`trend` / `smartscalar`** — the KPI value converts; the auto "vs previous
  period" comparison line is flagged (rebuild with a Sigma KPI comparison).
