// Investigacao final: 8 tickets Lu com BH > 72h em SET/2026
// Usa extract (createdAt, assignmentTime, replyTime, inboxName)
// + API conversations para activities (atribuicao, reabertura)
// + contagem de tickets encerrados por dia (atividade da Lu)
const BASE    = 'https://cloudchat3.cloudhumans.com';
const ACCOUNT = 73;
const TOKEN   = process.env.CLOUDCHAT_TOKEN;
function hdr() { return { 'api_access_token': TOKEN }; }
async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: hdr(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  return r.json();
}
function fmtTs(s) {
  if (!s) return '—';
  return String(s).slice(0, 16).replace('T', ' ');
}
function fmtBh(m) {
  const t = Math.round(m);
  return Math.floor(t/60) + 'h' + (t%60 ? ' ' + (t%60) + 'min' : '');
}
function _bhMins(start_s, end_s) {
  if (!start_s || !end_s || end_s <= start_s) return null;
  const BRT_OFF = -3*3600000, INICIO=9*60, FIM=18*60+30, DIAS=[1,2,3,4,5];
  const startMs=start_s*1000+BRT_OFF, endMs=end_s*1000+BRT_OFF;
  let total=0;
  const d=new Date(startMs); d.setUTCHours(0,0,0,0);
  while(d.getTime()<endMs){
    if(DIAS.includes(d.getUTCDay())){
      const o=d.getTime()+INICIO*60000,c=d.getTime()+FIM*60000;
      const f=Math.max(startMs,o),t2=Math.min(endMs,c);
      if(t2>f)total+=(t2-f)/60000;
    }
    d.setUTCDate(d.getUTCDate()+1);
  }
  return total;
}

// PASSO 1: Buscar extract com lookback 45 dias para SET/2026
// Periodo do extract: 01/ago a 01/out (cobre assignmentTimes de ago e resolvedAt de set)
async function fetchExtract(d0, d1) {
  const endMs=new Date(d1+'T00:00:00Z').getTime();
  const startMs=new Date(d0+'T00:00:00Z').getTime();
  const rows=[];
  let cur=startMs;
  while(cur<endMs){
    const winEnd=Math.min(cur+5*86400000,endMs);
    const sStr=new Date(cur).toISOString().slice(0,10)+'T00:00:00';
    const eStr=new Date(winEnd).toISOString().slice(0,10)+'T00:00:00';
    const url=`${BASE}/api/v2/accounts/${ACCOUNT}/data_extracts?account_id=${ACCOUNT}&startDate=${encodeURIComponent(sStr)}&endDate=${encodeURIComponent(eStr)}&type=TICKET_METRICS_WITH_AGENT_INFORMATION`;
    const r=await fetch(url,{headers:hdr(),signal:AbortSignal.timeout(30000)});
    if(r.ok){const d=await r.json();if(Array.isArray(d))rows.push(...d);}
    cur=winEnd;
    if(cur<endMs)await new Promise(r=>setTimeout(r,3200));
  }
  return rows;
}

