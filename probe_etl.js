'use strict';
// Investigacao: ultima carga do ETL de resolvidos no DW (via Metabase)
// Executar: heroku run node probe_etl.js --app gestao-sup-ink

const MBURL = process.env.METABASE_URL || 'https://rsv-ink-metabase-f7ef97f28c72.herokuapp.com';
const MBDB  = Number(process.env.METABASE_DATABASE_ID) || 2;

async function mbQuery(sql) {
  const s1 = await fetch(MBURL + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.METABASE_EMAIL, password: process.env.METABASE_PASSWORD }),
  });
  const sess = await s1.json();
  if (!sess.id) throw new Error('Metabase auth falhou: ' + JSON.stringify(sess));
  const s2 = await fetch(MBURL + '/api/dataset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': sess.id },
    body: JSON.stringify({ database: MBDB, type: 'native', native: { query: sql } }),
  });
  const d = await s2.json();
  if (d.error) throw new Error('Metabase query erro: ' + d.error);
  return d.data?.rows || [];
}

async function main() {
  // 1. Resolvidos hoje (o que o painel exibe)
  const r1 = await mbQuery(`
    SELECT COUNT(*)::int, MAX(resolved_at_local)::text
    FROM dw.fact_cloudchat_tickets
    WHERE ticket_status = 'resolved'
      AND resolved_at_local >= CURRENT_DATE
      AND resolved_at_local <  CURRENT_DATE + 1
  `);
  console.log('1. Resolvidos hoje:', { total: r1[0]?.[0], ultima_resolved: r1[0]?.[1] });

  // 2. Maximo resolved_at_local geral
  const r2 = await mbQuery(`
    SELECT MAX(resolved_at_local)::text
    FROM dw.fact_cloudchat_tickets
    WHERE resolved_at_local IS NOT NULL
  `);
  console.log('2. Max resolved_at_local geral:', r2[0]?.[0]);

  // 3. Maximo updated_at_local geral (proxy da ultima execucao do ETL)
  const r3 = await mbQuery(`
    SELECT MAX(updated_at_local)::text
    FROM dw.fact_cloudchat_tickets
  `);
  console.log('3. Max updated_at_local geral:', r3[0]?.[0]);

  // 4. Tickets com updated_at_local nas ultimas 8h
  const r4 = await mbQuery(`
    SELECT COUNT(*)::int
    FROM dw.fact_cloudchat_tickets
    WHERE updated_at_local >= NOW() AT TIME ZONE 'America/Sao_Paulo' - INTERVAL '8 hours'
  `);
  console.log('4. Tickets atualizados nas ultimas 8h:', r4[0]?.[0]);

  // 5. Distribuicao de updated_at_local por hora hoje
  const r5 = await mbQuery(`
    SELECT DATE_TRUNC('hour', updated_at_local)::text AS hora, COUNT(*)::int AS qtd
    FROM dw.fact_cloudchat_tickets
    WHERE updated_at_local >= CURRENT_DATE
      AND updated_at_local <  CURRENT_DATE + 1
    GROUP BY 1
    ORDER BY 1
  `);
  console.log('5. Atualizacoes por hora hoje:');
  r5.forEach(r => console.log('  ', r[0], '->', r[1], 'tickets'));
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
