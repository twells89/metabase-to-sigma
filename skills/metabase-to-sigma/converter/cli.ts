#!/usr/bin/env node
/**
 * Metabase → Sigma converter CLI.
 *   node --import tsx/esm cli.ts <input.json> [opts]
 *
 * Auto-detects input:
 *   JSON with `dashcards`/`ordered_cards`             → dashboard → Sigma workbook spec
 *   JSON with `cards`, an array of cards, or a single
 *   card with `dataset_query`                         → cards → Sigma data model
 *
 * Options: --metadata <metadata.json> --connection <id> --database <DB> --schema <S>
 *          --dm <dataModelId> --security-out <file>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { convertMetabaseToSigma } from './metabase.js';
import { convertMetabaseDashboardToSigma } from './metabase-dashboard.js';

// Gap-scout learned rules (validated, customer-discovered translations) live in the
// customer's home dir so a skill `git pull` never clobbers them. Applied before the
// built-in translator (see scripts/gap-scout.md).
function loadLearnedRules() {
  try {
    const p = join(homedir(), '.metabase-to-sigma', 'learned-rules.json');
    const rules = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(rules) ? rules : (rules.rules || []);
    if (arr.length) console.error(`[learned-rules] applying ${arr.length} customer rule(s) from ${p}`);
    return arr;
  } catch { return []; }
}

const args = process.argv.slice(2);
const opt = (k: string, d = '') => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
// positional arg = the first token that is neither a flag nor a flag's value
const input = args.find((a: string, i: number) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!input) { console.error('usage: cli.ts <cards.json|dashboard.json> [--metadata metadata.json --connection X --database DB --schema S --dm ID --security-out security.json]'); process.exit(1); }

const raw = JSON.parse(readFileSync(input, 'utf8'));
const metadataFile = opt('metadata');
const metadata = metadataFile ? JSON.parse(readFileSync(metadataFile, 'utf8')) : undefined;
const learnedRules = loadLearnedRules();

const isDashboard = !!(raw.dashcards || raw.ordered_cards);
let res: any;
if (isDashboard) {
  res = convertMetabaseDashboardToSigma(raw, { dataModelId: opt('dm') || undefined, metadata, learnedRules });
} else {
  const cards = Array.isArray(raw) ? raw : raw.cards ? raw.cards : raw.dataset_query ? [raw] : [];
  res = convertMetabaseToSigma(
    { metadata: metadata ?? raw.metadata, cards, sandboxes: raw.sandboxes },
    { connectionId: opt('connection', '<CONNECTION_ID>'), database: opt('database'), schema: opt('schema'), learnedRules },
  );
}

const payload = isDashboard ? res.workbook : res.model;
process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
console.error(`\n[${isDashboard ? 'dashboard→workbook' : 'cards→data-model'}] stats: ${JSON.stringify(res.stats)}`);

// Detected security (Metabase sandboxing) — detect-only; apply_sigma_rls.py ports it.
if (res.security?.length) {
  const out = opt('security-out', 'security.json');
  writeFileSync(out, JSON.stringify(res.security, null, 2));
  console.error(`SECURITY: ${res.security.length} rule(s) detected → ${out} — run scripts/apply_sigma_rls.py after posting the model (see SKILL.md "Security").`);
}
if (res.warnings.length) {
  console.error(`warnings (${res.warnings.length}) — translated where possible, flagged where not:`);
  res.warnings.forEach((w: string) => console.error('  ! ' + w));
}
