// Smoke + contract tests on the bundled fixtures: node --import tsx/esm test.ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertMetabaseToSigma } from './metabase.js';
import { convertMetabaseDashboardToSigma } from './metabase-dashboard.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8'));
let fail = 0;
const check = (group: string, label: string, ok: boolean) => {
  if (ok) console.log(`✓ ${group}: ${label}`);
  else { fail++; console.log(`✗ ${group}: ${label}`); }
};

const metadata = read('metadata.json');
const ordersModel = read('orders-model.card.json');
const revenueTrend = read('revenue-trend.card.json');
const nativeCard = read('top-customers-native.card.json');

// ── cards → data model ────────────────────────────────────────────────────────
{
  const r = convertMetabaseToSigma(
    { metadata, cards: [ordersModel, revenueTrend, nativeCard] },
    { connectionId: 'conn1', database: 'CSA', schema: 'TJ' },
  );
  const els = r.model.pages[0].elements as any[];
  const byName = (n: string) => els.find((e) => e.name === n);
  const orderFact = byName('Order Fact');
  const customerDim = byName('Customer Dim');
  const joinEl = byName('Orders Model');
  const sqlEl = els.find((e) => e.source?.kind === 'sql');
  const derived = byName('Order Fact View');
  const col = (el: any, n: string) => el?.columns?.find((c: any) => c.name === n);

  check('dm', 'schemaVersion is 1', (r.model as any).schemaVersion === 1);
  check('dm', 'warehouse-table elements for both referenced tables (path CSA/TJ/TABLE)',
    JSON.stringify(orderFact?.source?.path) === JSON.stringify(['CSA', 'TJ', 'ORDER_FACT'])
    && JSON.stringify(customerDim?.source?.path) === JSON.stringify(['CSA', 'TJ', 'CUSTOMER_DIM']));
  check('dm', 'field-id resolution: plain column = inode id + [TABLE/Display] formula',
    orderFact?.columns?.some((c: any) => /^inode-.{22}\/SALES_AMOUNT$/.test(c.id) && c.formula === '[ORDER_FACT/Sales Amount]'));
  check('dm', 'join element: source kind join, joinType left, on Customer Key = Customer Key',
    joinEl?.source?.kind === 'join'
    && joinEl?.source?.joins?.[0]?.joinType === 'left'
    && joinEl?.source?.joins?.[0]?.on?.[0]?.left === 'Customer Key'
    && joinEl?.source?.joins?.[0]?.on?.[0]?.right === 'Customer Key');
  check('dm', 'arithmetic expression: Net Amount = ([Sales Amount] - [Discount Amount])',
    col(joinEl, 'Net Amount')?.formula === '([Sales Amount] - [Discount Amount])');
  check('dm', 'case → If, multi-value = → Or chain (no IsIn)',
    col(joinEl, 'Tier Bucket')?.formula === 'If(Or([Loyalty Tier] = "GOLD", [Loyalty Tier] = "PLATINUM"), "Premium", "Standard")');
  check('dm', 'datetime-diff → DateDiff',
    col(orderFact, 'Days Since Order')?.formula === 'DateDiff("day", [Order Date], Now())');
  check('dm', 'breakout temporal-unit → DateTrunc calc column',
    col(orderFact, 'Order Date (Month)')?.formula === 'DateTrunc("month", [Order Date])');
  check('dm', 'named aggregation keeps its display-name (Total Revenue)',
    joinEl?.metrics?.some((m: any) => m.name === 'Total Revenue' && m.formula === 'Sum([Sales Amount])'));
  check('dm', 'unnamed aggregation derives a name (Sum of Sales Amount)',
    orderFact?.metrics?.some((m: any) => m.name === 'Sum of Sales Amount' && m.formula === 'Sum([Sales Amount])'));
  check('dm', 'card filter NOT applied to the shared element (warned instead)',
    !orderFact?.filters && r.warnings.some((w) => /NOT applied to the shared/.test(w) && /DateAdd\("day", -365, Today\(\)\)/.test(w)));
  check('dm', 'native SQL card → sql-source element with NO element-level name',
    !!sqlEl && sqlEl.name === undefined && /SELECT/.test(sqlEl.source.statement));
  check('dm', 'native sql columns are bare [Display Name] refs',
    sqlEl?.columns?.some((c: any) => c.formula === '[Revenue]'));
  check('dm', 'plain text {{tag}} warns with the control to create',
    r.warnings.some((w) => /\{\{region\}\}/.test(w) && /control/.test(w) && /"region"/.test(w)));
  check('dm', 'dimension {{tag}} (field filter) is flagged',
    r.warnings.some((w) => /\{\{order_date\}\}/.test(w) && /FIELD FILTER/.test(w)));
  check('dm', 'FK metadata → relationship CUSTOMER_DIM on the fact element',
    orderFact?.relationships?.length === 1
    && orderFact.relationships[0].name === 'CUSTOMER_DIM'
    && orderFact.relationships[0].targetElementId === customerDim?.id
    && orderFact.relationships[0].keys?.[0]?.sourceColumnId && orderFact.relationships[0].keys?.[0]?.targetColumnId);
  check('dm', 'STORE_DIM FK skipped (table not referenced — both tables must be present)',
    !els.some((e) => e.name === 'Store Dim') && orderFact?.relationships?.length === 1);
  check('dm', 'derived join view exists and exposes dim columns',
    !!derived && derived.columns.some((c: any) => c.formula === '[Order Fact/CUSTOMER_DIM/Region]'));
  check('dm', 'derived view SKIPS the relationship key column (no Customer Key passthrough)',
    !!derived && !derived.columns.some((c: any) => c.formula === '[Order Fact/CUSTOMER_DIM/Customer Key]'));
}

