// Verifica campos disponiveis no extract para tickets da Lu com BH alto
const BASE    = 'https://cloudchat3.cloudhumans.com';
const ACCOUNT = 73;
const TOKEN   = process.env.CLOUDCHAT_TOKEN;

function hdr() { return { 'api_access_token': TOKEN }; }

// Busca janela pequena de inicio de setembro para encontrar tickets altos
(async () => {
  // Janela de 01/ago a 11/set (para pegar o lookback dos tickets resolvidos em 01-11/set)
  const wins = [
    ['2026-07-18T00:00:00', '2026-07-23T00:00:00'],
    ['2026-07-23T00:00:00', '2026-07-28T00:00:00'],
    ['2026-07-28T00:00:00', '2026-08-02T00:00:00'],
  ];

  let found = [];
  for (const [s, e] of wins) {
    const url = `${BASE}/api/v2/accounts/${ACCOUNT}/data_extracts` +
      `?account_id=${ACCOUNT}&startDate=${encodeURIComponent(s)}&endDate=${encodeURIComponent(e)}` +
      `&type=TICKET_METRICS_WITH_AGENT_INFORMATION`;
    const r = await fetch(url, { headers: hdr(), signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.log(`${s} -> ${r.status}`); continue; }
    const data = await r.json();
    if (!Array.isArray(data)) { console.log('nao array:', typeof data); continue; }
    // Pega tickets da Lu com raw alto
    const lu = data.filter(d => d.firstAgentReplyName === 'Lu Almeida' && d.firstAgentReplyTimeMin > 10000);
    found.push(...lu);
    await new Promise(r => setTimeout(r, 3200));
  }

  if (!found.length) {
    // Mostra campos de qualquer ticket da Lu
    const url = `${BASE}/api/v2/accounts/${ACCOUNT}/data_extracts` +
      `?account_id=${ACCOUNT}&startDate=2026-07-18T00:00:00&endDate=2026-07-23T00:00:00` +
      `&type=TICKET_METRICS_WITH_AGENT_INFORMATION`;
    const r = await fetch(url, { headers: hdr(), signal: AbortSignal.timeout(30000) });
    const data = await r.json();
    const lu = (Array.isArray(data) ? data : []).filter(d => d.firstAgentReplyName === 'Lu Almeida');
    if (lu.length) {
      console.log('Campos disponiveis em 1 ticket da Lu:');
      console.log(JSON.stringify(Object.keys(lu[0]), null, 2));
      console.log('\nAmostra de 1 ticket:');
      const sample = {...lu[0]};
      // Mostra so campos de ID e tempo
      ['id','ticketId','conversationId','contactId','inboxId','inboxName',
       'firstAgentReplyTimeMin','firstAgentAssignmentTime','firstAgentFirstReplyTime',
       'resolvedAt','ticketStatus','firstAgentReplyName'].forEach(k => {
        if (sample[k] !== undefined) console.log(`  ${k}: ${sample[k]}`);
      });
    }
    return;
  }

  console.log(`Tickets Lu com raw>10000: ${found.length}`);
  found.slice(0, 3).forEach(t => {
    console.log('\nCampos de ID:');
    ['id','ticketId','conversationId','contactId'].forEach(k => {
      if (t[k] !== undefined) console.log(`  ${k}: ${t[k]}`);
    });
    console.log('Campos de tempo:');
    ['firstAgentReplyTimeMin','firstAgentAssignmentTime','firstAgentFirstReplyTime','resolvedAt'].forEach(k => {
      if (t[k] !== undefined) console.log(`  ${k}: ${t[k]}`);
    });
  });
})().catch(e => console.error(e.message));
