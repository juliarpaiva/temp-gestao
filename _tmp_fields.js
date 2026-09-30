// Ver TODOS os campos do extract e buscar ID correto da conversa no CloudChat
const BASE    = 'https://cloudchat3.cloudhumans.com';
const ACCOUNT = 73;
const TOKEN   = process.env.CLOUDCHAT_TOKEN;
function hdr() { return { 'api_access_token': TOKEN }; }

(async () => {
  // Busca janela pequena para pegar 1 ticket qualquer
  const url = `${BASE}/api/v2/accounts/${ACCOUNT}/data_extracts` +
    `?account_id=${ACCOUNT}&startDate=2026-07-18T00:00:00&endDate=2026-07-23T00:00:00` +
    `&type=TICKET_METRICS_WITH_AGENT_INFORMATION`;
  const r = await fetch(url, { headers: hdr(), signal: AbortSignal.timeout(30000) });
  const data = await r.json();
  const sample = Array.isArray(data) && data[0];
  if (!sample) { console.log('nenhum dado'); return; }

  console.log('=== TODOS OS CAMPOS DO EXTRACT ===');
  console.log(JSON.stringify(Object.keys(sample), null, 2));
  console.log('\n=== VALORES DO PRIMEIRO TICKET ===');
  console.log(JSON.stringify(sample, null, 2));

  // Tenta buscar a conversa pelo ticketId como display_id
  const tid = sample.ticketId;
  console.log(`\n=== TESTE: buscar conversa com display_id=${tid} ===`);
  // CloudChat usa display_id diferente do id interno — busca via search ou filter
  const searchR = await fetch(`${BASE}/api/v1/accounts/${ACCOUNT}/conversations/filter`, {
    method: 'POST',
    headers: { ...hdr(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: [{ attribute_key: 'display_id', filter_operator: 'equal_to', values: [String(tid)], query_operator: null }]
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (searchR.ok) {
    const sr = await searchR.json();
    console.log(`Filter result: ${JSON.stringify(sr).slice(0, 300)}`);
  } else {
    console.log(`Filter status: ${searchR.status}`);
  }
})().catch(e => console.error(e.message));
