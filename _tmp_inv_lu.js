// Investiga diferenca Lu Almeida: nosso 1h51 vs Henrique 2h16
// Periodo: SET 2026 (01/09 a 01/10)
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const CLOUDCHAT_BASE    = 'https://cloudchat3.cloudhumans.com';
const CLOUDCHAT_ACCOUNT = 73;

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

function fmtMin(m) {
  if (m === null || m === undefined) return '—';
  const t = Math.round(m);
  if (t < 60) return t + 'min';
  return Math.floor(t/60) + 'h' + (t%60 ? ' ' + (t%60) + 'min' : '');
}

const d0 = '2026-09-01';
const d1 = '2026-10-01';

(async () => {
  const token  = process.env.CLOUDCHAT_TOKEN;
  const endMs  = new Date(d1 + 'T00:00:00Z').getTime();
  const startMs = new Date(d0 + 'T00:00:00Z').getTime() - 45 * 86400000;
  const allRows = [];
  let cur = startMs;
  let windows = 0;
  while (cur < endMs) {
    const winEnd = Math.min(cur + 5 * 86400000, endMs);
    const sStr   = new Date(cur).toISOString().slice(0, 10) + 'T00:00:00';
    const eStr   = new Date(winEnd).toISOString().slice(0, 10) + 'T00:00:00';
    const url    = `${CLOUDCHAT_BASE}/api/v2/accounts/${CLOUDCHAT_ACCOUNT}/data_extracts` +
      `?account_id=${CLOUDCHAT_ACCOUNT}&startDate=${encodeURIComponent(sStr)}&endDate=${encodeURIComponent(eStr)}` +
      `&type=TICKET_METRICS_WITH_AGENT_INFORMATION`;
    const resp = await fetch(url, { headers: { 'api_access_token': token }, signal: AbortSignal.timeout(30000) });
    if (resp.ok) { const data = await resp.json(); if (Array.isArray(data)) allRows.push(...data); }
    cur = winEnd;
    windows++;
    if (cur < endMs) await new Promise(r => setTimeout(r, 3200));
  }
  console.log(`Total rows CC: ${allRows.length}, janelas: ${windows}`);

  // Filtrar tickets da Lu
  const luRows = allRows.filter(r => r.firstAgentReplyName === 'Lu Almeida');
  console.log(`\nTickets da Lu Almeida no extract (sem filtro de data): ${luRows.length}`);

  // Separar: dentro do periodo vs fora
  const dentro = luRows.filter(r => r.resolvedAt && r.resolvedAt >= d0 && r.resolvedAt < d1 && r.ticketStatus === 'resolved');
  const foraData = luRows.filter(r => !r.resolvedAt || r.resolvedAt < d0 || r.resolvedAt >= d1);
  const naoResolved = luRows.filter(r => r.ticketStatus !== 'resolved');
  console.log(`  Dentro do periodo (resolved em SET): ${dentro.length}`);
  console.log(`  Fora do periodo (resolvedAt fora SET): ${foraData.length}`);
  console.log(`  Nao resolved: ${naoResolved.length}`);

  // Dos dentro do periodo: verificar filtros
  let semAssignTime = 0, semReplyTime = 0, rawNegativo = 0, bhNulo = 0, bhAcima = 0, incluidos = 0;
  const detalhes = [];

  for (const row of dentro) {
    if (!row.firstAgentAssignmentTime) { semAssignTime++; continue; }
    if (!row.firstAgentFirstReplyTime)  { semReplyTime++;  continue; }
    if (row.firstAgentReplyTimeMin == null || row.firstAgentReplyTimeMin < 0) { rawNegativo++; continue; }
    const BRT_OFFSET = 3 * 3600;
    const assignedTs = Math.round(new Date(row.firstAgentAssignmentTime + 'Z').getTime() / 1000) + BRT_OFFSET;
    const replyTs    = Math.round(new Date(row.firstAgentFirstReplyTime  + 'Z').getTime() / 1000) + BRT_OFFSET;
    const bhm = _bhMinsServer(assignedTs, replyTs);
    if (bhm === null) { bhNulo++; continue; }
    if (bhm > 10080) { bhAcima++; continue; }
    incluidos++;
    detalhes.push({ id: row.conversationId || row.ticketId, resolvedAt: row.resolvedAt, raw: row.firstAgentReplyTimeMin, bhm });
  }

  console.log(`\nFiltros aplicados (dos ${dentro.length} dentro do periodo):`);
  console.log(`  Sem firstAgentAssignmentTime: ${semAssignTime}`);
  console.log(`  Sem firstAgentFirstReplyTime: ${semReplyTime}`);
  console.log(`  firstAgentReplyTimeMin nulo/negativo: ${rawNegativo}`);
  console.log(`  bhm nulo (end<=start): ${bhNulo}`);
  console.log(`  bhm > 10080 (>1 semana): ${bhAcima}`);
  console.log(`  Incluidos no calculo: ${incluidos}`);

  if (incluidos) {
    const avg = detalhes.reduce((s,x) => s+x.bhm, 0) / incluidos;
    const sorted = [...detalhes].sort((a,b) => a.bhm - b.bhm);
    const mid = Math.floor(sorted.length/2);
    const median = sorted.length%2 ? sorted[mid].bhm : (sorted[mid-1].bhm + sorted[mid].bhm)/2;
    console.log(`\nResultado nosso: avg=${fmtMin(avg)} (${avg.toFixed(1)}min)  med=${fmtMin(median)} (${median.toFixed(1)}min)  n=${incluidos}`);

    // Top 5 maiores valores (puxam a média pra cima)
    console.log('\nTop 10 maiores BH mins:');
    sorted.slice(-10).reverse().forEach(r => {
      console.log(`  ticket ${r.id}  resolved=${r.resolvedAt}  raw=${r.raw}min  bh=${fmtMin(r.bhm)} (${r.bhm.toFixed(1)}min)`);
    });

    // Distribuicao
    const buckets = { '0-10':0, '10-30':0, '30-60':0, '60-120':0, '120-240':0, '240+':0 };
    detalhes.forEach(r => {
      if (r.bhm < 10) buckets['0-10']++;
      else if (r.bhm < 30) buckets['10-30']++;
      else if (r.bhm < 60) buckets['30-60']++;
      else if (r.bhm < 120) buckets['60-120']++;
      else if (r.bhm < 240) buckets['120-240']++;
      else buckets['240+']++;
    });
    console.log('\nDistribuicao (BH mins):');
    Object.entries(buckets).forEach(([k,v]) => console.log(`  ${k.padEnd(10)} ${v}`));

    // Se Henrique tem avg=2h16=136min e nos temos avg=1h51=111min, diferenca de 25min
    // Com quantos tickets Henrique teria chegar a 136min?
    const totalNosso = detalhes.reduce((s,x) => s+x.bhm, 0);
    console.log(`\nSoma total BH mins: ${totalNosso.toFixed(1)} / ${incluidos} tickets = ${avg.toFixed(1)} avg`);
    console.log(`Henrique: ~2h16 = 136min avg`);
    console.log(`Diferenca: ${(136 - avg).toFixed(1)} min a mais no Henrique`);
    console.log(`Para chegar a 136min com ${incluidos} tickets, soma seria ${(136*incluidos).toFixed(0)} vs nossa ${totalNosso.toFixed(0)}`);
    console.log(`Diferenca total: ${(136*incluidos - totalNosso).toFixed(0)} mins ausentes`);
  }

  await pool.end();
})().catch(e => { console.error(e.message); pool.end(); });
