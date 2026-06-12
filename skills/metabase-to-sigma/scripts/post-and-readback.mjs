#!/usr/bin/env node
// post-and-readback.mjs — POST a Metabase-converted DM or workbook spec, then read it
// back and FAIL LOUDLY on any error-typed column (a spec can POST 200 yet have
// formulas that don't resolve at query time — those surface as type "error").
//
// Usage:
//   eval "$(scripts/get-token.sh)"
//   node scripts/post-and-readback.mjs --type datamodel|workbook --spec spec.json --folder <folderId> [--name N] [--out map.json]
//
// Prints { dataModelId|workbookId, errors:[...] } and exits non-zero if any error columns.
import { readFileSync, writeFileSync } from 'node:fs';
import { api, extractId, parseArgs, elementsOf } from './lib/sigma-rest.mjs';

const a = parseArgs(process.argv.slice(2));
if (!a.type || !a.spec || !a.folder) { console.error('need --type datamodel|workbook --spec <spec.json> --folder <folderId>'); process.exit(2); }
const idField = a.type === 'datamodel' ? 'dataModelId' : 'workbookId';
const postPath = a.type === 'datamodel' ? '/v2/dataModels/spec' : '/v2/workbooks/spec';
const colsPath = (id) => a.type === 'datamodel' ? `/v2/dataModels/${id}/columns` : `/v2/workbooks/${id}/columns`;

const spec = JSON.parse(readFileSync(a.spec, 'utf8'));
// name AFTER the spread — `{name, ...spec}` let spec.name silently override --name (beads-sigma-unff).
const body = { folderId: a.folder, ...spec, name: a.name || spec.name || `metabase ${a.type} ${Date.now()}` };
let post = await api('POST', postPath, body);
// Control→DM-parameter bindings (remap --dm-spec) can be rejected by orgs where
// data-model parameter targeting isn't enabled — strip them and retry ONCE,
// loudly: the dashboard still posts; sync each control to its DM control in the
// UI (control → Settings → "Sync with data source parameter").
if (!post.ok && /Invalid parameter on control/.test(post.text)) {
  let stripped = 0;
  const stripParams = (c) => { if (c?.kind === 'control' && c.parameters) { delete c.parameters; stripped++; } };
  for (const c of body.controls || []) stripParams(c);
  for (const p of body.pages || []) for (const e of p.elements || []) stripParams(e);
  if (stripped) {
    console.error(`WARN: org rejected control→data-model parameter bindings — stripped ${stripped} and retrying. The controls POST but are NOT wired to the DM {{tag}} controls; sync them in the UI (or set values on the DM controls directly).`);
    post = await api('POST', postPath, body);
  }
}
const id = extractId(post, idField);
if (!id) { console.error(`POST failed (HTTP ${post.status}): ${post.text.slice(0, 500)}`); process.exit(1); }
console.error(`POST ok → ${idField}=${id}`);

// Silent-error guard: scan resolved column types; type "error" = formula didn't resolve.
const cols = await api('GET', colsPath(id));
const errors = [];
const list = cols.json?.entries || cols.json?.columns || (Array.isArray(cols.json) ? cols.json : []);
for (const c of (Array.isArray(list) ? list : [])) {
  const t = c.type?.type || c.columnType || c.type;
  if (String(t).toLowerCase() === 'error') errors.push(c.name || c.columnName || c.columnId);
}
const elements = elementsOf((await api('GET', a.type === 'datamodel' ? `/v2/dataModels/${id}/elements` : `/v2/workbooks/${id}/elements`)).json);
const result = { [idField]: id, elements, errors };
if (a.out) writeFileSync(a.out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (errors.length) { console.error(`FAIL: ${errors.length} error-typed column(s): ${errors.join(', ')}`); process.exit(1); }
console.error(`readback clean: ${elements.length} element(s), 0 error columns`);
