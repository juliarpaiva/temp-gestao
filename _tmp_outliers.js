// 1. Média/mediana da Lu sem os 9 outliers
// 2. Outras agentes com tickets BH > 72h em SET/2026
// Só leitura
const BASE    = 'https://cloudchat3.cloudhumans.com';
const ACCOUNT = 73;
const TOKEN   = process.env.CLOUDCHAT_TOKEN;
function hdr() { return { 'api_access_token': TOKEN }; }

const MONITORED = ['Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz'];
const LU_OUTLIER_DISPLAY_IDS = new Set([37454, 41962, 42959, 42444, 40412, 42321, 43036, 41978, 42957]);

function _bhMins(start_s, end_s) {
  if (!start_s || !end_s || end_s <= start_s) return null;
  const BRT_OFF=-3*3600000, INICIO=9*60, FIM=18*60+30, DIAS=[1,2,3,4,5];
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
function fmtBh(m){ const t=Math.round(m); return Math.floor(t/60)+'h'+(t%60?' '+(t%60)+'min':''); }
function med(arr){ const s=[...arr].sort((a,b)=>a-b),m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }

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
  console.log('Buscando extract 17/jul–01/out...');
  const rows = await fetchExtract('2026-07-17', '2026-10-01');
  console.log(`Total rows: ${rows.length}\n`);

  const BRT_OFFSET=3*3600;

  // Para cada agente monitorada: calcula BH de todos os tickets resolvidos em SET/2026
  // e separa outliers (BH > 72h) com analise de padrao
  const agentData = {}; // agente -> { all: [], outliers: [] }

  // Conta tickets por agente por dia (para detectar periodos sem atendimento)
  const porAgenteDia = {}; // agente -> { dia -> count }

  for (const row of rows) {
    const ag = row.firstAgentReplyName;
    if (!MONITORED.includes(ag)) continue;
    if (!row.resolvedAt || row.ticketStatus !== 'resolved') continue;

    // Conta por dia (qualquer periodo, para mapear presenca)
    const dia = (row.resolvedAt||'').slice(0,10);
    if (!porAgenteDia[ag]) porAgenteDia[ag] = {};
    porAgenteDia[ag][dia] = (porAgenteDia[ag][dia]||0)+1;

    // Só considera resolucoes em SET/2026 para a metrica
    if (row.resolvedAt < '2026-09-01' || row.resolvedAt >= '2026-10-01') continue;
    if (row.firstAgentReplyTimeMin == null || row.firstAgentReplyTimeMin < 0) continue;
    if (!row.firstAgentAssignmentTime || !row.firstAgentFirstReplyTime) continue;

    const assignedTs = Math.round(new Date(row.firstAgentAssignmentTime+'Z').getTime()/1000)+BRT_OFFSET;
    const replyTs    = Math.round(new Date(row.firstAgentFirstReplyTime+'Z').getTime()/1000)+BRT_OFFSET;
    const bhm = _bhMins(assignedTs, replyTs);
    if (bhm === null || bhm < 0 || bhm > 10080) continue;

    if (!agentData[ag]) agentData[ag] = { all: [], outliers: [] };
    agentData[ag].all.push({ displayId: row.displayTicketId, bhm, assignedAt: row.firstAgentAssignmentTime, createdAt: row.createdAt, resolvedAt: row.resolvedAt });
  }

  // ─── 1. Lu sem os 9 outliers ───────────────────────────────────────
  console.log('═'.repeat(60));
  console.log('1. LU ALMEIDA — SET/2026 SEM OS 9 OUTLIERS');
  const luAll = agentData['Lu Almeida']?.all || [];
  const luSem = luAll.filter(t => !LU_OUTLIER_DISPLAY_IDS.has(t.displayId));
  const luCom = luAll;
  const luAvgCom = luCom.reduce((s,x)=>s+x.bhm,0)/luCom.length;
  const luAvgSem = luSem.reduce((s,x)=>s+x.bhm,0)/luSem.length;
  console.log(`  Com outliers:  n=${luCom.length}  avg=${fmtBh(luAvgCom)} (${luAvgCom.toFixed(1)}min)  med=${fmtBh(med(luCom.map(x=>x.bhm)))}`);
  console.log(`  Sem outliers:  n=${luSem.length}  avg=${fmtBh(luAvgSem)} (${luAvgSem.toFixed(1)}min)  med=${fmtBh(med(luSem.map(x=>x.bhm)))}`);

  // ─── 2. Todas as agentes: outliers BH > 72h ────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('2. OUTLIERS BH > 72h EM SET/2026 — TODAS AS AGENTES');

  for (const ag of MONITORED) {
    const tickets = agentData[ag]?.all || [];
    const outliers = tickets.filter(t => t.bhm >= 72*60);
    if (!outliers.length) {
      console.log(`\n${ag}: nenhum outlier > 72h`);
      continue;
    }
    console.log(`\n${ag}: ${outliers.length} outlier(s)`);
    outliers.sort((a,b) => b.bhm - a.bhm);

    for (const t of outliers) {
      const assignDt = (t.assignedAt||'').slice(0,10);
      const replyDt  = (t.resolvedAt||'').slice(0,10); // aproximacao: usa resolvedAt como referencia
      // Verifica se assignedAt e anterior a SET (atribuido antes da agente ter a chance de ver)
      const atribAntesSet = assignDt < '2026-09-01';
      // Verifica presenca da agente nos dias de espera (tickets encerrados)
      const diasEspera = [];
      const d = new Date(assignDt+'T12:00:00Z');
      const dEnd = new Date(t.resolvedAt.slice(0,10)+'T12:00:00Z');
      let diasSemAtiv = 0, diasComAtiv = 0;
      while (d < dEnd) {
        const ds = d.toISOString().slice(0,10);
        if (![0,6].includes(d.getDay())) {
          const n = porAgenteDia[ag]?.[ds] || 0;
          if (n === 0) diasSemAtiv++; else diasComAtiv++;
          diasEspera.push({ ds, n });
        }
        d.setDate(d.getDate()+1);
      }
      console.log(`  #${t.displayId}  BH=${fmtBh(t.bhm)}  criado=${t.createdAt?.slice(0,10)}  atrib=${assignDt}  resolvido=${t.resolvedAt?.slice(0,10)}`);
      console.log(`    Atrib antes de SET: ${atribAntesSet ? 'SIM' : 'não'}  |  Dias úteis sem atividade da agente no período: ${diasSemAtiv}/${diasSemAtiv+diasComAtiv}`);
      if (diasEspera.length <= 20) {
        diasEspera.forEach(({ds,n}) => {
          const dow=['Dom','Seg','Ter','Qua','Qui','Sex','Sab'][new Date(ds+'T12:00:00Z').getDay()];
          process.stdout.write(`    ${ds}(${dow}):${n}  `);
        });
        console.log();
      }
    }

    // Impacto na média
    const semOutliers = tickets.filter(t => t.bhm < 72*60);
    if (semOutliers.length && outliers.length) {
      const avgCom = tickets.reduce((s,x)=>s+x.bhm,0)/tickets.length;
      const avgSem = semOutliers.reduce((s,x)=>s+x.bhm,0)/semOutliers.length;
      console.log(`  → avg com: ${fmtBh(avgCom)} | avg sem: ${fmtBh(avgSem)} | diferença: ${fmtBh(avgCom-avgSem)}`);
    }
  }

  console.log('\nFIM');
})().catch(e=>console.error(e.message));