// ── nested questions (source-table "card__N") ────────────────────────────────
{
  const nested = {
    id: 300, name: 'Premium Orders', type: 'question', display: 'table', database_id: 2,
    dataset_query: { type: 'query', database: 2, query: { 'source-table': 'card__100' } },
    result_metadata: [],
  };
  const r = convertMetabaseToSigma({ metadata, cards: [ordersModel, nested] }, { connectionId: 'c', database: 'CSA', schema: 'TJ' });
  const els = r.model.pages[0].elements as any[];
  const parent = els.find((e) => e.name === 'Orders Model');
  const child = els.find((e) => e.name === 'Premium Orders');
  check('nested', 'in-input nested card → element sourced from card 100\'s element',
    !!child && child.source?.kind === 'table' && child.source?.elementId === parent?.id);

  const r2 = convertMetabaseToSigma({ metadata, cards: [nested] }, { connectionId: 'c', database: 'CSA' });
  check('nested', 'missing source card → warning + skip',
    !(r2.model.pages[0].elements as any[]).some((e: any) => e.name === 'Premium Orders')
    && r2.warnings.some((w) => /card 100/.test(w) && /NOT in the input set/.test(w)));
}

// ── learned rules hook (applied before built-in translation) ─────────────────
{
  const r = convertMetabaseToSigma(
    { metadata, cards: [revenueTrend] },
    { connectionId: 'c', database: 'CSA', learnedRules: [{ pattern: '\\["datetime-diff",.*"day"\\]', template: 'DaysBetween()' }] },
  );
  const of = (r.model.pages[0].elements as any[]).find((e) => e.name === 'Order Fact');
  check('rules', 'learned rule overrides the built-in translation',
    of?.columns?.some((c: any) => c.name === 'Days Since Order' && c.formula === 'DaysBetween()'));
}