(async () => {
  console.log('Buscando extract ago-out 2026 (janelas de 5 dias)...');
  // Lookback de 45 dias: de 17/jul a 01/out (para pegar assignmentTimes de ago e resolvedAt de set)
  const rows = await fetchExtract('2026-07-17', '2026-10-01');
  console.log(`Total rows: ${rows.length}`);

  // Filtra Lu resolvidos em SET/2026
  const luSET = rows.filter(r =>
    r.firstAgentReplyName === 'Lu Almeida' &&
    r.ticketStatus === 'resolved' &&
    r.resolvedAt >= '2026-09-01' && r.resolvedAt < '2026-10-01' &&
    r.firstAgentAssignmentTime && r.firstAgentFirstReplyTime &&
    r.firstAgentReplyTimeMin >= 0
  );

  // Calcula BH para cada um
  const BRT_OFFSET = 3*3600;
  const withBh = luSET.map(row => {
    const assignedTs = Math.round(new Date(row.firstAgentAssignmentTime+'Z').getTime()/1000)+BRT_OFFSET;
    const replyTs    = Math.round(new Date(row.firstAgentFirstReplyTime+'Z').getTime()/1000)+BRT_OFFSET;
    const bhm = _bhMins(assignedTs, replyTs);
    return { ...row, bhm };
  }).filter(r => r.bhm !== null && r.bhm >= 72*60); // > 72h uteis

  console.log(`\nTickets da Lu com BH >= 72h em SET/2026: ${withBh.length}`);
  withBh.sort((a,b) => b.bhm - a.bhm);

  // Contagem de tickets por dia (para ver atividade da Lu)
  const luSETall = rows.filter(r =>
    r.firstAgentReplyName === 'Lu Almeida' &&
    r.ticketStatus === 'resolved' &&
    r.resolvedAt >= '2026-09-01' && r.resolvedAt < '2026-10-01'
  );
  const porDia = {};
  luSETall.forEach(r => {
    const d = (r.resolvedAt||'').slice(0,10);
    if(!porDia[d]) porDia[d]=0;
    porDia[d]++;
  });

  // PASSO 2: Para cada ticket, busca messages via API (displayTicketId)
  for (const t of withBh) {
    console.log(`\n${'─'.repeat(65)}`);
    console.log(`Ticket #${t.displayTicketId} (ticketId interno: ${t.ticketId})`);
    console.log(`  BH atrib→resp:    ${fmtBh(t.bhm)} (${t.bhm.toFixed(0)} min)`);
    console.log(`  Raw (relogio):    ${t.firstAgentReplyTimeMin?.toFixed(0)} min`);
    console.log(`  Inbox:            ${t.inboxName}`);
    console.log(`  Criado em:        ${fmtTs(t.createdAt)}`);
    console.log(`  Atrib. ao agente: ${fmtTs(t.firstAgentAssignmentTime)}`);
    console.log(`  1a resp humana:   ${fmtTs(t.firstAgentFirstReplyTime)}`);
    console.log(`  Resolvido em:     ${fmtTs(t.resolvedAt)}`);

    // Intervalo de espera: dias uteis entre atribuicao e resposta
    const assignDt = t.firstAgentAssignmentTime.slice(0,10);
    const replyDt  = t.firstAgentFirstReplyTime.slice(0,10);
    console.log(`  Periodo parado:   ${assignDt} → ${replyDt}`);

    // Atividade da Lu nos dias de espera (tickets encerrados)
    const daysParado = [];
    const d = new Date(assignDt+'T12:00:00Z');
    const dEnd = new Date(replyDt+'T12:00:00Z');
    while (d <= dEnd) {
      const ds = d.toISOString().slice(0,10);
      const dow = ['Dom','Seg','Ter','Qua','Qui','Sex','Sab'][d.getDay()];
      if(![0,6].includes(d.getDay())) daysParado.push({ ds, dow, n: porDia[ds]||0 });
      d.setDate(d.getDate()+1);
    }
    console.log(`  Lu trabalhava? (tickets encerrados por ela nos dias uteis do intervalo):`);
    daysParado.forEach(({ds,dow,n}) => console.log(`    ${ds} (${dow}): ${n} tickets`));

    // Busca messages/activities via API
    await new Promise(r => setTimeout(r, 400));
    const msgsResp = await get(`/api/v1/accounts/${ACCOUNT}/conversations/${t.displayTicketId}/messages`);
    const allMsgs = Array.isArray(msgsResp?.payload) ? msgsResp.payload :
                    Array.isArray(msgsResp) ? msgsResp : [];
    allMsgs.sort((a,b)=>(a.created_at||0)-(b.created_at||0));

    // Activities de atribuicao e status
    const acts = allMsgs.filter(m => m.message_type === 2);
    const atribActs = acts.filter(a => {
      const c=(a.content||'').toLowerCase();
      return c.includes('assign') || c.includes('atribu');
    });
    const statusActs = acts.filter(a => {
      const c=(a.content||'').toLowerCase();
      return c.includes('reopen') || c.includes('reabr') || c.includes('resolved') ||
             c.includes('resolvid') || c.includes('conversacao foi aberta') || c.includes('aberta');
    });

    if (atribActs.length) {
      console.log(`  Atribuicoes (${atribActs.length}):`);
      atribActs.forEach(a => console.log(`    ${fmtTs(a.created_at)}  "${a.content}"`));
    } else if (acts.length) {
      console.log(`  Activities (sem atribuicao especifica, mostrando primeiras 3 de ${acts.length}):`);
      acts.slice(0,3).forEach(a => console.log(`    ${fmtTs(a.created_at)}  "${(a.content||'').slice(0,80)}"`));
    } else {
      console.log(`  Sem activities disponiveis via API`);
    }

    if (statusActs.length) {
      console.log(`  Reaberturas/resolutions (${statusActs.length}):`);
      statusActs.forEach(a => console.log(`    ${fmtTs(a.created_at)}  "${a.content}"`));
    }
  }

  console.log(`\n${'='.repeat(65)}`);
  console.log('FIM DA INVESTIGACAO');
})().catch(e=>console.error(e.message));
