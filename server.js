const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

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

// ── Auth ─────────────────────────────────────────────────────────────────────

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const SESSION_DAYS   = 7;

function signSession(email) {
  const exp     = Date.now() + SESSION_DAYS * 86400000;
  const payload = `${email}|${exp}`;
  const sig     = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}

function verifySession(token) {
  if (!token) return null;
  try {
    const dot = token.lastIndexOf('.');
    const b64 = token.slice(0, dot);
    const sig  = token.slice(dot + 1);
    const payload  = Buffer.from(b64, 'base64').toString();
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    const [email, exp] = payload.split('|');
    if (Date.now() > parseInt(exp)) return null;
    return email;
  } catch { return null; }
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise((res, rej) =>
    crypto.scrypt(pw, salt, 64, (e, h) => e ? rej(e) : res(h)));
  return salt + ':' + hash.toString('hex');
}

async function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const derived = await new Promise((res, rej) =>
    crypto.scrypt(pw, salt, 64, (e, h) => e ? rej(e) : res(h)));
  return derived.toString('hex') === hash;
}

function getSessionToken(req) {
  return (req.headers.cookie || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith('csat_sess='))?.slice('csat_sess='.length) || null;
}

const AUTH_SKIP = ['/login', '/logout', '/register', '/forgot-password', '/reset-password', '/health', '/run', '/webhook/csat-invalida', '/admin/indevidas-junho', '/admin/importar-indevidas', '/admin/schema-invalida'];

// ── Email / reset de senha ────────────────────────────────────────────────────

function getMailer() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });
}

async function sendResetEmail(email, link, isNew) {
  const mailer  = getMailer();
  const subject = isNew ? 'Crie sua senha — Painel CSAT INK' : 'Recuperação de acesso — Painel CSAT INK';
  const titulo  = isNew ? 'Bem-vindo(a) ao Painel CSAT INK!' : 'Recuperação de acesso';
  const intro   = isNew
    ? 'Sua conta foi criada. Clique no botão abaixo para definir sua senha (válido por 48 horas).'
    : 'Olá, por favor.<br>Clique no link abaixo para recuperar seu acesso ao painel de gestão.';
  const label   = isNew ? 'Criar minha senha' : 'Recuperar meu acesso';
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:#f8f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;padding:40px 16px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
        <!-- Header -->
        <tr><td style="background:#0f0f0f;border-bottom:3px solid #e91e8c;padding:20px 32px">
          <span style="font-size:22px;font-weight:900;letter-spacing:-1px;color:#fff">INK<span style="color:#e91e8c">.</span></span>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:36px 32px 28px">
          <h2 style="margin:0 0 16px;font-size:18px;font-weight:800;color:#0f0f0f">${titulo}</h2>
          <p style="margin:0 0 28px;font-size:14px;color:#475569;line-height:1.6">${intro}</p>
          <a href="${link}" style="display:inline-block;background:#e91e8c;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 28px;border-radius:8px;letter-spacing:.2px">${label}</a>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 32px 28px;border-top:1px solid #f1f5f9">
          <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.5">Se você não solicitou isso, ignore este e-mail. Este link expira em ${isNew ? '48 horas' : '1 hora'}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  if (mailer) {
    await mailer.sendMail({ from: `"CSAT INK" <${process.env.SMTP_USER}>`, to: email, subject, html });
    console.log('[email] enviado para', email);
  } else {
    console.log('[reset-link] SMTP não configurado. Link:', link);
  }
}

app.get('/me', (req, res) => {
  const email = verifySession(getSessionToken(req));
  if (!email) return res.status(401).json({ error: 'Não autorizado' });
  const part      = email.split('@')[0];
  const first     = part.split('.')[0];
  const firstName = first.charAt(0).toUpperCase() + first.slice(1);
  res.json({ email, firstName });
});

app.post('/change-password', express.json(), async (req, res) => {
  const email = verifySession(getSessionToken(req));
  if (!email) return res.status(401).json({ error: 'Não autorizado' });
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword !== confirmPassword)
    return res.json({ error: 'Dados inválidos.' });
  if (newPassword.length < 8 || !/\d/.test(newPassword) || /^[a-zA-Z0-9]*$/.test(newPassword))
    return res.json({ error: 'A nova senha não atende aos requisitos.' });
  try {
    const r = await pool.query('SELECT password_hash FROM support_bi.csat_users WHERE email=$1', [email]);
    if (!r.rows.length || !r.rows[0].password_hash)
      return res.json({ error: 'Usuário não encontrado.' });
    const ok = await checkPassword(currentPassword, r.rows[0].password_hash);
    if (!ok) return res.json({ error: 'Senha atual incorreta.' });
    const hash = await hashPassword(newPassword);
    await pool.query('UPDATE support_bi.csat_users SET password_hash=$1 WHERE email=$2', [hash, email]);
    res.json({ ok: true });
  } catch(e) { res.json({ error: 'Erro interno.' }); }
});

