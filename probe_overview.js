'use strict';
// Investigacao: valores reais de availability_status por agente
// Executar: heroku run node probe_overview.js --app gestao-sup-ink

const BASE  = 'https://cloudchat3.cloudhumans.com';
const ACC   = 73;
const TOKEN = process.env.CLOUDCHAT_TOKEN;

const MONITORADAS = ['Mari', 'Fernanda Cavalcante', 'Paty', 'Lu Almeida', 'Rafa', 'Natchely Ortiz'];

async function main() {
  const r = await fetch(`${BASE}/api/v1/accounts/${ACC}/agents`, {
    headers: { 'api_access_token': TOKEN }
  });
  const agents = await r.json();
  const arr = Array.isArray(agents) ? agents : (agents.data || []);

  console.log('=== Todas as atendentes monitoradas ===');
  for (const ag of MONITORADAS) {
    const found = arr.find(a => a.name === ag);
    if (found) {
      console.log(`${ag}: availability_status="${found.availability_status}" | campos extras:`,
        Object.entries(found).filter(([k]) => k.includes('avail') || k.includes('status') || k.includes('busy') || k.includes('reason')).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', ')
      );
    } else {
      console.log(`${ag}: NÃO ENCONTRADA`);
    }
  }

  console.log('\n=== Amostra de 1 agente (todos os campos) ===');
  const sample = arr.find(a => MONITORADAS.includes(a.name));
  if (sample) console.log(JSON.stringify(sample, null, 2));
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
