const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r1 = await p.query(`
    SELECT tablename,
           pg_size_pretty(pg_total_relation_size('support_bi.'||tablename)) as size,
           pg_total_relation_size('support_bi.'||tablename) as bytes
    FROM pg_tables WHERE schemaname='support_bi' ORDER BY 3 DESC
  `);
  r1.rows.forEach(r => console.log(r.tablename.padEnd(35) + r.size));
  const r2 = await p.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as total`);
  console.log('\nTOTAL DB:', r2.rows[0].total);
  // Verifica se está read-only
  try {
    await p.query(`CREATE TEMP TABLE _test_rw (x int)`);
    console.log('DB: read-write OK');
  } catch(e) {
    console.log('DB STATUS:', e.message);
  }
  p.end();
})().catch(e => { console.error(e.message); p.end(); });