app.get('/register', (req, res) => res.sendFile(__dirname + '/site/register.html'));

app.post('/register', express.urlencoded({ extended: false }), async (req, res) => {
  const email    = (req.body.email    || '').toLowerCase().trim();
  const password = req.body.password  || '';
  const confirm  = req.body.confirm   || '';
  if (!email.endsWith('@reserva.ink'))
    return res.redirect('/register?erro=dominio');
  if (password.length < 8 || !/\d/.test(password) || /^[a-zA-Z0-9]*$/.test(password))
    return res.redirect('/register?erro=senha');
  if (password !== confirm)
    return res.redirect('/register?erro=confirm');
  try {
    const exists = await pool.query('SELECT 1 FROM support_bi.csat_users WHERE email=$1', [email]);
    if (exists.rows.length) return res.redirect('/register?erro=existe');
    const hash = await hashPassword(password);
    await pool.query(
      'INSERT INTO support_bi.csat_users (email, password_hash) VALUES ($1,$2)',
      [email, hash]);
    res.redirect('/login?cadastro=ok');
  } catch(e) {
    console.error('[register]', e.message);
    res.redirect('/register?erro=1');
  }
});

app.get('/forgot-password', (req, res) => res.sendFile(__dirname + '/site/forgot-password.html'));

app.post('/forgot-password', express.urlencoded({ extended: false }), async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.redirect('/forgot-password?erro=email');
  try {
    const r = await pool.query('SELECT email FROM support_bi.csat_users WHERE email=$1', [email]);
    if (r.rows.length) {
      const token   = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 3600000);
      await pool.query(
        `INSERT INTO support_bi.csat_reset_tokens (email, token, expires_at) VALUES ($1,$2,$3)`,
        [email, token, expires]);
      const base = process.env.APP_URL || 'https://csat-sup-ink.herokuapp.com';
      sendResetEmail(email, `${base}/reset-password?token=${token}`, false).catch(e => console.error('[email]', e.message));
    }
    res.redirect('/forgot-password?enviado=1');
  } catch(e) {
    console.error('[forgot-password]', e.message);
    res.redirect('/forgot-password?erro=1');
  }
});

app.get('/reset-password', (req, res) => res.sendFile(__dirname + '/site/reset-password.html'));

