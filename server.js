const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const METABASE_URL = 'https://rsv-ink-metabase-f7ef97f28c72.herokuapp.com';
const METABASE_DATABASE_ID = 2;
const METABASE_TABLE_ID = 7375;
const METABASE_LABELS_TABLE_ID = 7376;
const AGENTES = ['Mari', 'Fernanda', 'Fer', 'Paty', 'Lu Almeida', 'Rafa'];

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static('site'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Webhook do CloudChat — "Avaliação de CSAT é inválida?"
app.post('/webhook/csat-invalida', express.json(), express.urlencoded({ extended: true }), async (req, res) => {
  const payload = req.body;

  // conversation_url = ".../conversations/25285" → ticketId = "25285"
  const convUrl  = payload.conversation_url || '';
  const ticketId = (convUrl.split('/conversations/')[1] || '').trim() || null;

  // created_at chega como Unix timestamp (número) → converte para YYYY-MM-DD
  const createdAtTs = Number(payload.created_at);
  const date = createdAtTs ? new Date(createdAtTs * 1000).toISOString().slice(0, 10) : null;

  console.log(`[webhook] ticket=${ticketId} date=${date} agent=${payload.agent_display_name}`);

  if (!ticketId || !date) {
    return res.status(400).json({ ok: false, msg: 'campos nao identificados', ticket_id: ticketId, date });
  }

  await pool.query(
    `INSERT INTO support_bi.csat_indevidas (ticket_id, date, motivo, observacao)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ticket_id) DO UPDATE SET motivo=$3, observacao=$4, marcado_em=NOW()`,
    [ticketId, date, 'cloudchat_webhook', payload.agent_display_name || null]
  );

  // Re-processa o dia automaticamente — exclui indevidas dos totais
  runDailyReport(date, true)
    .then(r => console.log('[webhook] reprocessamento concluido:', r))
    .catch(e => console.error('[webhook] erro no reprocessamento:', e.message));

  res.json({ ok: true, ticket_id: ticketId, date, status: 'indevida salva, reprocessando...' });
});

// ?date=YYYY-MM-DD para data específica, ?force=true para reprocessar
app.get('/run', async (req, res) => {
  const dateParam = req.query.date || null;
  const force = req.query.force === 'true';
  try {
    const resultado = await runDailyReport(dateParam, force);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/index', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT date FROM support_bi.csat_reports ORDER BY date DESC'
    );
    res.json(result.rows.map(r => r.date));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retorna datas com totais — usado pelo calendário para mostrar contagem por dia
app.get('/summary', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT date,
              (data->>'total')::int                            AS total,
              COALESCE((data->>'total_avaliados')::int, 0)     AS total_avaliados,
              COALESCE((data->>'total_positivos')::int, 0)     AS total_positivos
       FROM support_bi.csat_reports
       ORDER BY date DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/indevidas/:date', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT ticket_id, motivo, observacao, marcado_em FROM support_bi.csat_indevidas WHERE date = $1',
      [req.params.date]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/indevida', express.json(), async (req, res) => {
  const { ticket_id, date, motivo, observacao } = req.body;
  if (!ticket_id || !date) return res.status(400).json({ error: 'ticket_id e date são obrigatórios' });
  try {
    await pool.query(
      `INSERT INTO support_bi.csat_indevidas (ticket_id, date, motivo, observacao)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ticket_id) DO UPDATE SET motivo=$3, observacao=$4, marcado_em=NOW()`,
      [ticket_id, date, motivo || null, observacao || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/indevida/:ticket_id', async (req, res) => {
  try {
    await pool.query('DELETE FROM support_bi.csat_indevidas WHERE ticket_id = $1', [req.params.ticket_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/indevidas-resumo', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT ticket_id, date, motivo, observacao, marcado_em FROM support_bi.csat_indevidas ORDER BY marcado_em DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/gestao', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT date,
              (data->>'total')::int                             AS total,
              COALESCE((data->>'total_recebidos')::int, 0)      AS total_recebidos,
              COALESCE((data->>'total_avaliados')::int, 0)      AS total_avaliados,
              COALESCE((data->>'total_positivos')::int, 0)      AS total_positivos,
              data->'por_agente'                                AS por_agente,
              data->'por_agente_positivos'                      AS por_agente_positivos,
              data->'tags_resumo'                               AS tags_resumo,
              COALESCE(data->'tags_resumo_positivos', '{}')    AS tags_resumo_positivos
       FROM support_bi.csat_reports
       WHERE date >= (CURRENT_DATE - INTERVAL '90 days')::text
       ORDER BY date ASC`
    );
    const meses = {}, semanas = {};
    for (const row of result.rows) {
      const { date, total = 0, total_recebidos = 0, total_avaliados = 0, total_positivos = 0, por_agente = {}, por_agente_positivos = {}, tags_resumo = {}, tags_resumo_positivos = {} } = row;
      const mesChave = date.slice(0, 7);
      if (!meses[mesChave]) meses[mesChave] = { total: 0, total_recebidos: 0, total_avaliados: 0, total_positivos: 0, dias: 0, por_agente: {}, por_agente_positivos: {}, tags: {}, tags_positivos: {} };
      meses[mesChave].total           += total;
      meses[mesChave].total_recebidos += total_recebidos;
      meses[mesChave].total_avaliados += total_avaliados;
      meses[mesChave].total_positivos += total_positivos;
      meses[mesChave].dias++;
      for (const [a, c] of Object.entries(por_agente))          meses[mesChave].por_agente[a]          = (meses[mesChave].por_agente[a]          || 0) + c;
      for (const [a, c] of Object.entries(por_agente_positivos)) meses[mesChave].por_agente_positivos[a] = (meses[mesChave].por_agente_positivos[a] || 0) + c;
      for (const [t, c] of Object.entries(tags_resumo))           meses[mesChave].tags[t]           = (meses[mesChave].tags[t]           || 0) + c;
      for (const [t, c] of Object.entries(tags_resumo_positivos)) meses[mesChave].tags_positivos[t] = (meses[mesChave].tags_positivos[t] || 0) + c;
      const d   = new Date(date + 'T12:00:00Z');
      const dow = d.getUTCDay();
      const mon = new Date(d);
      mon.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
      const semChave = mon.toISOString().slice(0, 10);
      if (!semanas[semChave]) semanas[semChave] = { total: 0, total_recebidos: 0, total_avaliados: 0, total_positivos: 0, dias: 0, por_agente: {}, por_agente_positivos: {}, pior_dia: null, pior_total: 0 };
      semanas[semChave].total           += total;
      semanas[semChave].total_recebidos += total_recebidos;
      semanas[semChave].total_avaliados += total_avaliados;
      semanas[semChave].total_positivos += total_positivos;
      semanas[semChave].dias++;
      for (const [a, c] of Object.entries(por_agente))          semanas[semChave].por_agente[a]          = (semanas[semChave].por_agente[a]          || 0) + c;
      for (const [a, c] of Object.entries(por_agente_positivos)) semanas[semChave].por_agente_positivos[a] = (semanas[semChave].por_agente_positivos[a] || 0) + c;
      if (total > semanas[semChave].pior_total) { semanas[semChave].pior_total = total; semanas[semChave].pior_dia = date; }
    }
    res.json({ meses, semanas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/agent-history/:name', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT date, data->'por_agente' AS por_agente
       FROM support_bi.csat_reports
       WHERE date >= (CURRENT_DATE - INTERVAL '60 days')::text
       ORDER BY date ASC`
    );
    const history = result.rows.map(r => ({
      date: r.date,
      count: (r.por_agente || {})[req.params.name] || 0,
    })).filter(r => r.count > 0);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/data/:date', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT data FROM support_bi.csat_reports WHERE date = $1',
      [req.params.date]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Data não encontrada' });
    }
    res.json(result.rows[0].data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cron: todo dia útil às 10h UTC (7h Brasília)
cron.schedule('0 10 * * 1-5', () => {
  console.log('Cron disparado — processando dia útil anterior...');
  runDailyReport(null, false).catch(err => console.error('Erro no cron:', err.message));
});

// --- Lógica principal ---

function isAgentMonitorada(nome) {
  if (!nome) return false;
  return AGENTES.some(a => nome.includes(a));
}

async function runDailyReport(dateOverride = null, force = false) {
  const date = dateOverride || previousBusinessDate();

  const existing = await pool.query(
    'SELECT 1 FROM support_bi.csat_reports WHERE date = $1',
    [date]
  );
  if (existing.rows.length > 0 && !force) return { status: 'ja_existe', date };

  const token = await getMetabaseToken();

  // Tickets marcados como indevidos para esse dia são excluídos dos totais
  const indevidasRes = await pool.query(
    'SELECT ticket_id FROM support_bi.csat_indevidas WHERE date = $1',
    [date]
  );
  const indevidasSet = new Set(indevidasRes.rows.map(r => String(r.ticket_id)));

  const todosCsats    = await getAllCsats(token, date, 2000);
  const comNota       = todosCsats.filter(t => t.csat_score !== null);
  const negativosAll  = comNota.filter(t => t.csat_score <= 3);
  const positivosAll  = comNota.filter(t => t.csat_score >= 4);
  const tickets              = negativosAll.filter(t => isAgentMonitorada(t.agent_on_resolution_name) && !indevidasSet.has(String(t.display_ticket_id)));
  const positivosMonitorados = positivosAll.filter(t => isAgentMonitorada(t.agent_on_resolution_name));

  const ticketIds = [
    ...tickets.map(t => t.display_ticket_id),
    ...positivosMonitorados.map(t => t.display_ticket_id),
  ].filter(Boolean);
  const labelsByTicket = await getTicketLabels(token, ticketIds);

  const por_agente = {};
  const por_agente_positivos = {};
  const tags_resumo = {};

  for (const t of tickets) {
    const nome = t.agent_on_resolution_name;
    por_agente[nome] = (por_agente[nome] || 0) + 1;
  }

  for (const t of positivosAll.filter(t => isAgentMonitorada(t.agent_on_resolution_name))) {
    const nome = t.agent_on_resolution_name;
    por_agente_positivos[nome] = (por_agente_positivos[nome] || 0) + 1;
  }

  for (const t of tickets) {
    for (const tag of (labelsByTicket[t.display_ticket_id] || [])) {
      tags_resumo[tag] = (tags_resumo[tag] || 0) + 1;
    }
  }
  const tags_resumo_positivos = {};
  for (const t of positivosMonitorados) {
    for (const tag of (labelsByTicket[t.display_ticket_id] || [])) {
      tags_resumo_positivos[tag] = (tags_resumo_positivos[tag] || 0) + 1;
    }
  }

  const relatorio = {
    date,
    generated_at: new Date().toISOString(),
    indevidas_removidas: indevidasSet.size,
    total: tickets.length,
    total_recebidos: comNota.length,
    total_avaliados: tickets.length + positivosMonitorados.length,
    total_positivos: positivosMonitorados.length,
    total_negativos: tickets.length,
    por_agente,
    por_agente_positivos,
    tags_resumo,
    tags_resumo_positivos,
    tickets_positivos: positivosMonitorados.map(t => ({
      id: t.display_ticket_id,
      link: t.ticket_link,
      nota: t.csat_score,
      agente: t.agent_on_resolution_name,
      tags: labelsByTicket[t.display_ticket_id] || [],
      cliente_nome: t.contact_name || null,
      cliente_email: t.contact_email || null,
      feedback: t.csat_feedback || null,
    })),
    tickets: tickets.map(t => ({
      id: t.display_ticket_id,
      link: t.ticket_link,
      nota: t.csat_score,
      agente: t.agent_on_resolution_name,
      tags: labelsByTicket[t.display_ticket_id] || [],
      cliente_nome: t.contact_name || null,
      cliente_email: t.contact_email || null,
      feedback: t.csat_feedback || null,
    })),
  };

  await pool.query(
    `INSERT INTO support_bi.csat_reports (date, data) VALUES ($1, $2)
     ON CONFLICT (date) DO UPDATE SET data = $2, created_at = NOW()`,
    [date, JSON.stringify(relatorio)]
  );

  console.log(`Relatório ${date} salvo: ${tickets.length} CSATs negativos`);
  return { status: 'salvo', date, total: tickets.length };
}

async function getTicketLabels(token, ticketIds) {
  if (!ticketIds || ticketIds.length === 0) return {};

  const filter = ticketIds.length === 1
    ? ['=', ['field', 174185, null], ticketIds[0]]
    : ['or', ...ticketIds.map(id => ['=', ['field', 174185, null], id])];

  const data = await queryMetabase(token, {
    database: METABASE_DATABASE_ID,
    type: 'query',
    query: {
      'source-table': METABASE_LABELS_TABLE_ID,
      filter,
      fields: [
        ['field', 174185, null], // display_ticket_id
        ['field', 174188, null], // label_name
      ],
      limit: 1000,
    },
  });

  const cols = data.data.cols.map(c => c.name);
  const rows = data.data.rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });

  const labelsByTicket = {};
  for (const row of rows) {
    const id = row.display_ticket_id;
    if (!labelsByTicket[id]) labelsByTicket[id] = [];
    labelsByTicket[id].push(row.label_name);
  }
  return labelsByTicket;
}

function previousBusinessDate() {
  const date = new Date();
  date.setUTCHours(date.getUTCHours() - 3);
  date.setUTCDate(date.getUTCDate() - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() - 2);
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function getMetabaseToken() {
  const resp = await fetch(`${METABASE_URL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.METABASE_EMAIL,
      password: process.env.METABASE_PASSWORD,
    }),
  });
  if (!resp.ok) throw new Error(`Falha no login Metabase (${resp.status})`);
  const data = await resp.json();
  if (!data.id) throw new Error('Token de sessão não encontrado');
  return data.id;
}

async function getAllCsats(token, date, limit = 2000) {
  const filter = date
    ? ['=', ['field', 174139, null], date]
    : ['not-null', ['field', 174139, null]];

  const data = await queryMetabase(token, {
    database: METABASE_DATABASE_ID,
    type: 'query',
    query: {
      'source-table': METABASE_TABLE_ID,
      filter,
      fields: [
        ['field', 174172, null],
        ['field', 174143, null],
        ['field', 174139, null],
        ['field', 174181, null],
        ['field', 174167, null],
        ['field', 174169, null],
        ['field', 174174, null],
        ['field', 174140, null],
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

async function getNegativeCsats(token, date, limit = 500) {
  const filter = ['and',
    ['not-null', ['field', 174181, null]],
    ['<=', ['field', 174181, null], 3],
  ];
  if (date) filter.push(['=', ['field', 174139, null], date]);

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
        ['field', 174169, null], // contact_name
        ['field', 174174, null], // contact_email
        ['field', 174140, null], // csat_feedback
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

async function queryMetabase(token, query) {
  const resp = await fetch(`${METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Metabase-Session': token,
    },
    body: JSON.stringify(query),
  });
  if (!resp.ok) throw new Error(`Falha na consulta Metabase (${resp.status})`);
  return resp.json();
}

// --- Inicialização ---

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_bi.csat_reports (
      date       VARCHAR(10) PRIMARY KEY,
      data       JSONB       NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_bi.csat_indevidas (
      ticket_id  VARCHAR(50) PRIMARY KEY,
      date       VARCHAR(10) NOT NULL,
      motivo     VARCHAR(100),
      observacao TEXT,
      marcado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Banco de dados pronto.');
}

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)))
  .catch(err => { console.error('Erro ao inicializar:', err.message); process.exit(1); });
