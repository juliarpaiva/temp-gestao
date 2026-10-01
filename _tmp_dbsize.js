const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  // Tamanho por schema
  const r1 = await p.query(`
    SELECT schemaname,
           pg_size_pretty(sum(pg_total_relation_size(schemaname||'.'||tablename))::bigint) as size,
           sum(pg_total_relation_size(schemaname||'.'||tablename))::bigint as bytes
    FROM pg_tables
    GROUP BY schemaname ORDER BY 3 DESC LIMIT 20
  `);
  console.log('=== Por schema ===');
  r1.rows.forEach(r => console.log(r.schemaname.padEnd(20) + r.size));

  // Top 10 tabelas maiores no banco inteiro
  const r2 = await p.query(`
    SELECT schemaname||'.'||tablename as tbl,
           pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
           pg_total_relation_size(schemaname||'.'||tablename) as bytes
    FROM pg_tables ORDER BY 3 DESC LIMIT 15
  `);
  console.log('\n=== Top 15 tabelas ===');
  r2.rows.forEach(r => console.log(r.tbl.padEnd(50) + r.size));

  // Total
  const r3 = await p.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as total`);
  console.log('\nTOTAL:', r3.rows[0].total);

  // Testa se consegue fazer INSERT (read-only check)
  try {
    await p.query(`INSERT INTO support_bi.config (key,value) VALUES ('_rw_test','1') ON CONFLICT (key) DO NOTHING`);
    console.log('Escrita: OK (não é read-only)');
    await p.query(`DELETE FROM support_bi.config WHERE key='_rw_test'`);
  } catch(e) {
    console.log('Escrita: ERRO -', e.message);
  }
  p.end();
})().catch(e => { console.error(e.message); p.end(); });
