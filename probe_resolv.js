'use strict';
// Investigacao: "resolvidos hoje" CloudChat vs DW
// Executar: heroku run node probe_resolv.js --app gestao-sup-ink

const BASE  = 'https://cloudchat3.cloudhumans.com';
const ACC   = 73;
const TOKEN = process.env.CLOUDCHAT_TOKEN;
const MBURL = process.env.METABASE_URL || 'https://rsv-ink-metabase-f7ef97f28c72.herokuapp.com';
const MBDB  = Number(process.env.METABASE_DATABASE_ID) || 2;

// Inicio de hoje em BRT (UTC-3) como string ISO UTC
const off = -3 * 3600000;
const _d  = new Date(Date.now() + off);
_d.setUTCHours(0, 0, 0, 0);
const todayISO  = new Date(_d.getTime() - off).toISOString();
const hojeLocal = _d.toISOString().slice(0, 10);         // YYYY-MM-DD no fuso BRT
const amanha    = new Date(_d.getTime() + 86400000).toISOString().slice(0, 10);

console.log(`\n=== Investigacao: Resolvidos Hoje ===`);
console.log(`Hoje BRT: ${hojeLocal} (UTC: ${todayISO})\n`);

async function cc(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'api_access_token': TOKEN, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  if (!r.ok) { const t = await r.text(); throw new Error(`CC ${r.status}: ${t.slice(0, 200)}`); }
  return r.json();
}

async function pf(payload) {
  const j = await cc(`/api/v1/accounts/${ACC}/conversations/filter?page=1`, 'POST', { payload });
  const meta  = j.meta  || j.data?.meta  || {};
  const items = j.payload || j.data?.payload || [];
  return { count: meta.all_count ?? 0, items };
}

async function mbQuery(sql) {
  const s1 = await fetch(MBURL + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.METABASE_EMAIL, password: process.env.METABASE_PASSWORD }),
  });
  const sess = await s1.json();
  if (!sess.id) throw new Error('Metabase auth falhou');
  const s2 = await fetch(MBURL + '/api/dataset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': sess.id },
    body: JSON.stringify({ database: MBDB, type: 'native', native: { query: sql } }),
  });
  const d = await s2.json();
  return d.data?.rows || [];
}

async function main() {
  // ── 1. Inspecionar campos de data num ticket resolvido ──────────────────────
  console.log('=== 1. Campos de data em ticket resolvido ===');
  const rest = await cc(`/api/v1/accounts/${ACC}/conversations?status=resolved&page=1`);
  const conv = (rest?.data?.payload || [])[0];
  if (conv) {
    const dateCols = Object.entries(conv)
      .filter(([, v]) => typeof v === 'number' && v > 1_000_000_000 && v < 9_999_999_999)
      .map(([k, v]) => `  ${k}: ${new Date(v * 1000).toISOString()}`);
    console.log(`Ticket #${conv.id} (status=${conv.status}):`);
    dateCols.forEach(l => console.log(l));
    console.log('  resolved_at presente?', 'resolved_at' in conv, '→ valor:', conv.resolved_at ?? 'null/undefined');
  } else {
    console.log('Nenhum ticket resolvido na pagina 1');
  }

  // ── 2. CloudChat — resolvidos com updated_at >= hoje ───────────────────────
  console.log('\n=== 2. CloudChat: resolved + updated_at >= hoje ===');
  const a = await pf([
    { attribute_key: 'status',     filter_operator: 'equal_to',        values: ['resolved'], query_operator: 'AND' },
    { attribute_key: 'updated_at', filter_operator: 'is_greater_than', values: [todayISO],   query_operator: null  },
  ]);
  console.log(`Todos (sem filtro de label): ${a.count}`);

  // Mostrar updated_at dos primeiros para ver se batem com "resolvidos hoje" ou sao updates pos-resolucao
  if (a.items.length) {
    console.log('Amostra (id | updated_at | status | labels):');
    a.items.slice(0, 5).forEach(c => {
      const upd = c.updated_at ? new Date(c.updated_at * 1000).toISOString() : '—';
      const res = c.resolved_at ? new Date(c.resolved_at * 1000).toISOString() : 'sem campo';
      console.log(`  #${c.id} | updated=${upd} | resolved_at=${res} | labels=${JSON.stringify(c.labels)}`);
    });
  }

  // ── 3. CloudChat — n2_ticket resolvidos com updated_at >= hoje ─────────────
  console.log('\n=== 3. CloudChat: n2_ticket + resolved + updated_at >= hoje ===');
  const b = await pf([
    { attribute_key: 'labels',     filter_operator: 'equal_to',        values: ['n2_ticket'], query_operator: 'AND' },
    { attribute_key: 'status',     filter_operator: 'equal_to',        values: ['resolved'],  query_operator: 'AND' },
    { attribute_key: 'updated_at', filter_operator: 'is_greater_than', values: [todayISO],    query_operator: null  },
  ]);
  console.log(`N2 com label n2_ticket: ${b.count}`);

  // ── 4. CloudChat — resolvidos criados hoje (ja calculado no painel) ─────────
  console.log('\n=== 4. CloudChat: n2_ticket + resolved + created_at >= hoje ===');
  const c2 = await pf([
    { attribute_key: 'labels',     filter_operator: 'equal_to',        values: ['n2_ticket'], query_operator: 'AND' },
    { attribute_key: 'created_at', filter_operator: 'is_greater_than', values: [todayISO],    query_operator: 'AND' },
    { attribute_key: 'status',     filter_operator: 'equal_to',        values: ['resolved'],  query_operator: null  },
  ]);
  console.log(`N2 criados hoje e resolvidos: ${c2.count}`);

  // ── 5. DW — metodo atual do painel ─────────────────────────────────────────
  console.log('\n=== 5. DW (fonte atual do painel) ===');
  try {
    const rows = await mbQuery(`
      SELECT COUNT(*)::int, MAX(resolved_at_local)::text
      FROM dw.fact_cloudchat_tickets
      WHERE ticket_status = 'resolved'
        AND resolved_at_local >= '${hojeLocal}'
        AND resolved_at_local <  '${amanha}'
    `);
    const [count, maxTs] = rows[0] || [null, null];
    console.log(`Resolvidos hoje (DW): ${count}`);
    console.log(`Ultimo resolved_at_local no DW hoje: ${maxTs || '—'}`);

    // Quantos tickets o DW tem com resolved_at_local preenchido hoje
    const rows2 = await mbQuery(`
      SELECT MAX(resolved_at_local)::text AS ultima_carga
      FROM dw.fact_cloudchat_tickets
      WHERE resolved_at_local IS NOT NULL
    `);
    console.log(`Ultimo registro DW (qualquer data): ${rows2[0]?.[0] || '—'}`);
  } catch (e) {
    console.log('DW erro:', e.message);
  }

  // ── Resumo ─────────────────────────────────────────────────────────────────
  console.log('\n=== RESUMO ===');
  console.log(`CloudChat (resolved + updated>=hoje, todos):   ${a.count}`);
  console.log(`CloudChat (resolved + updated>=hoje, n2):      ${b.count}`);
  console.log(`CloudChat (n2 criados hoje + resolved):        ${c2.count}  ← ja no painel`);
  console.log(`DW (resolved_at_local hoje):                   (ver acima)`);
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
