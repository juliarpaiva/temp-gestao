'use strict';
// Investigacao: endpoint de status dos agentes (overview)
// Executar: heroku run node probe_overview.js --app gestao-sup-ink

const BASE  = 'https://cloudchat3.cloudhumans.com';
const ACC   = 73;
const TOKEN = process.env.CLOUDCHAT_TOKEN;

async function cc(path) {
  const r = await fetch(BASE + path, { headers: { 'api_access_token': TOKEN } });
  console.log(`GET ${path} → ${r.status}`);
  if (!r.ok) { console.log('Erro:', await r.text()); return null; }
  return r.json();
}

async function main() {
  // 1. Endpoint principal de overview
  console.log('\n=== 1. /reports/overview ===');
  const ov = await cc(`/api/v1/accounts/${ACC}/reports/overview`);
  if (ov) {
    console.log('Chaves raiz:', Object.keys(ov));
    console.log('ov.data?.agents (primeiros 3):', JSON.stringify((ov.data?.agents || ov.agents || []).slice(0, 3), null, 2));
    console.log('Total agentes:', (ov.data?.agents || ov.agents || []).length);
  }

  // 2. Endpoint alternativo de agentes online
  console.log('\n=== 2. /profile (lista de agentes com availability) ===');
  const ag = await cc(`/api/v1/profile`);
  if (ag) console.log('Chaves:', Object.keys(ag));

  // 3. Listar agentes da conta
  console.log('\n=== 3. /agents ===');
  const agents = await cc(`/api/v1/accounts/${ACC}/agents`);
  if (agents) {
    const arr = Array.isArray(agents) ? agents : (agents.data || []);
    console.log('Total:', arr.length);
    arr.slice(0, 5).forEach(a => console.log(`  ${a.name} → availability_status: ${a.availability_status}`));
  }
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
