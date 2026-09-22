'use strict';
// Investigacao: ultima carga do ETL de resolvidos no DW
// Executar: heroku run node probe_etl.js --app gestao-sup-ink

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // 1. Resolvidos hoje no DW (o que o painel exibe)
  const r1 = await pool.query(`
    SELECT COUNT(*)::int AS total_hoje, MAX(resolved_at_local)::text AS ultima_resolved_hoje
    FROM dw.fact_cloudchat_tickets
    WHERE ticket_status = 'resolved'
      AND resolved_at_local >= CURRENT_DATE
      AND resolved_at_local <  CURRENT_DATE + 1
  `);
  console.log('1. Resolvidos hoje no DW:', r1.rows[0]);

  // 2. Maximo resolved_at_local em qualquer data (sinal do ticket mais recente no DW)
  const r2 = await pool.query(`
    SELECT MAX(resolved_at_local)::text AS max_resolved_geral
    FROM dw.fact_cloudchat_tickets
    WHERE resolved_at_local IS NOT NULL
  `);
  console.log('2. Max resolved_at_local geral:', r2.rows[0]);

  // 3. Maximo updated_at_local — proxy da ultima execucao do ETL
  const r3 = await pool.query(`
    SELECT MAX(updated_at_local)::text AS max_updated_geral
    FROM dw.fact_cloudchat_tickets
  `);
  console.log('3. Max updated_at_local geral:', r3.rows[0]);

  // 4. Tickets atualizados nas ultimas 8h (sinal de ETL ativo hoje)
  const r4 = await pool.query(`
    SELECT COUNT(*)::int AS atualizados_8h
    FROM dw.fact_cloudchat_tickets
    WHERE updated_at_local >= (NOW() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '8 hours'
  `);
  console.log('4. Tickets com updated_at_local nas ultimas 8h:', r4.rows[0]);

  // 5. Distribuicao de updated_at_local por hora hoje
  const r5 = await pool.query(`
    SELECT DATE_TRUNC('hour', updated_at_local)::text AS hora, COUNT(*)::int AS qtd
    FROM dw.fact_cloudchat_tickets
    WHERE updated_at_local >= CURRENT_DATE
      AND updated_at_local <  CURRENT_DATE + 1
    GROUP BY 1
    ORDER BY 1
  `);
  console.log('5. Atualizacoes por hora hoje:');
  r5.rows.forEach(r => console.log('  ', r.hora, '->', r.qtd, 'tickets'));

  await pool.end();
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
