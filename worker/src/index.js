const METABASE_URL = 'https://rsv-ink-metabase-f7ef97f28c72.herokuapp.com';
const METABASE_DATABASE_ID = 2;
const METABASE_TABLE_ID = 7375;

// Apenas esses agentes são monitorados no relatório
const AGENTES = ['Mari', 'Fernanda', 'Fer', 'Paty', 'Lu Almeida', 'Rafa'];

function isAgentMonitorada(nome) {
  if (!nome) return false;
  return AGENTES.some(a => nome.includes(a));
}

export default {
  // Disparado automaticamente pelo cron todo dia útil às 7h (Brasília)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyReport(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    // Saúde
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), { headers });
    }

    // Disparo manual — aceita ?date=YYYY-MM-DD para processar uma data específica
    if (url.pathname === '/run') {
      const dateParam = url.searchParams.get('date') || null;
      try {
        const resultado = await runDailyReport(env, dateParam);
        return new Response(JSON.stringify(resultado), { headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
      }
    }

    // Lista de datas com relatório salvo
    if (url.pathname === '/index') {
      const data = await env.CSAT_KV.get('csat:index');
      return new Response(data || '[]', { headers });
    }

    // Relatório de um dia específico — ex: /data/2026-06-20
    if (url.pathname.startsWith('/data/')) {
      const date = url.pathname.replace('/data/', '');
      const data = await env.CSAT_KV.get(`csat:${date}`);
      if (!data) {
        return new Response(JSON.stringify({ error: 'Data não encontrada' }), { status: 404, headers });
      }
      return new Response(data, { headers });
    }

    // Diagnóstico: últimos CSATs negativos das agentes monitoradas
    if (url.pathname === '/debug/csat') {
      try {
        const token = await getMetabaseToken(env);
        const todos = await getNegativeCsats(token, null, 50);
        const filtrados = todos.filter(t => isAgentMonitorada(t.agent_on_resolution_name));
        return new Response(JSON.stringify(filtrados, null, 2), { headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
      }
    }

    return new Response(JSON.stringify({ error: 'rota não encontrada' }), { status: 404, headers });
  },
};

// Função principal — gera e salva o relatório (do dia útil anterior ou de uma data específica)
async function runDailyReport(env, dateOverride = null) {
  const date = dateOverride || previousBusinessDate();

  // Não sobrescreve um dia já salvo
  const existing = await env.CSAT_KV.get(`csat:${date}`);
  if (existing) {
    return { status: 'ja_existe', date };
  }

  const token = await getMetabaseToken(env);
  const todos = await getNegativeCsats(token, date, 500);

  // Filtra apenas as agentes monitoradas
  const tickets = todos.filter(t => isAgentMonitorada(t.agent_on_resolution_name));

  // Agrupa por agente
  const por_agente = {};
  for (const t of tickets) {
    const nome = t.agent_on_resolution_name;
    por_agente[nome] = (por_agente[nome] || 0) + 1;
  }

  const relatorio = {
    date,
    total: tickets.length,
    por_agente,
    tickets: tickets.map(t => ({
      id: t.display_ticket_id,
      link: t.ticket_link,
      nota: t.csat_score,
      agente: t.agent_on_resolution_name,
    })),
  };

  // Salva o relatório no KV
  await env.CSAT_KV.put(`csat:${date}`, JSON.stringify(relatorio));

  // Atualiza o índice de datas disponíveis
  const indexRaw = await env.CSAT_KV.get('csat:index');
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(date)) {
    index.push(date);
    index.sort((a, b) => b.localeCompare(a)); // mais recente primeiro
    await env.CSAT_KV.put('csat:index', JSON.stringify(index));
  }

  console.log(`Relatório ${date} salvo: ${tickets.length} CSATs negativos`);
  return { status: 'salvo', date, total: tickets.length };
}

// Calcula o dia útil anterior (pula fins de semana)
function previousBusinessDate() {
  const date = new Date();
  date.setUTCHours(date.getUTCHours() - 3); // horário de Brasília
  date.setUTCDate(date.getUTCDate() - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() - 2); // domingo → sexta
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1); // sábado → sexta
  return date.toISOString().slice(0, 10);
}

// Faz login no Metabase e retorna o token de sessão
async function getMetabaseToken(env) {
  const resp = await fetch(`${METABASE_URL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: env.METABASE_EMAIL,
      password: env.METABASE_PASSWORD,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Falha no login Metabase (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  if (!data.id) throw new Error('Token de sessão não encontrado na resposta do Metabase');
  return data.id;
}

// Busca CSATs negativos (notas 1, 2 ou 3) de uma data específica
async function getNegativeCsats(token, date, limit = 500) {
  const filter = ['and',
    ['not-null', ['field', 174181, null]],
    ['<=', ['field', 174181, null], 3],
  ];

  if (date) {
    filter.push(['=', ['field', 174139, null], date]); // created_date_id
  }

  const data = await queryMetabase(token, {
    database: METABASE_DATABASE_ID,
    type: 'query',
    query: {
      'source-table': METABASE_TABLE_ID,
      filter,
      fields: [
        ['field', 174172, null], // display_ticket_id
        ['field', 174143, null], // ticket_link
        ['field', 174139, null], // created_date_id
        ['field', 174181, null], // csat_score
        ['field', 174167, null], // agent_on_resolution_name
      ],
      'order-by': [['desc', ['field', 174139, null]]],
      limit,
    },
  });

  const cols = data.data.cols.map(c => c.name);
  return data.data.rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// Executa uma consulta no Metabase
async function queryMetabase(token, query) {
  const resp = await fetch(`${METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Metabase-Session': token,
    },
    body: JSON.stringify(query),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Falha na consulta Metabase (${resp.status}): ${body}`);
  }

  return resp.json();
}