app.post('/reset-password', express.urlencoded({ extended: false }), async (req, res) => {
  const token    = (req.body.token || '').trim();
  const password = req.body.password || '';
  const confirm  = req.body.confirm  || '';
  const r2 = encodeURIComponent(token);
  if (!token || !password || password !== confirm)
    return res.redirect(`/reset-password?token=${r2}&erro=campos`);
  if (password.length < 8 || !/\d/.test(password) || /^[a-zA-Z0-9]*$/.test(password))
    return res.redirect(`/reset-password?token=${r2}&erro=curta`);
  try {
    const r = await pool.query(
      `SELECT email FROM support_bi.csat_reset_tokens
       WHERE token=$1 AND expires_at > NOW() AND used_at IS NULL`, [token]);
    if (!r.rows.length)
      return res.redirect(`/reset-password?token=${r2}&erro=expirado`);
    const email = r.rows[0].email;
    const hash  = await hashPassword(password);
    await pool.query('UPDATE support_bi.csat_users SET password_hash=$1 WHERE email=$2', [hash, email]);
    await pool.query('UPDATE support_bi.csat_reset_tokens SET used_at=NOW() WHERE token=$1', [token]);
    res.redirect('/login?senha=ok');
  } catch(e) {
    console.error('[reset-password]', e.message);
    res.redirect(`/reset-password?token=${r2}&erro=1`);
  }
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Rotas públicas — login.html sem autenticação
app.get('/login', (req, res) => res.sendFile(__dirname + '/site/login.html'));

app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  const email    = (req.body.email || '').toLowerCase().trim();
  const password = req.body.password || '';
  const redir    = (req.body.redirect || '/').replace(/[^a-zA-Z0-9/_\-.?=&]/g, '');
  if (!email || !password) return res.redirect('/login?erro=campos');
  try {
    const r = await pool.query(
      'SELECT password_hash FROM support_bi.csat_users WHERE email = $1', [email]);
    if (!r.rows.length) return res.redirect('/login?erro=1');
    const ok = await checkPassword(password, r.rows[0].password_hash);
    if (!ok) return res.redirect('/login?erro=1');
    const token = signSession(email);
    res.setHeader('Set-Cookie',
      `csat_sess=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
    res.redirect(redir || '/');
  } catch(e) {
    console.error('[login]', e.message);
    res.redirect('/login?erro=1');
  }
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'csat_sess=; Path=/; Max-Age=0');
  res.redirect('/login');
});

// Endpoint para criar/atualizar usuário (protegido por ADMIN_KEY)
app.post('/admin/add-user', express.json(), async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Proibido' });
  const { email, name, password, invite } = req.body;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });
  const em = email.toLowerCase().trim();
  try {
    if (password) {
      const hash = await hashPassword(password);
      await pool.query(
        `INSERT INTO support_bi.csat_users (email, name, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET name=$2, password_hash=$3`,
        [em, name || null, hash]);
    } else {
      await pool.query(
        `INSERT INTO support_bi.csat_users (email, name, password_hash)
         VALUES ($1, $2, NULL)
         ON CONFLICT (email) DO UPDATE SET name=$2`,
        [em, name || null]);
    }
    if (invite || !password) {
      const token   = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 48 * 3600000);
      await pool.query(
        `INSERT INTO support_bi.csat_reset_tokens (email, token, expires_at) VALUES ($1,$2,$3)`,
        [em, token, expires]);
      const base = process.env.APP_URL || 'https://csat-sup-ink.herokuapp.com';
      const link = `${base}/reset-password?token=${token}`;
      sendResetEmail(em, link, true).catch(e => console.error('[email]', e.message));
      return res.json({ ok: true, email: em, invite_link: link });
    }
    res.json({ ok: true, email: em });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Middleware de autenticação — protege todas as outras rotas
app.use((req, res, next) => {
  if (AUTH_SKIP.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (req.method === 'POST' && req.path === '/login') return next();
  const email = verifySession(getSessionToken(req));
  if (email) return next();
  const isHtml = req.path.endsWith('.html') || req.path === '/' || (req.headers.accept || '').includes('text/html');
  if (isHtml) return res.redirect('/login?r=' + encodeURIComponent(req.url));
  res.status(401).json({ error: 'Não autorizado' });
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

// Lista todas as tabelas do banco 2 no Metabase e busca por campos CSAT/invalid
app.get('/admin/schema-invalida', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  try {
    const token = await getMetabaseToken();

    // Lista todas as tabelas e seus campos via Metabase API de metadados
    const metaResp = await fetch(`${METABASE_URL}/api/database/${METABASE_DATABASE_ID}/metadata?include_hidden=true`, {
      headers: { 'X-Metabase-Session': token },
    });
    if (!metaResp.ok) throw new Error(`Falha metadata (${metaResp.status})`);
    const meta = await metaResp.json();

    const tabelas = (meta.tables || []).map(t => ({
      id: t.id,
      schema: t.schema,
      name: t.name,
      display_name: t.display_name,
      campos: (t.fields || []).map(f => f.name),
    }));

    // Tabelas com "csat", "rating", "evaluation", "satisfaction" no nome
    const csatTabelas = tabelas.filter(t =>
      /csat|rating|evaluation|satisfaction|avaliacao/i.test(t.name + ' ' + t.display_name)
    );

    // Campos com "invalid", "indevid", "validade" em QUALQUER tabela
    const camposInvalidos = [];
    for (const t of tabelas) {
      for (const f of (t.campos || [])) {
        if (/invalid|indevid|validade|csat_status/i.test(f)) {
          camposInvalidos.push({ tabela: t.name, campo: f });
        }
      }
    }

    res.json({
      total_tabelas: tabelas.length,
      tabelas_csat: csatTabelas,
      campos_invalidos_encontrados: camposInvalidos,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Descoberta + importação de indevidas históricas ──────────────────────────

// Retorna todos os campos do CSAT de junho + todas as labels únicas
// → Use para identificar onde está armazenado o flag "indevida" no Metabase
app.get('/admin/indevidas-junho', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  try {
    const token = await getMetabaseToken();

    // Busca todos os CSATs de junho com TODOS os campos (sem filtro de fields)
    const csatData = await queryMetabase(token, {
      database: METABASE_DATABASE_ID,
      type: 'query',
      query: {
        'source-table': METABASE_TABLE_ID,
        filter: ['and',
          ['>=', ['field', 174139, null], '2026-06-01'],
          ['<=', ['field', 174139, null], '2026-06-30'],
        ],
        limit: 2000,
      },
    });

    const cols = csatData.data.cols.map(c => ({ name: c.name, display_name: c.display_name }));
    const rows = csatData.data.rows.map(row => {
      const obj = {};
      cols.forEach((col, i) => { obj[col.name] = row[i]; });
      return obj;
    });

    // Pega IDs únicos para buscar labels
    const ticketIds = [...new Set(rows.map(r => r.display_ticket_id).filter(Boolean))];

    // Busca TODAS as colunas da tabela de labels para esses tickets
    let allLabelRows = [];
    let labelCols = [];
    if (ticketIds.length > 0) {
      const filter = ticketIds.length === 1
        ? ['=', ['field', 174185, null], ticketIds[0]]
        : ['or', ...ticketIds.slice(0, 500).map(id => ['=', ['field', 174185, null], id])];

      const labData = await queryMetabase(token, {
        database: METABASE_DATABASE_ID,
        type: 'query',
        query: {
          'source-table': METABASE_LABELS_TABLE_ID,
          filter,
          limit: 5000,
        },
      });
      labelCols = labData.data.cols.map(c => ({ name: c.name, display_name: c.display_name }));
      allLabelRows = labData.data.rows.map(row => {
        const obj = {};
        labelCols.forEach((col, i) => { obj[col.name] = row[i]; });
        return obj;
      });
    }

    const uniqueLabels = [...new Set(allLabelRows.map(l => l.label_name).filter(Boolean))].sort();

    res.json({
      total_junho: rows.length,
      ticket_ids_unicos: ticketIds.length,
      // Todos os campos disponíveis na tabela CSAT (7375)
      colunas_csat: cols,
      // Todos os campos disponíveis na tabela de labels (7376)
      colunas_labels: labelCols,
      // Labels únicos de todos os tickets de junho
      labels_unicos: uniqueLabels,
      // Amostra de 5 tickets com todos os campos para inspecionar
      amostra_csat: rows.slice(0, 5),
      // Amostra de 10 labels para ver formato
      amostra_labels: allLabelRows.slice(0, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Importa lista de indevidas históricas e reprocessa as datas afetadas
// Body: { tickets: [{ticket_id, date, motivo?, observacao?}] }
app.post('/admin/importar-indevidas', express.json(), async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const { tickets } = req.body || {};
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return res.status(400).json({ error: 'tickets deve ser um array não-vazio com {ticket_id, date}' });
  }

  let importados = 0;
  const erros = [];
  const datesParaReprocessar = new Set();

  for (const t of tickets) {
    if (!t.ticket_id || !t.date) { erros.push({ ticket: t, msg: 'ticket_id ou date ausente' }); continue; }
    try {
      await pool.query(
        `INSERT INTO support_bi.csat_indevidas (ticket_id, date, motivo, observacao)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ticket_id) DO UPDATE SET motivo=$3, observacao=$4, marcado_em=NOW()`,
        [String(t.ticket_id), t.date, t.motivo || 'importacao_historica', t.observacao || null]
      );
      importados++;
      datesParaReprocessar.add(t.date);
    } catch (e) {
      erros.push({ ticket_id: t.ticket_id, msg: e.message });
    }
  }

  // Reprocessa cada data afetada (com force=true)
  const resultados = [];
  for (const date of [...datesParaReprocessar].sort()) {
    try {
      const r = await runDailyReport(date, true);
      resultados.push({ date, status: 'ok', ...r });
    } catch (e) {
      resultados.push({ date, status: 'erro', error: e.message });
    }
  }

  res.json({ importados, erros, datas_reprocessadas: resultados });
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
              COALESCE(data->'por_agente_outros', '{}')         AS por_agente_outros,
              data->'tags_resumo'                               AS tags_resumo,
              COALESCE(data->'tags_resumo_positivos', '{}')    AS tags_resumo_positivos
       FROM support_bi.csat_reports
       WHERE date >= (CURRENT_DATE - INTERVAL '90 days')::text
       ORDER BY date ASC`
    );
    const meses = {}, semanas = {};
    for (const row of result.rows) {
      const { date, total = 0, total_recebidos = 0, total_avaliados = 0, total_positivos = 0, por_agente = {}, por_agente_positivos = {}, por_agente_outros = {}, tags_resumo = {}, tags_resumo_positivos = {} } = row;
      const mesChave = date.slice(0, 7);
      if (!meses[mesChave]) meses[mesChave] = { total: 0, total_recebidos: 0, total_avaliados: 0, total_positivos: 0, dias: 0, por_agente: {}, por_agente_positivos: {}, por_agente_outros: {}, tags: {}, tags_positivos: {} };
      meses[mesChave].total           += total;
      meses[mesChave].total_recebidos += total_recebidos;
      meses[mesChave].total_avaliados += total_avaliados;
      meses[mesChave].total_positivos += total_positivos;
      meses[mesChave].dias++;
      for (const [a, c] of Object.entries(por_agente))          meses[mesChave].por_agente[a]          = (meses[mesChave].por_agente[a]          || 0) + c;
      for (const [a, c] of Object.entries(por_agente_positivos)) meses[mesChave].por_agente_positivos[a] = (meses[mesChave].por_agente_positivos[a] || 0) + c;
      for (const [a, c] of Object.entries(por_agente_outros))    meses[mesChave].por_agente_outros[a]    = (meses[mesChave].por_agente_outros[a]    || 0) + c;
      for (const [t, c] of Object.entries(tags_resumo))           meses[mesChave].tags[t]           = (meses[mesChave].tags[t]           || 0) + c;
      for (const [t, c] of Object.entries(tags_resumo_positivos)) meses[mesChave].tags_positivos[t] = (meses[mesChave].tags_positivos[t] || 0) + c;
      const d   = new Date(date + 'T12:00:00Z');
      const dow = d.getUTCDay();
      const mon = new Date(d);
      mon.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
      const semChave = mon.toISOString().slice(0, 10);
      if (!semanas[semChave]) semanas[semChave] = { total: 0, total_recebidos: 0, total_avaliados: 0, total_positivos: 0, dias: 0, por_agente: {}, por_agente_positivos: {}, por_agente_outros: {}, pior_dia: null, pior_total: 0 };
      semanas[semChave].total           += total;
      semanas[semChave].total_recebidos += total_recebidos;
      semanas[semChave].total_avaliados += total_avaliados;
      semanas[semChave].total_positivos += total_positivos;
      semanas[semChave].dias++;
      for (const [a, c] of Object.entries(por_agente))          semanas[semChave].por_agente[a]          = (semanas[semChave].por_agente[a]          || 0) + c;
      for (const [a, c] of Object.entries(por_agente_positivos)) semanas[semChave].por_agente_positivos[a] = (semanas[semChave].por_agente_positivos[a] || 0) + c;
      for (const [a, c] of Object.entries(por_agente_outros))    semanas[semChave].por_agente_outros[a]    = (semanas[semChave].por_agente_outros[a]    || 0) + c;
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

app.get('/last-update', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT date, data->>'generated_at' AS generated_at
       FROM support_bi.csat_reports
       ORDER BY date DESC
       LIMIT 1`
    );
    if (!result.rows.length) return res.json({ generated_at: null });
    res.json(result.rows[0]);
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

  // Tickets de agentes não monitoradas (inclui IA, gestão, etc.)
  const outrosTickets = comNota.filter(t => !isAgentMonitorada(t.agent_on_resolution_name));
  const por_agente_outros = {};
  for (const t of outrosTickets) {
    const nome = t.agent_on_resolution_name || 'Sem interação com agente';
    por_agente_outros[nome] = (por_agente_outros[nome] || 0) + 1;
  }
  const tickets_outros = outrosTickets.map(t => ({
    id:       t.display_ticket_id,
    link:     t.ticket_link || `https://cloudchat3.cloudhumans.com/app/accounts/73/conversations/${t.display_ticket_id}`,
    nota:     t.csat_score,
    agente:   t.agent_on_resolution_name || 'Sem interação com agente',
    feedback: (t.csat_feedback || '').slice(0, 200),
  }));

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
    por_agente_outros,
    tags_resumo,
    tags_resumo_positivos,
    tickets_outros,
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_bi.csat_users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT,
      password_hash TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_bi.csat_reset_tokens (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      token      TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE support_bi.csat_users ALTER COLUMN password_hash DROP NOT NULL`).catch(() => {});
  console.log('Banco de dados pronto.');
}

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)))
  .catch(err => { console.error('Erro ao inicializar:', err.message); process.exit(1); });
