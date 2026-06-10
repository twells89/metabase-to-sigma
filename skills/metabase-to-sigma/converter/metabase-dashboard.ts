/**
 * Metabase dashboard JSON → Sigma workbook spec.   [built from public docs — NOT yet live-validated]
 *
 * Input = GET /api/dashboard/{id}. Accepts BOTH the modern `dashcards` shape
 * (size_x/size_y) and the legacy `ordered_cards` shape (sizeX/sizeY).
 *
 *   dashboard tab            → workbook page (no tabs → single page)
 *   dashcard (by `display`)  → table / bar-chart (row = orientation:'horizontal' — the ONLY
 *                              valid orientation value; vertical OMITS the key) / line-chart /
 *                              area-chart / combo-chart / scatter-chart / pie-chart /
 *                              kpi-chart (value = {columnId}) / pivot-table (rowsBy+columnsBy =
 *                              [{id}] objects, values = bare column-id strings) /
 *                              region-map | point-map (map.type) — funnel/gauge/progress/
 *                              waterfall → table element + LOUD warning (never fake a viz)
 *   text/heading dashcards   → text elements (markdown passes through)
 *   dashboard parameters     → workbook controls (controlId = parameter slug); each
 *                              parameter_mapping wires a hidden boolean match column
 *                              `[Target Col] = [slug]` + element filter values:[true]
 *                              (same control/filter pattern as cognos-report.ts)
 *
 * Element sources are PLACEHOLDERS: source { kind:'table', elementId: '<DM element NAME>' }.
 * The real Sigma element ids don't exist until the DM is POSTed —
 * scripts/remap-wb-to-dm-ids.mjs rewrites the placeholders afterwards (matched by name).
 *
 * Layout: Metabase's 24-col grid maps 1:1 to Sigma's. Mirroring cognos-report's
 * mechanism, the SPEC carries no baked positions (POST reassigns element ids, which
 * breaks pre-baked layout XML); instead the result carries a `layout` hint structure
 * ({ grid: 24, pages: [{ name, elements: [{elementId, name, row, col, sizeX, sizeY}] }] })
 * for scripts/apply-layout.mjs (or an exact-grid variant of it) to apply post-POST.
 */

import { resetIds, sigmaShortId, sigmaDisplayName, formatFromMask } from './sigma-ids.js';
import { buildFieldIndex, translateMbqlExpr, translateAggregation, type FieldIndex, type MbqlCtx, type LearnedRule } from './metabase.js';

// ── workbook spec types (minimal) ────────────────────────────────────────────
interface WbColumn { id: string; name: string; formula: string; format?: Record<string, any>; hidden?: boolean; }
interface WbControl {
  id: string; kind: 'control'; controlId: string; name: string; controlType: string;
  source?: Record<string, any>; value?: any;
}
interface WbElement {
  id: string; kind: string; name?: string; source?: Record<string, any>;
  columns?: WbColumn[]; order?: string[]; filters?: any[];
  rowsBy?: Array<{ id: string }>; columnsBy?: Array<{ id: string }>; values?: string[];  // pivot
  xAxis?: { columnId: string };                                                          // cartesian charts
  yAxis?: { columnIds: Array<string | Record<string, any>> };
  value?: { id?: string; columnId?: string };           // pie {id} · kpi {columnId} — NOT {id} (kpis.md is stale)
  color?: any; stacking?: string; orientation?: string;
  latitude?: { id: string }; longitude?: { id: string }; region?: { id: string; regionType: string };
  text?: string;                                                                          // text elements
}
interface WbPage { id: string; name: string; elements: WbElement[]; }

export interface DashboardLayoutHint {
  grid: number;
  pages: Array<{ name: string; elements: Array<{ elementId: string; name: string; row: number; col: number; sizeX: number; sizeY: number }> }>;
}
export interface MetabaseDashboardResult {
  workbook: { name: string; schemaVersion: number; pages: WbPage[]; controls?: WbControl[] };
  warnings: string[];
  stats: Record<string, number>;
  layout: DashboardLayoutHint;
}
export interface MetabaseDashboardOptions {
  workbookName?: string;
  dataModelId?: string;
  metadata?: any;                          // GET /api/database/{id}/metadata — field-id resolution
  cardNameById?: Record<number, string>;   // card id → DM element name (for "card__N" sources)
  learnedRules?: LearnedRule[];
}

