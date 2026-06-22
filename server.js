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
  const todos = await getNegativeCsats(token, date, 500);
  const tickets = todos.filter(t => isAgentMonitorada(t.agent_on_resolution_name));

  const ticketIds = tickets.map(t => t.display_ticket_id).filter(Boolean);
  const labelsByTicket = await getTicketLabels(token, ticketIds);

  const por_agente = {};
  const tags_resumo = {};

  for (const t of tickets) {
    const nome = t.agent_on_resolution_name;
    por_agente[nome] = (por_agente[nome] || 0) + 1;
  }

  for (const tags of Object.values(labelsByTicket)) {
    for (const tag of tags) {
      tags_resumo[tag] = (tags_resumo[tag] || 0) + 1;
    }
  }

  const relatorio = {
    date,
    total: tickets.length,
    por_agente,
    tags_resumo,
    tickets: tickets.map(t => ({
      id: t.display_ticket_id,
      link: t.ticket_link,
      nota: t.csat_score,
      agente: t.agent_on_resolution_name,
      tags: labelsByTicket[t.display_ticket_id] || [],
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
        ['field', 174172, null],
        ['field', 174143, null],
        ['field', 174139, null],
        ['field', 174181, null],
        ['field', 174167, null],
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
  console.log('Banco de dados pronto.');
}

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)))
  .catch(err => { console.error('Erro ao inicializar:', err.message); process.exit(1); });
