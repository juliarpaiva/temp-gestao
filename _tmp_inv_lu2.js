// Investiga 8 tickets da Lu com BH > 72h uteis
// So leitura
const BASE    = 'https://cloudchat3.cloudhumans.com';
const ACCOUNT = 73;
const TOKEN   = process.env.CLOUDCHAT_TOKEN;

// IDs + dados do extract (bhm calculado antes)
const TICKETS = [
  { id: 894937,  bhm: 7255.1, resolvedAt: '2026-09-11' },
  { id: 910314,  bhm: 7207.8, resolvedAt: '2026-09-08' },
  { id: 901246,  bhm: 7207.3, resolvedAt: '2026-09-10' },
  { id: 878226,  bhm: 4931.0, resolvedAt: '2026-09-04' },
  { id: 899352,  bhm: 4929.3, resolvedAt: '2026-09-02' },
  { id: 912425,  bhm: 4929.0, resolvedAt: '2026-09-04' },
  { id: 895039,  bhm: 4359.9, resolvedAt: '2026-09-01' },
  { id: 910227,  bhm: 4359.6, resolvedAt: '2026-09-01' },
];

function hdr() { return { 'api_access_token': TOKEN }; }
async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: hdr(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) { console.warn(`  GET ${path} -> ${r.status}`); return null; }
  return r.json();
}
function fmtTs(ts) {
  if (!ts) return '—';
  const v = typeof ts === 'number' ? ts * 1000 : new Date(ts).getTime();
  return new Date(v).toISOString().slice(0, 16).replace('T', ' ') + ' BRT (aprox)';
}
function fmtBh(m) {
  const t = Math.round(m);
  return Math.floor(t/60) + 'h' + (t%60 ? ' ' + (t%60) + 'min' : '');
}

async function analyze({ id, bhm, resolvedAt }) {
  console.log(`\n${'─'.repeat(65)}`);
  console.log(`TICKET #${id}   BH: ${fmtBh(bhm)}   Resolvido em: ${resolvedAt}`);

  const conv = await get(`/api/v1/accounts/${ACCOUNT}/conversations/${id}`);
  if (!conv) return;

  // Dados basicos
  const criado = fmtTs(conv.created_at);
  console.log(`  Criado:    ${criado}`);
  console.log(`  Inbox:     ${conv.inbox_id}   Canal: ${conv.channel || conv.meta?.channel || '—'}`);
  console.log(`  Status:    ${conv.status}`);
  if (conv.meta?.assignee) console.log(`  Atrib atual: ${conv.meta.assignee.name}`);

  // Mensagens (inclui activities com message_type=2)
  const msgsResp = await get(`/api/v1/accounts/${ACCOUNT}/conversations/${id}/messages`);
  const msgs = (msgsResp?.payload || msgsResp || []).filter(Array.isArray(msgsResp?.payload || msgsResp) ? Boolean : () => false);
  const allMsgs = Array.isArray(msgsResp?.payload) ? msgsResp.payload :
                  Array.isArray(msgsResp) ? msgsResp : [];

  allMsgs.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

  // Activities (tipo 2): atribuicoes, reaberturas, etc.
  const activities = allMsgs.filter(m => m.message_type === 2);
  // Msgs de saida humana
  const outgoing  = allMsgs.filter(m => m.message_type === 1 && !m.private && !m.sender?.is_ai_agent);
  // Msgs de entrada (cliente)
  const incoming  = allMsgs.filter(m => m.message_type === 0);

  const primeiraEntrada = incoming[0];
  const primeiraResposta = outgoing[0];

  console.log(`  1ª msg cliente:  ${fmtTs(primeiraEntrada?.created_at)}`);
  console.log(`  1ª resp humana:  ${fmtTs(primeiraResposta?.created_at)}  por: ${primeiraResposta?.sender?.name || '—'}`);

  // Atribuicoes: filtrar activities com "assign" ou "atribu"
  const atribEvents = activities.filter(a => {
    const c = (a.content || '').toLowerCase();
    return c.includes('assign') || c.includes('atribu');
  });
  if (atribEvents.length) {
    console.log(`  Atribuicoes (${atribEvents.length}):`);
    atribEvents.forEach(a => console.log(`    ${fmtTs(a.created_at)}  "${a.content}"`));
  } else {
    console.log(`  Atribuicoes: nenhuma activity de atribuicao encontrada`);
  }

  // Reaberturas/resoluções
  const statusEvents = activities.filter(a => {
    const c = (a.content || '').toLowerCase();
    return c.includes('reopen') || c.includes('reabr') || c.includes('resolved') ||
           c.includes('resolvid') || c.includes('aberto') || c.includes('open');
  });
  if (statusEvents.length) {
    console.log(`  Status events (${statusEvents.length}):`);
    statusEvents.slice(0, 6).forEach(a => console.log(`    ${fmtTs(a.created_at)}  "${a.content}"`));
  }

  // Todas as activities para contexto
  if (activities.length && !atribEvents.length && !statusEvents.length) {
    console.log(`  Activities (${activities.length} total, primeiras 5):`);
    activities.slice(0, 5).forEach(a => console.log(`    ${fmtTs(a.created_at)}  "${(a.content||'').slice(0,80)}"`));
  }
}