// ── sandboxing detection (detect-only) ───────────────────────────────────────
{
  const r = convertMetabaseToSigma({
    metadata, cards: [revenueTrend],
    sandboxes: [{ table_id: 45, group_id: 7, attribute_remappings: { region: ['dimension', ['field', 85, null]] } }],
  }, { connectionId: 'c', database: 'CSA' });
  check('security', 'sandbox → security entry (row-filter, group, readable expression)',
    (r as any).security?.length === 1
    && (r as any).security[0].type === 'row-filter'
    && (r as any).security[0].groups?.[0] === 7
    && /\[Region\] = user attribute "region"/.test((r as any).security[0].expression));
  check('security', 'security is detect-only — no filters injected into the model',
    !(r.model.pages[0].elements as any[]).some((e: any) => e.filters?.length)
    && r.warnings.some((w) => /SECURITY/.test(w) && /NOT ported/.test(w)));
}

// ── dashboard → workbook ─────────────────────────────────────────────────────
{
  const r = convertMetabaseDashboardToSigma(read('exec-overview.dashboard.json'),
    { metadata, cardNameById: { 100: 'Orders Model' } });
  const wb = r.workbook;
  const els = wb.pages.flatMap((p) => p.elements) as any[];
  const byName = (n: string) => els.find((e) => e.name === n);

  check('wb', 'schemaVersion is 1', wb.schemaVersion === 1);
  check('wb', 'one page per dashboard tab (Overview, Detail)',
    wb.pages.length === 2 && wb.pages[0].name === 'Overview' && wb.pages[1].name === 'Detail');
  check('wb', 'text dashcard → text element with the markdown',
    els.some((e) => e.kind === 'text' && /## Executive Overview/.test(e.text)));
  const kpi = byName('Total Revenue');
  check('wb', 'scalar → kpi-chart with value {columnId} (NOT {id})',
    kpi?.kind === 'kpi-chart' && !!kpi.value?.columnId && kpi.value?.id === undefined);
  check('wb', 'column_settings currency/decimals → Sigma format on the KPI column',
    kpi?.columns?.some((c: any) => c.format?.formatString === '$,.0f'));
  const line = byName('Revenue Trend');
  check('wb', 'line → line-chart with x dim + y metric matched through result_metadata',
    line?.kind === 'line-chart' && !!line.xAxis?.columnId && line.yAxis?.columnIds?.length === 1);
  check('wb', 'line x column is the DateTrunc breakout against the DM element name',
    line?.columns?.some((c: any) => c.formula === 'DateTrunc("month", [Order Fact/Order Date])'));
  const bar = byName('Customers by Region');
  check('wb', 'bar → bar-chart with orientation key OMITTED (vertical)',
    bar?.kind === 'bar-chart' && !('orientation' in bar));
  const row = byName('Customers by Loyalty Tier');
  check('wb', 'row → bar-chart with orientation "horizontal" (the only valid value)',
    row?.kind === 'bar-chart' && row.orientation === 'horizontal');
  const pie = byName('Stores by State');
  check('wb', 'pie → pie-chart with slice + value', pie?.kind === 'pie-chart' && !!pie.color?.id && !!pie.value?.id);
  const pivot = byName('Revenue by Region and Tier');
  check('wb', 'pivot → rowsBy/columnsBy as [{id}] OBJECTS + values as bare id strings',
    pivot?.kind === 'pivot-table'
    && pivot.rowsBy?.length === 1 && typeof pivot.rowsBy[0] === 'object' && !!pivot.rowsBy[0].id
    && pivot.columnsBy?.length === 1 && !!pivot.columnsBy[0].id
    && pivot.values?.length === 1 && typeof pivot.values[0] === 'string');
  check('wb', 'joined card sources the derived view placeholder',
    pivot?.source?.elementId === 'Order Fact View');
  const funnel = byName('Tier Funnel (was funnel)');
  check('wb', 'funnel → table element + LOUD warning (never fake a viz)',
    funnel?.kind === 'table' && r.warnings.some((w) => /funnel/.test(w) && /TABLE/.test(w)));
  check('wb', 'nested-question dashcard → source placeholder is the model name',
    byName('Premium Orders')?.source?.elementId === 'Orders Model');
  check('wb', 'nested card MBQL filter → hidden bool column + element filter [true]',
    byName('Premium Orders')?.columns?.some((c: any) => c.hidden && c.formula === '[Orders Model/Tier Bucket] = "Premium"')
    && byName('Premium Orders')?.filters?.some((f: any) => f.kind === 'list' && f.mode === 'include' && f.values[0] === true));
  check('wb', 'parameters → controls wired by slug (date/range → date-range, string/= → list)',
    (wb.controls || []).some((c) => c.controlId === 'date_range' && c.controlType === 'date-range' && c.value === 'past30days')
    && (wb.controls || []).some((c) => c.controlId === 'region' && c.controlType === 'list'));
  check('wb', 'parameter_mapping → hidden boolean match column + include-[true] filter',
    bar?.columns?.some((c: any) => c.hidden && c.formula === '[Region] = [region]')
    && bar?.filters?.some((f: any) => f.kind === 'list' && f.mode === 'include' && f.values[0] === true)
    && line?.columns?.some((c: any) => c.hidden && c.formula === '[Order Date] = [date_range]'));
  check('wb', 'element source placeholders are DM element NAMES (remap rewrites them)',
    line?.source?.kind === 'table' && line?.source?.elementId === 'Order Fact'
    && bar?.source?.elementId === 'Customer Dim');
  check('wb', 'layout hints preserve the 1:1 24-col grid',
    r.layout.grid === 24
    && r.layout.pages[0].elements.some((h) => h.name === 'Revenue Trend' && h.col === 5 && h.sizeX === 10 && h.sizeY === 6));
  check('wb', 'click_behavior flagged', r.warnings.some((w) => /click_behavior/.test(w)));
}

// ── legacy ordered_cards (sizeX/sizeY) ───────────────────────────────────────
{
  const r = convertMetabaseDashboardToSigma(read('legacy-grid.dashboard.json'), { metadata });
  const els = r.workbook.pages.flatMap((p) => p.elements) as any[];
  check('legacy', 'ordered_cards accepted — both dashcards converted on one page',
    r.workbook.pages.length === 1 && els.filter((e) => e.kind !== 'control').length === 2);
  check('legacy', 'sizeX/sizeY geometry flows into the layout hints',
    r.layout.pages[0].elements.some((h) => h.sizeX === 12 && h.sizeY === 6));
  check('legacy', 'kpi value {columnId} on the legacy scalar too',
    els.some((e) => e.kind === 'kpi-chart' && !!e.value?.columnId));
}

// ── every fixture converts without throwing ──────────────────────────────────
for (const f of readdirSync(FIX).sort()) {
  try {
    if (f.endsWith('.card.json')) {
      const r = convertMetabaseToSigma({ metadata, cards: [read(f)] }, { connectionId: 'c', database: 'CSA', schema: 'TJ' });
      if (!r.model.pages[0].elements.length) throw new Error('no elements');
      console.log(`✓ ${f.padEnd(36)} cards → ${r.stats.elements} elems · ${r.stats.columns} cols · ${r.stats.metrics} metrics · ${r.stats.relationships} rels (${r.warnings.length} warnings)`);
    } else if (f.endsWith('.dashboard.json')) {
      const r = convertMetabaseDashboardToSigma(read(f), { metadata });
      if (!r.workbook.pages.length) throw new Error('no pages');
      console.log(`✓ ${f.padEnd(36)} dashboard → ${r.stats.pages} pages · ${r.stats.kpis} kpis · ${r.stats.charts} charts · ${r.stats.pivots} pivots · ${r.stats.tables} tables · ${r.stats.texts} texts · ${r.stats.controls} controls · ${r.stats.filters} filters (${r.warnings.length} warnings)`);
    }
  } catch (e: any) { fail++; console.log(`✗ ${f} — ${e.message}`); }
}

console.log(fail ? `\n${fail} FAILED` : '\nall checks green ✓');
process.exit(fail ? 1 : 0);
