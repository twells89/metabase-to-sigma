# Metabase REST endpoints used by metabase-assessment

All read-only `GET`s against the first-class public API (`<host>/api/...`) —
works on open source and Pro/EE alike, v46+. Auth is one plain header, either:

| Method | Header | Notes |
|---|---|---|
| **API key** (preferred, v49+) | `x-api-key: $MB_KEY` | Admin → Settings → Authentication → API keys. Durable. A 403 means the key's **group** lacks collection read perms — ask for a key in a group with view access (Administrators for a full scan). |
| **Session token** | `X-Metabase-Session: $MB_SESSION` | From `POST /api/session {"username","password"}`. Expires (14-day default, sooner with SSO) — on 401 re-login and re-run (the walk is resumable). |

| Need | Endpoint | Notes |
|---|---|---|
| Probe / version | `GET /api/session/properties` | `version.tag` — works without auth; tells you whether `view_count` will exist (v50+) |
| Collection tree | `GET /api/collection?archived=false` | flat list; `personal_owner_id != null` (or `is_personal`) = personal space — skipped by default |
| Collection items | `GET /api/collection/{id}/items?models=card&models=dashboard&models=dataset&limit=100&offset=N` | paginated — loop until a short page; `data[]` of `{id, model, name}`; collection id `root` = "Our analytics" |
| **Card / model def** | `GET /api/card/{id}` | full definition: `dataset_query` (MBQL or native), `display`, `visualization_settings`, `view_count` (v50+) → `<out>/specs/{id}.card.json` |
| **Dashboard def** | `GET /api/dashboard/{id}` | `dashcards[]` (⚠ pre-v48: `ordered_cards[]` with `sizeX/sizeY`) + `parameters[]` + `tabs[]` + `view_count` (v50+) → `<out>/specs/{id}.dashboard.json` |
| **Schema metadata** | `GET /api/database/{id}/metadata` | fetched **once per referenced database** — the integer-field-id → column map MBQL refs require; this is the converter's `--metadata` input → `<out>/metadata/{id}.metadata.json` |
| Sandboxing probe (EE) | `GET /api/mt/gtap` | Pro/EE only — 404 on OSS (silently ignored); non-empty array → `sandboxes.json`, surfaced as needs-review |
| Recent views (thin) | `GET /api/activity/recents` | not used for ranking — see `usage-telemetry.md` |

## What is NOT available here

- **Per-artifact usage history** (views over time, per-user reach) — `view_count`
  (v50+) is a lifetime counter only; rich audit is the Pro/EE "Usage analytics"
  collection. Pre-v50 OSS has essentially nothing. See `usage-telemetry.md`.
- **Serialization export** (`/api/ee/serialization/export`, YAML bundles) is
  Pro/EE-only — this skill never depends on it; the REST walk above works on OSS.
- **Warehouse data** — this skill never calls `/api/card/{id}/query` or
  `/api/dataset`; definitions only, never results.