// Verifica atividade da Lu nos dias criticos (01-11/set, quando esses tickets ficaram parados)
// Usa o extract que ja buscamos: filtra resolvedAt em outros periodos para ver se ela trabalhava
async function checkLuActivity() {
  console.log(`\n${'─'.repeat(65)}`);
  console.log('ATIVIDADE DA LU — 01-11/SET (outros tickets encerrados por ela)');
  // Busca conversas resolvidas pela Lu usando filter
  // Usa data_extracts para janela 01-11/set
  const endMs   = new Date('2026-09-12T00:00:00Z').getTime();
  const startMs = new Date('2026-09-01T00:00:00Z').getTime();
  const allRows = [];
  let cur = startMs;
  while (cur < endMs) {
    const winEnd = Math.min(cur + 5 * 86400000, endMs);
    const sStr = new Date(cur).toISOString().slice(0, 10) + 'T00:00:00';
    const eStr = new Date(winEnd).toISOString().slice(0, 10) + 'T00:00:00';
    const url  = `${BASE}/api/v2/accounts/${ACCOUNT}/data_extracts` +
      `?account_id=${ACCOUNT}&startDate=${encodeURIComponent(sStr)}&endDate=${encodeURIComponent(eStr)}` +
      `&type=TICKET_METRICS_WITH_AGENT_INFORMATION`;
    const r = await fetch(url, { headers: hdr(), signal: AbortSignal.timeout(30000) });
    if (r.ok) { const d = await r.json(); if (Array.isArray(d)) allRows.push(...d); }
    cur = winEnd;
    if (cur < endMs) await new Promise(r => setTimeout(r, 3200));
  }
  // Tickets resolvidos pela Lu nesse periodo
  const luTickets = allRows.filter(row =>
    row.firstAgentReplyName === 'Lu Almeida' &&
    row.ticketStatus === 'resolved' &&
    row.resolvedAt >= '2026-09-01' && row.resolvedAt < '2026-09-12'
  );
  // Conta por dia
  const porDia = {};
  luTickets.forEach(row => {
    const dia = (row.resolvedAt || '').slice(0, 10);
    if (!porDia[dia]) porDia[dia] = 0;
    porDia[dia]++;
  });
  console.log(`  Tickets resolvidos pela Lu em 01-11/set: ${luTickets.length}`);
  for (let d = new Date('2026-09-01'); d < new Date('2026-09-12'); d.setDate(d.getDate()+1)) {
    const dia = d.toISOString().slice(0, 10);
    const n   = porDia[dia] || 0;
    const dow = ['Dom','Seg','Ter','Qua','Qui','Sex','Sab'][d.getDay()];
    console.log(`    ${dia} (${dow})  ${n} tickets encerrados`);
  }
}

(async () => {
  for (const t of TICKETS) {
    await analyze(t);
    await new Promise(r => setTimeout(r, 600));
  }
  await checkLuActivity();
  console.log(`\nFIM`);
})().catch(e => console.error(e.message));