// Metabase parameter type → Sigma control type. null type ⇒ flagged (warning, no control).
function controlTypeFor(t: string): { type?: string; warn?: string } {
  if (t === 'date/range') return { type: 'date-range' };
  if (t === 'date' || t?.startsWith('date/')) return { type: 'date' };
  if (t === 'temporal-unit') return { warn: 'temporal-unit ("time grouping") parameter has no Sigma control analog — flagged; pick a grouping in the chart instead.' };
  if (t === 'string/=' || t === 'category' || t === 'id') return { type: 'list' };
  if (t?.startsWith('string/')) return { type: 'list', warn: `parameter operator "${t}" approximated as a list (include) control — verify the filter semantics.` };
  if (t === 'number/=') return { type: 'number' };
  if (t === 'number/between') return { type: 'number-range' };
  if (t?.startsWith('number/')) return { type: 'number', warn: `parameter operator "${t}" approximated as a number control — verify the filter semantics.` };
  return { warn: `parameter type "${t}" not mapped — create the control manually.` };
}

const DISPLAY_KIND: Record<string, string> = {
  table: 'table', bar: 'bar-chart', row: 'bar-chart', line: 'line-chart', area: 'area-chart',
  combo: 'combo-chart', scatter: 'scatter-chart', pie: 'pie-chart',
  scalar: 'kpi-chart', smartscalar: 'kpi-chart', trend: 'kpi-chart',
  pivot: 'pivot-table',
};
const NO_ANALOG = new Set(['funnel', 'gauge', 'progress', 'waterfall']);
const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function convertMetabaseDashboardToSigma(dashboard: any, options: MetabaseDashboardOptions = {}): MetabaseDashboardResult {
  resetIds();
  const warnings: string[] = [];
  const dash = typeof dashboard === 'string' ? JSON.parse(dashboard) : dashboard;
  const fidx: FieldIndex | null = options.metadata ? buildFieldIndex(options.metadata) : null;
  const name = options.workbookName || dash.name || 'Metabase Dashboard';

  // ── dashcards: accept BOTH the modern and the legacy shape ───────────────────
  const rawDcs: any[] = dash.dashcards || dash.ordered_cards || [];
  const dcs = rawDcs.map((d: any) => ({
    raw: d,
    card: d.card,
    cardId: d.card_id,
    vs: { ...(d.card?.visualization_settings || {}), ...(d.visualization_settings || {}) },
    tabId: d.dashboard_tab_id ?? null,
    row: d.row ?? 0, col: d.col ?? 0,
    sizeX: d.size_x ?? d.sizeX ?? 4, sizeY: d.size_y ?? d.sizeY ?? 4,
    parameterMappings: d.parameter_mappings || [],
  }));

  // ── parameters → controls (controlId = slug; wiring below is per-mapping) ────
  const paramById = new Map<string, any>();
  const controls: WbControl[] = [];
  for (const p of dash.parameters || []) {
    paramById.set(p.id, p);
    const { type, warn } = controlTypeFor(p.type);
    if (warn) warnings.push(`parameter "${p.name}" (${p.type}): ${warn}`);
    if (!type) continue;
    controls.push({
      id: sigmaShortId(), kind: 'control', controlId: p.slug || p.id, name: p.name || p.slug,
      controlType: type, value: p.default ?? null,
    });
  }

  // field-id → display name (metadata first; result_metadata fallback per card)
  const mkCtx = (card: any, prefix: string | null): MbqlCtx => {
    const rmById = new Map<number, any>();
    for (const rm of card?.result_metadata || []) {
      const fr = rm.field_ref;
      if (Array.isArray(fr) && fr[0] === 'field' && typeof fr[1] === 'number') rmById.set(fr[1], rm);
    }
    const display = (ref: any): string => {
      const idOrName = Array.isArray(ref) ? ref[1] : ref;
      if (typeof idOrName === 'number') {
        const f = fidx?.byId.get(idOrName);
        if (f) return f.displayName;
        const rm = rmById.get(idOrName);
        if (rm) return rm.display_name || sigmaDisplayName(rm.name);
        warnings.push(`card "${card?.name}": field ${idOrName} unresolved (pass --metadata) — emitted [Field ${idOrName}].`);
        return `Field ${idOrName}`;
      }
      return sigmaDisplayName(String(idOrName ?? ''));
    };
    const ctx: MbqlCtx = {
      fieldDisplay: display,
      resolveField: (ref: any) => {
        const opts = (Array.isArray(ref) && ref[2]) || {};
        const disp = display(ref);
        let out = prefix ? `[${prefix}/${disp}]` : `[${disp}]`;
        if (opts['temporal-unit']) out = `DateTrunc("${opts['temporal-unit']}", ${out})`;
        if (opts.binning) ctx.warn(`numeric binning on [${disp}] is flagged — recreate with BinFixed/BinCount on the element.`);
        return out;
      },
      warn: (m) => warnings.push(`card "${card?.name}": ${m}`),
      learnedRules: options.learnedRules,
    };
    return ctx;
  };

  // Resolve the DM-element-NAME placeholder this dashcard sources.
  // remap-wb-to-dm-ids.mjs rewrites it to the real posted element id (matched by name).
  const sourceNameFor = (card: any): string => {
    const dq = card.dataset_query || {};
    if (dq.type === 'native') {
      warnings.push(`card "${card.name}" is a native-SQL question — its DM sql element carries NO name (Sigma derives one); wire this element's source.elementId manually after posting the DM.`);
      return card.name || 'Custom SQL';
    }
    const q = dq.query || {};
    const src = q['source-table'];
    if (typeof src === 'string' && src.startsWith('card__')) {
      const n = Number(src.slice('card__'.length));
      const mapped = options.cardNameById?.[n];
      if (mapped) return mapped;
      warnings.push(`card "${card.name}" sources nested card ${n} — no card-name mapping provided; emitted placeholder "card__${n}" (remap will report it unresolved; pass cardNameById or fix by hand).`);
      return `card__${n}`;
    }
    if (typeof src === 'number') {
      const t = fidx?.tableById.get(src);
      if (!t) { warnings.push(`card "${card.name}": source table ${src} not in metadata — emitted placeholder "table_${src}".`); return `table_${src}`; }
      if (Array.isArray(q.joins) && q.joins.length) {
        // a joined card reads from the DM's derived join view, which denormalizes the dims
        warnings.push(`card "${card.name}" uses MBQL joins — sourced from the derived "${sigmaDisplayName(t.name)} View" element; verify the joined columns it needs are exposed there.`);
        return `${sigmaDisplayName(t.name)} View`;
      }
      return sigmaDisplayName(t.name);
    }
    warnings.push(`card "${card.name}": unrecognized source ${JSON.stringify(src)} — emitted placeholder "<element>".`);
    return '<element>';
  };

  // column_settings → Sigma format (number_style/decimals/suffix; mask → formatFromMask)
  const formatFromColumnSettings = (s: any): Record<string, any> | undefined => {
    if (!s) return undefined;
    const d = s.decimals ?? 2;
    let mask: string | null = null;
    if (s.number_style === 'currency') mask = `$#,##0${d ? '.' + '0'.repeat(d) : ''}`;
    else if (s.number_style === 'percent') mask = `0${d ? '.' + '0'.repeat(d) : ''}%`;
    else if (s.number_style === 'decimal' || s.decimals != null) mask = `#,##0${d ? '.' + '0'.repeat(d) : ''}`;
    let fmt = mask ? formatFromMask(mask) : null;
    if (s.suffix) fmt = { ...(fmt || { kind: 'number', formatString: ',.2f' }), suffix: s.suffix };
    return fmt || undefined;
  };

  interface BuiltCols {
    cols: WbColumn[]; order: string[];
    byKey: Map<string, string>;            // result name / display name (lowercase) → col id
    byFieldId: Map<number, string>;        // MBQL field id → col id
    byAggIndex: Map<number, string>;       // ["aggregation", n] → col id
    dimIds: string[]; metricIds: string[];
    keyOfId: Map<string, string>;          // col id → result_metadata name (series_settings keys)
  }

  const buildCardColumns = (card: any, sourceName: string, ctx: MbqlCtx): BuiltCols => {
    const out: BuiltCols = { cols: [], order: [], byKey: new Map(), byFieldId: new Map(), byAggIndex: new Map(), dimIds: [], metricIds: [], keyOfId: new Map() };
    const dq = card.dataset_query || {};
    const q = dq.type === 'query' ? dq.query || {} : null;
    let rms: any[] = card.result_metadata || [];
    if (!rms.length && q) {
      // never-run cards may carry no result_metadata — synthesize from the MBQL itself
      warnings.push(`card "${card.name}" has no result_metadata — columns synthesized from its MBQL (run the question once to capture exact result names).`);
      rms = [
        ...(q.breakout || []).map((b: any) => ({ name: ctx.fieldDisplay(b), display_name: ctx.fieldDisplay(b), field_ref: b })),
        ...(q.aggregation || []).map((_: any, i: number) => ({ name: `agg${i}`, display_name: '', field_ref: ['aggregation', i] })),
      ];
    }
    for (const rm of rms) {
      const fr = rm.field_ref;
      let formula = ''; let isMetric = false; let nm = rm.display_name || sigmaDisplayName(rm.name || 'Column');
      if (Array.isArray(fr) && fr[0] === 'aggregation') {
        const agg = q?.aggregation?.[fr[1]];
        if (agg) {
          const tr = translateAggregation(agg, ctx);
          formula = tr.formula;
          if (!nm) nm = tr.name;
        } else { formula = `[${nm}]`; }       // native/aggregated upstream — passthrough
        isMetric = true;
      } else if (Array.isArray(fr) && fr[0] === 'expression') {
        const ex = q?.expressions?.[fr[1]];
        formula = ex ? translateMbqlExpr(ex, ctx) : `[${fr[1]}]`;
      } else if (Array.isArray(fr) && fr[0] === 'field') {
        formula = ctx.resolveField(fr);
      } else {
        formula = `[${nm}]`;                  // native result column — bare display ref
      }
      const id = sigmaShortId();
      const col: WbColumn = { id, name: nm, formula };
      out.cols.push(col); out.order.push(id);
      if (rm.name) { out.byKey.set(String(rm.name).toLowerCase(), id); out.keyOfId.set(id, rm.name); }
      out.byKey.set(nm.toLowerCase(), id);
      if (Array.isArray(fr) && fr[0] === 'field' && typeof fr[1] === 'number') out.byFieldId.set(fr[1], id);
      if (Array.isArray(fr) && fr[0] === 'aggregation') out.byAggIndex.set(fr[1], id);
      (isMetric ? out.metricIds : out.dimIds).push(id);
    }
    return out;
  };

  // resolve a column_split / graph.* entry (field ref | agg ref | name string) → col id
  const resolveEntry = (entry: any, built: BuiltCols, ctx: MbqlCtx): string | undefined => {
    if (typeof entry === 'string') return built.byKey.get(entry.toLowerCase());
    if (Array.isArray(entry) && entry[0] === 'aggregation') return built.byAggIndex.get(entry[1]);
    if (Array.isArray(entry) && entry[0] === 'field') {
      if (typeof entry[1] === 'number' && built.byFieldId.has(entry[1])) return built.byFieldId.get(entry[1]);
      return built.byKey.get(ctx.fieldDisplay(entry).toLowerCase());
    }
    return undefined;
  };

  // ── per-dashcard element builder ───────────────────────────────────────────
  const buildElement = (dc: (typeof dcs)[number]): WbElement | null => {
    const vs = dc.vs;
    // text / heading dashcards (card_id null + virtual_card) → text elements
    if (dc.cardId == null && vs.virtual_card) {
      const display = vs.virtual_card.display;
      if (display === 'text' || display === 'heading') {
        return { id: sigmaShortId(), kind: 'text', name: 'Text', text: vs.text || '' };
      }
      warnings.push(`virtual card (display "${display}") is not a text/heading — skipped (link/action cards have no Sigma spec analog).`);
      return null;
    }
    const card = dc.card;
    if (!card) { warnings.push(`dashcard ${dc.raw.id}: card ${dc.cardId} not embedded in the dashboard JSON — skipped.`); return null; }
    if (vs.click_behavior || Object.values(vs.column_settings || {}).some((c: any) => c?.click_behavior)) {
      warnings.push(`card "${card.name}": click_behavior (cross-filter / link) is not converted — re-create as a Sigma action.`);
    }

    const display = String(card.display || 'table');
    const sourceName = sourceNameFor(card);
    const ctx = mkCtx(card, card.dataset_query?.type === 'native' ? null : sourceName);
    const built = buildCardColumns(card, sourceName, ctx);

    // column_settings → formats. Keys: '["name","COL"]' or '["ref",["field",72,null]]'.
    for (const [key, setting] of Object.entries(vs.column_settings || {})) {
      try {
        const k = JSON.parse(key);
        const colId = k[0] === 'name' ? built.byKey.get(String(k[1]).toLowerCase())
          : k[0] === 'ref' ? resolveEntry(k[1], built, ctx) : undefined;
        const fmt = formatFromColumnSettings(setting);
        if (colId && fmt) { const c = built.cols.find((c) => c.id === colId); if (c) c.format = fmt; }
      } catch { /* unparseable column_settings key — ignore */ }
    }

    const source: Record<string, any> = { kind: 'table', elementId: sourceName };
    if (options.dataModelId) source.dataModelId = options.dataModelId;
    const el: WbElement = {
      id: sigmaShortId(), kind: DISPLAY_KIND[display] || 'table', name: card.name || `Card ${card.id}`,
      source, columns: built.cols, order: built.order,
    };

    // graph.dimensions / graph.metrics matched through result_metadata names
    const dimIds = ((vs['graph.dimensions'] || []).filter(Boolean)
      .map((n: string) => built.byKey.get(n.toLowerCase())).filter(Boolean) as string[]);
    const metIds = ((vs['graph.metrics'] || []).filter(Boolean)
      .map((n: string) => built.byKey.get(n.toLowerCase())).filter(Boolean) as string[]);
    const xIds = dimIds.length ? dimIds : built.dimIds;
    const yIds = metIds.length ? metIds : built.metricIds;

    if (NO_ANALOG.has(display)) {
      // never fake a viz — emit the data as a table + a LOUD warning
      el.kind = 'table';
      el.name = `${card.name} (was ${display})`;
      warnings.push(`card "${card.name}" is a Metabase ${display} — Sigma has no native ${display} element; emitted its data as a TABLE. Re-pick a Sigma viz in the workbook.`);
    } else if (el.kind === 'kpi-chart') {
      const scalarField = vs['scalar.field'] ? built.byKey.get(String(vs['scalar.field']).toLowerCase()) : undefined;
      const valId = scalarField || yIds[0] || built.metricIds[0] || built.order[0];
      if (!valId) { warnings.push(`card "${card.name}" (scalar) resolved no value column — skipped.`); return null; }
      el.value = { columnId: valId };   // kpi-chart wants {columnId}, NOT {id}
      if (display === 'smartscalar' || display === 'trend') {
        warnings.push(`card "${card.name}" is a ${display} — the VALUE converts; the auto "vs previous period" comparison does not. Add a Sigma KPI comparison manually.`);
      }
    } else if (el.kind === 'pie-chart') {
      const sliceId = (vs['pie.dimension'] && built.byKey.get(String(vs['pie.dimension']).toLowerCase())) || xIds[0];
      const valId = (vs['pie.metric'] && built.byKey.get(String(vs['pie.metric']).toLowerCase())) || yIds[0];
      if (sliceId) el.color = { id: sliceId };
      if (valId) el.value = { id: valId };
      if (!sliceId || !valId) warnings.push(`card "${card.name}" (pie): could not resolve ${!sliceId ? 'slice dimension' : 'value'} — fix in the workbook.`);
    } else if (el.kind === 'pivot-table') {
      const split = vs['pivot_table.column_split'] || {};
      const rowsBy = (split.rows || []).map((e: any) => resolveEntry(e, built, ctx)).filter(Boolean).map((id: string) => ({ id }));
      const columnsBy = (split.columns || []).map((e: any) => resolveEntry(e, built, ctx)).filter(Boolean).map((id: string) => ({ id }));
      let values = (split.values || []).map((e: any) => resolveEntry(e, built, ctx)).filter(Boolean) as string[];
      if (!values.length) values = built.metricIds;
      // rowsBy/columnsBy = arrays of {id} OBJECTS, values = BARE column-id strings —
      // without rowsBy+columnsBy the pivot silently collapses to one grand-total cell.
      el.rowsBy = rowsBy; el.columnsBy = columnsBy; el.values = values;
      if (!rowsBy.length && !columnsBy.length) warnings.push(`card "${card.name}" (pivot): no row/column split resolved — the pivot will collapse to a single grand-total cell; set rowsBy/columnsBy.`);
    } else if (display === 'map') {
      const mapType = vs['map.type'] || 'region';
      if (mapType === 'pin') {
        const latId = built.cols.find((c) => /\blat/i.test(c.name))?.id;
        const lonId = built.cols.find((c) => /\b(lon|lng)/i.test(c.name))?.id;
        if (latId && lonId) {
          el.kind = 'point-map'; el.latitude = { id: latId }; el.longitude = { id: lonId };
        } else {
          el.kind = 'table'; el.name = `${card.name} (was pin map)`;
          warnings.push(`card "${card.name}" (pin map): no lat/long columns resolved — emitted its data as a table.`);
        }
      } else {
        const regId = xIds[0] || built.dimIds[0];
        if (regId) {
          el.kind = 'region-map'; el.region = { id: regId, regionType: vs['map.region'] === 'us_states' ? 'us-state' : 'country' };
          if (yIds[0]) el.color = { by: 'scale', column: yIds[0] };
          warnings.push(`card "${card.name}" → region-map: regionType guessed from map.region — verify (country / us-state / us-county / us-zipcode / ca-province).`);
        } else {
          el.kind = 'table'; el.name = `${card.name} (was region map)`;
          warnings.push(`card "${card.name}" (region map): no region column resolved — emitted its data as a table.`);
        }
      }
    } else if (el.kind.endsWith('-chart')) {
      // cartesian: bar / row / line / area / combo / scatter
      if (xIds[0]) el.xAxis = { columnId: xIds[0] };
      else warnings.push(`card "${card.name}" (${display}): no x-axis dimension resolved — set it in the workbook.`);
      if (el.kind === 'combo-chart') {
        // series_settings per-series display → bare-string (default mark) vs object
        // (overridden mark / secondary axis) forms on yAxis.columnIds — the persisted
        // dual-axis shape (feedback_sigma_combo_dual_axis).
        const ss = vs.series_settings || {};
        el.yAxis = {
          columnIds: yIds.map((id) => {
            const key = built.keyOfId.get(id);
            const d = key ? ss[key]?.display : undefined;
            return d && d !== 'bar' ? { columnId: id } : id;
          }),
        };
        if (Object.keys(ss).length) warnings.push(`card "${card.name}" (combo): per-series marks emitted via the bare-string/object yAxis form — verify each series' mark + axis in Sigma.`);
      } else if (yIds.length) {
        el.yAxis = { columnIds: yIds };
      } else {
        warnings.push(`card "${card.name}" (${display}): no measure resolved for the value axis — add one in the workbook.`);
      }
      if (xIds.length > 1) el.color = { by: 'category', column: xIds[1] };  // 2nd dimension = series color
      if (display === 'row') el.orientation = 'horizontal';  // 'horizontal' is the ONLY valid value; vertical bar OMITS the key
      const stack = vs['stackable.stack_type'];
      if (stack === 'stacked') el.stacking = 'stacked';
      else if (stack === 'normalized') { el.stacking = 'percent'; warnings.push(`card "${card.name}": 100%-stacked emitted as stacking:"percent" — verify the enum against the live spec.`); }
    }
    // display === 'table' → plain table element: columns + order already set.

    // table.columns enabled:false → hide
    for (const tc of vs['table.columns'] || []) {
      if (tc?.enabled === false && tc.name) {
        const id = built.byKey.get(String(tc.name).toLowerCase());
        const c = id && built.cols.find((c) => c.id === id);
        if (c) c.hidden = true;
      }
    }

    // ── parameter_mappings → hidden boolean match column + element filter ─────
    for (const pm of dc.parameterMappings) {
      const p = paramById.get(pm.parameter_id);
      if (!p) { warnings.push(`card "${card.name}": parameter_mapping references unknown parameter ${pm.parameter_id} — skipped.`); continue; }
      const slug = p.slug || p.id;
      const tgt = pm.target;
      if (!Array.isArray(tgt) || tgt[0] !== 'dimension') {
        warnings.push(`card "${card.name}": parameter "${p.name}" targets ${JSON.stringify(tgt)} (a native variable, not a column) — wire it to the SQL control manually.`);
        continue;
      }
      const fieldRef = tgt[1];
      const disp = ctx.fieldDisplay(fieldRef);
      let colId = resolveEntry(fieldRef, built, ctx);
      if (!colId) {
        colId = sigmaShortId();
        const col: WbColumn = { id: colId, name: disp, formula: ctx.resolveField(fieldRef), hidden: true };
        built.cols.push(col);
        built.byKey.set(disp.toLowerCase(), colId);
      }
      const targetCol = built.cols.find((c) => c.id === colId)!;
      const boolId = sigmaShortId();
      built.cols.push({ id: boolId, name: `${targetCol.name} = ${slug}`, formula: `[${targetCol.name}] = [${slug}]`, hidden: true });
      (el.filters ||= []).push({ id: sigmaShortId(), columnId: boolId, kind: 'list', mode: 'include', values: [true] });
    }

    // card-level MBQL filter → hidden boolean column + element filter (element is card-specific here, so this is safe)
    const q = card.dataset_query?.type === 'query' ? card.dataset_query.query : null;
    if (q?.filter) {
      const formula = translateMbqlExpr(q.filter, ctx);
      const fid = sigmaShortId();
      built.cols.push({ id: fid, name: `Filter: ${card.name || card.id}`, formula, hidden: true });
      (el.filters ||= []).push({ id: sigmaShortId(), columnId: fid, kind: 'list', mode: 'include', values: [true] });
    }

    el.columns = built.cols;
    el.order = built.order;
    return el;
  };

  // ── pages: one per dashboard tab (no tabs → single page) ─────────────────────
  const tabs: any[] = dash.tabs?.length ? dash.tabs : [null];
  const pages: WbPage[] = [];
  const layout: DashboardLayoutHint = { grid: 24, pages: [] };
  let placedControls = false;

  for (const tab of tabs) {
    const pageName = tab ? (tab.name || `Tab ${tab.id}`) : 'Page 1';
    const pageDcs = dcs
      .filter((d) => tab === null || (d.tabId ?? tabs[0]?.id) === tab.id)
      .sort((a, b) => a.row - b.row || a.col - b.col);
    const els: WbElement[] = [];
    const hints: DashboardLayoutHint['pages'][number]['elements'] = [];
    for (const dc of pageDcs) {
      const el = buildElement(dc);
      if (!el) continue;
      els.push(el);
      hints.push({ elementId: el.id, name: el.name || el.kind, row: dc.row, col: dc.col, sizeX: dc.sizeX, sizeY: dc.sizeY });
    }
    // controls live on the first page (dashboard filters are dashboard-global)
    const pageEls: WbElement[] = !placedControls && controls.length ? [...(controls as any), ...els] : els;
    if (!placedControls && controls.length) placedControls = true;
    pages.push({ id: sigmaShortId(), name: pageName, elements: pageEls });
    layout.pages.push({ name: pageName, elements: hints });
  }

  const allEls = pages.flatMap((p) => p.elements).filter((e) => e.kind !== 'control');
  const stats = {
    dashcards: dcs.length,
    pages: pages.length,
    tables: allEls.filter((e) => e.kind === 'table').length,
    pivots: allEls.filter((e) => e.kind === 'pivot-table').length,
    kpis: allEls.filter((e) => e.kind === 'kpi-chart').length,
    charts: allEls.filter((e) => e.kind.endsWith('-chart') && e.kind !== 'kpi-chart').length,
    maps: allEls.filter((e) => e.kind.endsWith('-map')).length,
    texts: allEls.filter((e) => e.kind === 'text').length,
    columns: allEls.reduce((n, e) => n + (e.columns?.length || 0), 0),
    filters: allEls.reduce((n, e) => n + (e.filters?.length || 0), 0),
    controls: controls.length,
  };
  return {
    workbook: { name, schemaVersion: 1, pages, controls },
    warnings, stats, layout,
  };
}
