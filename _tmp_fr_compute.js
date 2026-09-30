// Roda no dyno do Heroku via: heroku run node /tmp/compute_fr_days.js
// Computa 1a resposta CC para os dias 24, 25, 28, 29/09 e salva no cache
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const CLOUDCHAT_BASE    = 'https://cloudchat3.cloudhumans.com';
const CLOUDCHAT_ACCOUNT = 73;
const _MONITORED_CC     = ['Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz'];

function _bhMinsServer(start_s, end_s) {
  if (!start_s || !end_s || end_s <= start_s) return null;
  const BRT_OFF = -3 * 3600000;
  const INICIO  = 9 * 60;
  const FIM     = 18 * 60 + 30;
  const DIAS    = [1, 2, 3, 4, 5];
  const startMs = start_s * 1000 + BRT_OFF;
  const endMs   = end_s   * 1000 + BRT_OFF;
  let total = 0;
  const d = new Date(startMs);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() < endMs) {
    if (DIAS.includes(d.getUTCDay())) {
      const open  = d.getTime() + INICIO * 60000;
      const close = d.getTime() + FIM    * 60000;
      const from  = Math.max(startMs, open);
      const to    = Math.min(endMs, close);
      if (to > from) total += (to - from) / 60000;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return total;
}

async function computeDay(d0, d1) {
  const token  = process.env.CLOUDCHAT_TOKEN;
  const endMs  = new Date(d1 + 'T00:00:00Z').getTime();
  const startMs = new Date(d0 + 'T00:00:00Z').getTime() - 45 * 86400000;
  const allRows = [];
  let cur = startMs;
  while (cur < endMs) {
    const winEnd = Math.min(cur + 5 * 86400000, endMs);
    const sStr   = new Date(cur).toISOString().slice(0, 10) + 'T00:00:00';
    const eStr   = new Date(winEnd).toISOString().slice(0, 10) + 'T00:00:00';
    try {
      const url  = `${CLOUDCHAT_BASE}/api/v2/accounts/${CLOUDCHAT_ACCOUNT}/data_extracts` +
        `?account_id=${CLOUDCHAT_ACCOUNT}&startDate=${encodeURIComponent(sStr)}&endDate=${encodeURIComponent(eStr)}` +
        `&type=TICKET_METRICS_WITH_AGENT_INFORMATION`;
      const resp = await fetch(url, {
        headers: { 'api_access_token': token },
        signal: AbortSignal.timeout(30000)
      });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) allRows.push(...data);
      } else {
        console.warn(`  window ${sStr}->${eStr} status=${resp.status}`);
      }
    } catch (e) { console.warn(`  window error: ${e.message}`); }
    cur = winEnd;
    if (cur < endMs) await new Promise(r => setTimeout(r, 3200));
  }

  const agTimes = {};
  for (const row of allRows) {
    const agent = row.firstAgentReplyName;
    if (!_MONITORED_CC.includes(agent)) continue;
    if (!row.resolvedAt || row.ticketStatus !== 'resolved') continue;
    if (row.resolvedAt < d0 || row.resolvedAt >= d1) continue;
    if (row.firstAgentReplyTimeMin == null || row.firstAgentReplyTimeMin < 0) continue;
    if (!row.firstAgentAssignmentTime || !row.firstAgentFirstReplyTime) continue;
    const BRT_OFFSET  = 3 * 3600;
    const assignedTs  = Math.round(new Date(row.firstAgentAssignmentTime + 'Z').getTime() / 1000) + BRT_OFFSET;
    const replyTs     = Math.round(new Date(row.firstAgentFirstReplyTime  + 'Z').getTime() / 1000) + BRT_OFFSET;
    const bhm = _bhMinsServer(assignedTs, replyTs);
    if (bhm === null || bhm < 0 || bhm > 10080) continue;
    if (!agTimes[agent]) agTimes[agent] = [];
    agTimes[agent].push(bhm);
  }

  const byAgent = {};
  for (const [ag, times] of Object.entries(agTimes)) {
    if (!times.length) continue;
    const avg    = times.reduce((s, x) => s + x, 0) / times.length;
    const sorted = [...times].sort((a, b) => a - b);
    const mid    = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    byAgent[ag]  = { avg: Math.round(avg * 10) / 10, median: Math.round(median * 10) / 10, n: times.length };
  }
  const allTimes = Object.values(agTimes).flat();
  if (allTimes.length) {
    const gAvg    = allTimes.reduce((s, x) => s + x, 0) / allTimes.length;
    const gSorted = [...allTimes].sort((a, b) => a - b);
    const gMid    = Math.floor(gSorted.length / 2);
    const gMedian = gSorted.length % 2 ? gSorted[gMid] : (gSorted[gMid - 1] + gSorted[gMid]) / 2;
    byAgent['__global__'] = { avg: Math.round(gAvg * 10) / 10, median: Math.round(gMedian * 10) / 10, n: allTimes.length };
  }
  return { byAgent, totalRows: allRows.length };
}

const DAYS = [
  ['2026-09-24','2026-09-25'],
  ['2026-09-25','2026-09-26'],
  ['2026-09-28','2026-09-29'],
  ['2026-09-29','2026-09-30'],
];

(async () => {
  for (const [d0, d1] of DAYS) {
    console.log(`\n=== ${d0} ===`);
    const { byAgent, totalRows } = await computeDay(d0, d1);
    console.log(`  total rows CC: ${totalRows}`);
    const cacheKey = `fr:${d0}:${d1}`;
    for (const [ag, v] of Object.entries(byAgent)) {
      if (ag === '__global__') continue;
      console.log(`  ${ag.padEnd(22)} avg=${v.avg}min  med=${v.median}min  n=${v.n}`);
    }
    const g = byAgent['__global__'];
    if (g) console.log(`  ${'(global)'.padEnd(22)} avg=${g.avg}min  med=${g.median}min  n=${g.n}`);
    // Salva no cache
    await pool.query(
      `INSERT INTO support_bi.first_reply_cc_cache (cache_key, by_agent, computed_at)
       VALUES ($1,$2,NOW()) ON CONFLICT (cache_key) DO UPDATE SET by_agent=$2, computed_at=NOW()`,
      [cacheKey, JSON.stringify(byAgent)]
    );
    console.log(`  -> salvo em cache (${cacheKey})`);
  }
  await pool.end();
  console.log('\nPronto!');
})().catch(e => { console.error(e.message); pool.end(); });

