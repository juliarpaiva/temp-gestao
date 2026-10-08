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
const AGENTES = ['Mari', 'Fernanda', 'Fer', 'Paty', 'Lu Almeida', 'Rafa', 'Natchely'];

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

const AUTH_SKIP = ['/login', '/logout', '/register', '/forgot-password', '/reset-password', '/health', '/run', '/webhook/csat-invalida', '/admin/indevidas-junho', '/admin/importar-indevidas', '/admin/schema-invalida', '/admin/puxar-indevidas-cloudchat', '/admin/diagnostico-junho', '/admin/corrigir-datas-indevidas', '/admin/clear-ops-cache', '/admin/reprocess-all', '/backlog-tickets', '/admin/check-stale-csat', '/admin/mark-indevida', '/admin/breakdown-recebidos', '/admin/setup-reply-times', '/admin/process-reply-times', '/admin/reply-times-status', '/admin/report-tag-times', '/admin/first-reply-outliers', '/admin/snoozed-tickets', '/admin/reprocess-indevidas', '/admin/csat-debug'];

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

  // Limpa cache de ops para forçar recálculo com a nova indevida
  pool.query(`DELETE FROM support_bi.kpis_op_cache`).catch(() => {});

  // Reprocessa pelo dia de RESOLUÇÃO (fonte do CSAT agora) — busca no DW
  // Também reprocessa data de criação como fallback caso não encontre resolução
  (async () => {
    try {
      const rows = await dwQuery(`SELECT DATE(resolved_at_local)::text FROM dw.fact_cloudchat_tickets WHERE display_ticket_id = '${ticketId}' AND resolved_at_local IS NOT NULL LIMIT 1`);
      const resolvedDate = (rows.length > 0 && rows[0][0]) ? rows[0][0] : date;
      console.log(`[webhook] reprocessando data resolucao=${resolvedDate} (criacao=${date})`);
      await runDailyReport(resolvedDate, true);
      if (resolvedDate !== date) await runDailyReport(date, true);
    } catch(e) {
      console.error('[webhook] erro no reprocessamento:', e.message);
      runDailyReport(date, true).catch(() => {});
    }
  })();

  res.json({ ok: true, ticket_id: ticketId, date, status: 'indevida salva, reprocessando...' });
});

// ?date=YYYY-MM-DD para data específica, ?force=true para reprocessar
app.get('/run', async (req, res) => {
  const dateParam = req.query.date || null;
  const force = req.query.force === 'true';
  try {
    const resultado = await runDailyReport(dateParam, force);
    if (force) {
      pool.query(`DELETE FROM support_bi.kpis_op_cache WHERE period_key LIKE 'semana:%' OR period_key LIKE 'mes:%' OR period_key LIKE 'dia:%'`)
        .catch(() => {});
    }
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
    pool.query(`DELETE FROM support_bi.kpis_op_cache`).catch(() => {});
    (async () => {
      try {
        const rows = await dwQuery(`SELECT DATE(resolved_at_local)::text FROM dw.fact_cloudchat_tickets WHERE display_ticket_id = '${ticket_id}' AND resolved_at_local IS NOT NULL LIMIT 1`);
        const resolvedDate = (rows.length > 0 && rows[0][0]) ? rows[0][0] : date;
        await runDailyReport(resolvedDate, true);
        if (resolvedDate !== date) await runDailyReport(date, true);
      } catch(e) {
        runDailyReport(date, true).catch(() => {});
      }
    })();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnóstico de CSAT por agente — mostra o que está no banco para o período
app.get('/admin/csat-debug', async (req, res) => {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const d0 = req.query.inicio || new Date().toISOString().slice(0, 10);
  const d1 = req.query.fim   || d0;
  const d1next = new Date(d1 + 'T12:00:00Z'); d1next.setUTCDate(d1next.getUTCDate() + 1);
  const d1str = d1next.toISOString().slice(0, 10);
  try {
    const [repRows, indevRows] = await Promise.all([
      pool.query(`SELECT date::text, data->>'por_agente' AS neg, data->>'por_agente_positivos' AS pos FROM support_bi.csat_reports WHERE date >= $1 AND date < $2 ORDER BY date`, [d0, d1str]),
      pool.query(`SELECT ticket_id, date::text FROM support_bi.csat_indevidas WHERE date >= $1 AND date < $2 ORDER BY date`, [d0, d1str]),
    ]);
    const csatByAgent = {};
    for (const row of repRows.rows) {
      const neg = JSON.parse(row.neg || '{}');
      const pos = JSON.parse(row.pos || '{}');
      for (const [ag, n] of Object.entries(neg)) { if (!csatByAgent[ag]) csatByAgent[ag] = { neg: 0, pos: 0 }; csatByAgent[ag].neg += n; }
      for (const [ag, p] of Object.entries(pos)) { if (!csatByAgent[ag]) csatByAgent[ag] = { neg: 0, pos: 0 }; csatByAgent[ag].pos += p; }
    }
    const csatCalc = {};
    for (const [ag, d] of Object.entries(csatByAgent)) {
      csatCalc[ag] = d.pos + d.neg > 0 ? Math.round(d.pos / (d.pos + d.neg) * 100) + '%' : 'null';
    }
    res.json({ periodo: { d0, d1: d1str }, dias: repRows.rows.length, indevidas: indevRows.rows, csat_por_agente: csatByAgent, csat_calculado: csatCalc });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

const CLOUDCHAT_BASE = 'https://cloudchat3.cloudhumans.com';
const CLOUDCHAT_ACCOUNT = 73;

async function fetchCloudChat(path, token, method = 'GET', body = null, timeoutMs = 30000) {
  const ac  = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  const opts = {
    method,
    headers: { 'api_access_token': token, 'Content-Type': 'application/json' },
    signal: ac.signal,
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const resp = await fetch(`${CLOUDCHAT_BASE}${path}`, opts);
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`CloudChat ${resp.status}: ${text.slice(0, 200)}`);
      err.httpStatus = resp.status;
      throw err;
    }
    return resp.json();
  } finally {
    clearTimeout(tid);
  }
}

// Cache de bot handoff (última msg da Claudia bot antes de transferir para fila humana)
const _botHandoffCache = new Map();
async function getBotHandoffUnix(ticketId, token) {
  const key = String(ticketId);
  const hit = _botHandoffCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  try {
    const data = await fetchCloudChat(
      `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${ticketId}/messages`, token
    );
    const msgs = Array.isArray(data.payload) ? data.payload : (Array.isArray(data) ? data : []);
    // Última mensagem pública de saída de um agente IA = transferência para fila humana
    const botMsgs = msgs.filter(m => m.sender?.is_ai_agent && m.message_type === 1 && !m.private);
    botMsgs.sort((a, b) => b.created_at - a.created_at);
    const v = botMsgs.length > 0 ? botMsgs[0].created_at : null;
    _botHandoffCache.set(key, { v, exp: Date.now() + 3600000 });
    return v;
  } catch {
    _botHandoffCache.set(key, { v: null, exp: Date.now() + 60000 });
    return null;
  }
}

function addOneDay(date) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function fetchCsatSurveysCC(d0, d1) {
  const ccToken = process.env.CLOUDCHAT_TOKEN;
  if (!ccToken) return null;
  // Usa meia-noite horário de Brasília (UTC-3) para alinhar com o Painel CSAT
  const since = Math.floor(new Date(d0 + 'T03:00:00Z').getTime() / 1000);
  const until  = Math.floor(new Date(d1 + 'T03:00:00Z').getTime() / 1000);
  let all = [];
  let page = 1;
  while (true) {
    const data = await fetchCloudChat(
      `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/csat_survey_responses?since=${since}&until=${until}&page=${page}`,
      ccToken
    );
    const items = Array.isArray(data) ? data : (data.data || []);
    if (!items.length) break;
    all = all.concat(items);
    if (items.length < 25) break;
    page++;
    if (page > 80) break;
  }
  return all;
}

function calcCsatCC(surveys) {
  if (!surveys || !surveys.length) return null;
  const rated = surveys.filter(s => s.rating != null);
  if (!rated.length) return null;
  const pos = rated.filter(s => s.rating >= 4).length;
  return Math.round(pos / rated.length * 1000) / 10; // positivas ÷ total, igual ao Painel CSAT
}

// Puxar todas as indevidas históricas de junho via CloudChat API e importar
// Etapas: (1) CSATs de junho, (2) conversas com avaliao_de_csat_vlida=true, (3) cruzamento + import
app.get('/admin/puxar-indevidas-cloudchat', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const token = process.env.CLOUDCHAT_TOKEN;
  if (!token) return res.status(500).json({ error: 'CLOUDCHAT_TOKEN não configurado' });

  const dryRun = req.query.dry !== 'false'; // por padrão só simula; use ?dry=false para importar de verdade
  const since = Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000);
  const until = Math.floor(new Date('2026-06-30T23:59:59Z').getTime() / 1000);

  try {
    // ── Etapa 1: Todos os CSATs de junho ────────────────────────────────────
    let csatsJunho = [];
    let page = 1;
    while (true) {
      const data = await fetchCloudChat(
        `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/csat_survey_responses?since=${since}&until=${until}&page=${page}`,
        token
      );
      const items = Array.isArray(data) ? data : (data.data || []);
      if (!items.length) break;
      csatsJunho = csatsJunho.concat(items);
      if (items.length < 25) break;
      page++;
      if (page > 40) break; // segurança: máx 1000 itens
    }

    // Mapeia conversation_id → dados do CSAT (data + agente)
    const csatPorConversa = {};
    for (const c of csatsJunho) {
      if (!c.conversation_id) continue;
      const date = new Date(c.created_at * 1000).toISOString().slice(0, 10);
      csatPorConversa[c.conversation_id] = {
        conversation_id: c.conversation_id,
        date,
        score: c.rating,
        agente: c.assigned_agent?.name || null,
      };
    }

    // ── Etapa 2: Conversas marcadas como indevida (avaliao_de_csat_vlida=true) ─
    let conversasIndevidas = [];
    let filterPage = 1;
    while (true) {
      const data = await fetchCloudChat(
        `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/filter?page=${filterPage}`,
        token,
        'POST',
        {
          payload: [
            {
              attribute_key: 'avaliao_de_csat_vlida',
              filter_operator: 'equal_to',
              values: [true],
              query_operator: null,
            },
          ],
        }
      );
      const items = data?.data?.payload || data?.payload || [];
      if (!items.length) break;
      conversasIndevidas = conversasIndevidas.concat(items);
      const meta = data?.data?.meta || data?.meta || {};
      if (conversasIndevidas.length >= (meta.all_count || conversasIndevidas.length)) break;
      if (items.length < 25) break;
      filterPage++;
      if (filterPage > 80) break; // segurança
    }

    // Mapeia por display_id (conversation ID visível)
    const indevidasIds = new Set(conversasIndevidas.map(c => c.id));

    // ── Etapa 3: Cruzamento — CSATs de junho que estão marcados como indevida ─
    const indevidasJunho = [];
    for (const [convId, csat] of Object.entries(csatPorConversa)) {
      if (indevidasIds.has(Number(convId))) {
        indevidasJunho.push(csat);
      }
    }

    if (dryRun) {
      return res.json({
        dry_run: true,
        total_csats_junho: csatsJunho.length,
        total_conversas_indevidas: conversasIndevidas.length,
        indevidas_junho: indevidasJunho.length,
        preview: indevidasJunho,
        instrucao: 'Para importar de verdade, chame com ?dry=false',
      });
    }

    // ── Etapa 4: Importa e reprocessa ──────────────────────────────────────
    let importados = 0;
    const datesParaReprocessar = new Set();
    for (const t of indevidasJunho) {
      await pool.query(
        `INSERT INTO support_bi.csat_indevidas (ticket_id, date, motivo, observacao)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ticket_id) DO UPDATE SET motivo=$3, observacao=$4, marcado_em=NOW()`,
        [String(t.conversation_id), t.date, 'cloudchat_historico_junho', t.agente || null]
      );
      importados++;
      datesParaReprocessar.add(t.date);
    }

    const resultados = [];
    for (const date of [...datesParaReprocessar].sort()) {
      try {
        const r = await runDailyReport(date, true);
        resultados.push({ date, status: 'ok', ...r });
      } catch (e) {
        resultados.push({ date, status: 'erro', error: e.message });
      }
    }

    // Limpa cache de ops para forçar recálculo com as novas indevidas
    await pool.query(`DELETE FROM support_bi.kpis_op_cache`).catch(() => {});

    res.json({
      dry_run: false,
      total_csats_junho: csatsJunho.length,
      total_conversas_indevidas: conversasIndevidas.length,
      indevidas_junho: indevidasJunho.length,
      importados,
      datas_reprocessadas: resultados,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CloudChat-based "1ª Resposta" async cache ────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_bi.first_reply_cc_cache (
        cache_key   TEXT PRIMARY KEY,
        by_agent    JSONB NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (e) { console.error('[first-reply-cache] table create:', e.message); }
})();

function _bhMinsServer(start_s, end_s) {
  if (!start_s || !end_s || end_s <= start_s) return null;
  const BRT_OFF = -3 * 3600000;
  const INICIO  = 9 * 60;
  const FIM     = 18 * 60 + 30;
  const DIAS    = [1, 2, 3, 4, 5];
  const startMs = start_s * 1000 + BRT_OFF;
  const endMs   = end_s   * 1000 + BRT_OFF;
  let total = 0;
  const d = new Date(startMs);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() < endMs) {
    if (DIAS.includes(d.getUTCDay())) {
      const open  = d.getTime() + INICIO * 60000;
      const close = d.getTime() + FIM    * 60000;
      const from  = Math.max(startMs, open);
      const to    = Math.min(endMs, close);
      if (to > from) total += (to - from) / 60000;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return total;
}

const _frCC        = {};          // cacheKey → { loading, by_agent, computed_at }
const _frCCRunning = new Set();
let   _frCCActive  = false;       // serializa jobs para evitar rate limit simultâneo
const _frCCQueue   = [];
function _scheduleFirstReplyCC(d0, d1, cacheKey) {
  _frCCQueue.push({ d0, d1, cacheKey });
  _drainFirstReplyCCQueue();
}
function _drainFirstReplyCCQueue() {
  if (_frCCActive || !_frCCQueue.length) return;
  _frCCActive = true;
  const { d0, d1, cacheKey } = _frCCQueue.shift();
  _computeFirstReplyCC(d0, d1, cacheKey).catch(e => {
    console.error('[first-reply-cc] bg error:', e.message);
    delete _frCC[cacheKey];
  }).finally(() => { _frCCActive = false; _drainFirstReplyCCQueue(); });
}
const _MONITORED_CC = ['Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz'];

async function _computeFirstReplyCC(d0, d1, cacheKey) {
  if (_frCCRunning.has(cacheKey)) return;
  _frCCRunning.add(cacheKey);
  const token = process.env.CLOUDCHAT_TOKEN;
  if (!token) {
    _frCC[cacheKey] = { loading: false, by_agent: null, computed_at: Date.now() };
    _frCCRunning.delete(cacheKey);
    return;
  }
  try {
    console.log(`[first-reply-cc] computing extract:${cacheKey} d0=${d0} d1=${d1}`);
    // Usa CloudChat data_extracts: TICKET_METRICS_WITH_AGENT_INFORMATION
    // firstAgentReplyTimeMin = atribuição da especialista → resposta (mesmo campo do Henrique)
    // API aceita janelas de max 5 dias; filtra por resolvedAt no cliente
    // Lookback 45 dias: captura tickets criados antes do período mas resolvidos nele
    const endMs   = new Date(d1 + 'T00:00:00Z').getTime();
    const startMs = new Date(d0 + 'T00:00:00Z').getTime() - 45 * 86400000;
    const allRows = [];
    let cur = startMs;
    while (cur < endMs) {
      const winEnd = Math.min(cur + 5 * 86400000, endMs);
      const sStr   = new Date(cur).toISOString().slice(0, 10) + 'T00:00:00';
      const eStr   = new Date(winEnd).toISOString().slice(0, 10) + 'T00:00:00';
      try {
        const url = `${CLOUDCHAT_BASE}/api/v2/accounts/${CLOUDCHAT_ACCOUNT}/data_extracts` +
          `?account_id=${CLOUDCHAT_ACCOUNT}&startDate=${encodeURIComponent(sStr)}&endDate=${encodeURIComponent(eStr)}` +
          `&type=TICKET_METRICS_WITH_AGENT_INFORMATION`;
        const resp = await fetch(url, {
          headers: { 'api_access_token': token },
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) {
          const data = await resp.json();
          if (Array.isArray(data)) allRows.push(...data);
        } else {
          console.warn(`[first-reply-cc] extract ${sStr}→${eStr} status=${resp.status}`);
        }
      } catch (e) {
        console.warn(`[first-reply-cc] extract window error: ${e.message}`);
      }
      cur = winEnd;
      if (cur < endMs) await new Promise(r => setTimeout(r, 3200)); // ~18 req/min (limite: 20)
    }

    const agTimes = {};
    for (const row of allRows) {
      const agent = row.firstAgentReplyName;
      if (!_MONITORED_CC.includes(agent)) continue;
      // Filtrar por data de resolução dentro do período (resolvedAt é string BRT)
      if (!row.resolvedAt || row.ticketStatus !== 'resolved') continue;
      if (row.resolvedAt < d0 || row.resolvedAt >= d1) continue;
      if (row.firstAgentReplyTimeMin == null || row.firstAgentReplyTimeMin < 0) continue;
      if (!row.firstAgentAssignmentTime || !row.firstAgentFirstReplyTime) continue;
      // Recalcula em horas comerciais com timestamps BRT+3h para obter UTC real
      const BRT_OFFSET = 3 * 3600;
      const assignedTs = Math.round(new Date(row.firstAgentAssignmentTime + 'Z').getTime() / 1000) + BRT_OFFSET;
      const replyTs    = Math.round(new Date(row.firstAgentFirstReplyTime  + 'Z').getTime() / 1000) + BRT_OFFSET;
      const bhm = _bhMinsServer(assignedTs, replyTs);
      if (bhm === null || bhm < 0 || bhm > 10080) continue;
      if (!agTimes[agent]) agTimes[agent] = [];
      agTimes[agent].push(bhm);
    }

    const byAgent = {};
    for (const [ag, times] of Object.entries(agTimes)) {
      if (!times.length) continue;
      const avg    = times.reduce((s, x) => s + x, 0) / times.length;
      const sorted = [...times].sort((a, b) => a - b);
      const mid    = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      byAgent[ag]  = { avg: Math.round(avg * 10) / 10, median: Math.round(median * 10) / 10 };
    }
    // Global: todos os tempos das monitoradas juntos (para os cards de visão geral)
    const allTimes = Object.values(agTimes).flat();
    if (allTimes.length) {
      const gAvg    = allTimes.reduce((s, x) => s + x, 0) / allTimes.length;
      const gSorted = [...allTimes].sort((a, b) => a - b);
      const gMid    = Math.floor(gSorted.length / 2);
      const gMedian = gSorted.length % 2 ? gSorted[gMid] : (gSorted[gMid - 1] + gSorted[gMid]) / 2;
      byAgent['__global__'] = { avg: Math.round(gAvg * 10) / 10, median: Math.round(gMedian * 10) / 10 };
    }
    console.log(`[first-reply-cc] done extract:${cacheKey}: ${allRows.length} rows, ${Object.keys(byAgent).length} agents`, JSON.stringify(byAgent));

    _frCC[cacheKey] = { loading: false, by_agent: byAgent, computed_at: Date.now() };
    pool.query(
      `INSERT INTO support_bi.first_reply_cc_cache (cache_key, by_agent, computed_at)
       VALUES ($1,$2,NOW()) ON CONFLICT (cache_key) DO UPDATE SET by_agent=$2, computed_at=NOW()`,
      [cacheKey, JSON.stringify(byAgent)]
    ).catch(e => console.error('[first-reply-cc] db save:', e.message));
  } catch (e) {
    console.error('[first-reply-cc] compute error:', e.message);
    _frCC[cacheKey] = { loading: false, by_agent: null, computed_at: Date.now() };
  } finally {
    _frCCRunning.delete(cacheKey);
  }
}

async function _getFirstReplyCC(d0, d1) {
  const cacheKey = `fr:${d0}:${d1}`;
  const mem = _frCC[cacheKey];
  if (mem) return mem.loading ? { loading: true, by_agent: null } : { loading: false, by_agent: mem.by_agent };
  try {
    const row = await pool.query(
      `SELECT by_agent FROM support_bi.first_reply_cc_cache WHERE cache_key=$1 AND computed_at > NOW() - INTERVAL '24 hours'`,
      [cacheKey]
    );
    if (row.rows.length) {
      const byAgent = row.rows[0].by_agent;
      _frCC[cacheKey] = { loading: false, by_agent: byAgent, computed_at: Date.now() };
      return { loading: false, by_agent: byAgent };
    }
  } catch (_) {}
  _frCC[cacheKey] = { loading: true, by_agent: null, computed_at: Date.now() };
  _scheduleFirstReplyCC(d0, d1, cacheKey);
  return { loading: true, by_agent: null };
}

// ── Métricas Operacionais Semanais ──────────────────────────────────────────

app.get('/kpis-semanais', async (req, res) => {
  try {
    let d0, d1, pd0, pd1, modoLabel;

    if (req.query.dia) {
      // Modo dia
      d0 = req.query.dia;
      const fim = new Date(d0 + 'T12:00:00Z');
      fim.setUTCDate(fim.getUTCDate() + 1);
      d1  = fim.toISOString().slice(0, 10);
      const prevD = new Date(d0 + 'T12:00:00Z');
      prevD.setUTCDate(prevD.getUTCDate() - 1);
      pd0 = prevD.toISOString().slice(0, 10);
      pd1 = d0;
      modoLabel = 'dia';
    } else if (req.query.mes) {
      // Modo mês  (YYYY-MM)
      const [y, m] = req.query.mes.split('-').map(Number);
      d0 = `${y}-${String(m).padStart(2, '0')}-01`;
      d1 = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
      pd0 = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      pd1 = d0;
      modoLabel = 'mes';
    } else if (req.query.inicio && req.query.fim) {
      // Modo período livre
      d0 = req.query.inicio;
      const fimD = new Date(req.query.fim + 'T12:00:00Z');
      fimD.setUTCDate(fimD.getUTCDate() + 1);
      d1 = fimD.toISOString().slice(0, 10);
      const durMs   = new Date(d1) - new Date(d0);
      const durDays = Math.round(durMs / 86400000);
      const prevS = new Date(d0 + 'T12:00:00Z');
      prevS.setUTCDate(prevS.getUTCDate() - durDays);
      pd0 = prevS.toISOString().slice(0, 10);
      pd1 = d0;
      modoLabel = 'periodo';
    } else {
      // Modo semana (dom–sáb)
      let semana = req.query.semana;
      if (!semana) {
        const hoje = new Date();
        const dow  = hoje.getUTCDay(); // 0=dom
        const lastSun = new Date(hoje);
        lastSun.setUTCDate(lastSun.getUTCDate() - dow);
        semana = lastSun.toISOString().slice(0, 10);
      }
      const sun = new Date(semana + 'T12:00:00Z');
      const nextSun = new Date(sun); nextSun.setUTCDate(nextSun.getUTCDate() + 7);
      const prevSun = new Date(sun); prevSun.setUTCDate(prevSun.getUTCDate() - 7);
      d0  = semana;
      d1  = nextSun.toISOString().slice(0, 10);
      pd0 = prevSun.toISOString().slice(0, 10);
      pd1 = d0;
      modoLabel = 'semana';
    }

    const periodKey = modoLabel === 'dia'    ? `dia:${d0}` :
                      modoLabel === 'mes'    ? `mes:${d0.slice(0, 7)}` :
                      modoLabel === 'semana' ? `semana:${d0}` :
                      `periodo:${d0}:${d1}`;
    try {
      const cached = await pool.query(
        `SELECT data FROM support_bi.kpis_op_cache WHERE period_key=$1 AND fetched_at > NOW() - INTERVAL '12 hours'`,
        [periodKey]
      );
      if (cached.rows.length) return res.json(cached.rows[0].data);
    } catch (_) {}

    // Busca IDs de indevidas do período para excluir do CSAT
    let indevidasIds = [];
    try {
      const indevRows = await pool.query(
        `SELECT DISTINCT ticket_id FROM support_bi.csat_indevidas WHERE date >= $1 AND date < $2`,
        [d0, d1]
      );
      indevidasIds = indevRows.rows.map(r => parseInt(r.ticket_id, 10)).filter(n => !isNaN(n));
    } catch (_e) {}
    const indevidasNotIn = indevidasIds.length ? `AND t.display_ticket_id NOT IN (${indevidasIds.join(',')})` : '';

    // Agrega CSAT por agente a partir dos csat_reports (mesma fonte do Painel CSAT — data de criação)
    const csatByAgentReports = {};
    let reportsTemDados = false;
    try {
      const repRows = await pool.query(
        `SELECT date::text, data FROM support_bi.csat_reports WHERE date >= $1 AND date < $2`,
        [d0, d1]
      );
      reportsTemDados = repRows.rows.length > 0;
      for (const row of repRows.rows) {
        const rd = row.data;
        for (const [ag, neg] of Object.entries(rd.por_agente || {})) {
          if (!csatByAgentReports[ag]) csatByAgentReports[ag] = { neg: 0, pos: 0 };
          csatByAgentReports[ag].neg += (neg || 0);
        }
        for (const [ag, pos] of Object.entries(rd.por_agente_positivos || {})) {
          if (!csatByAgentReports[ag]) csatByAgentReports[ag] = { neg: 0, pos: 0 };
          csatByAgentReports[ag].pos += (pos || 0);
        }
      }
    } catch (_e) {}

    const token = await getMetabaseToken();

    async function sqlScalar(sql) {
      const resp = await fetch(`${METABASE_URL}/api/dataset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': token },
        body: JSON.stringify({ database: METABASE_DATABASE_ID, type: 'native', native: { query: sql } }),
      });
      const data = await resp.json();
      const val = data.data?.rows?.[0]?.[0];
      return (val !== undefined && val !== null) ? Number(val) : null;
    }

    async function sqlRows(sql) {
      const resp = await fetch(`${METABASE_URL}/api/dataset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': token },
        body: JSON.stringify({ database: METABASE_DATABASE_ID, type: 'native', native: { query: sql } }),
      });
      const data = await resp.json();
      return data.data?.rows || [];
    }

    const [
      volume, novosMonitoradas, respondidos, mediaDiaria, csatTimeDW, csatClaudia, retencaoN1,
      tempoResposta, tempoEncerramento, medResposta, medEncerramento,
      volAnterior, retencaoAnterior, csatAnterior,
      porAgenteRows, snoozedRows,
      emAberto, semAtribuicao, pendentes,
      resolvidosPorAgenteRows, outrosRows,
      claudiaTicketsRows, pendentesAgenteRows,
      emAbertoAgenteRows, emAbertoOutrosRows,
    ] = await Promise.all([
      sqlScalar(`SELECT COUNT(ticket_id) FROM dw.fact_cloudchat_tickets WHERE created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE COALESCE(agent_on_resolution_name, first_agent_reply_name) IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'resolved' AND agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') AND resolved_at_local >= '${d0}' AND resolved_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND(COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT DATE(created_at_local)), 0), 1) FROM dw.fact_cloudchat_tickets WHERE created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND(((AVG(csat_score) - 1) / 4.0 * 100)::numeric, 1) FROM dw.fact_cloudchat_tickets t WHERE csat_score IS NOT NULL AND t.agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') AND t.created_at_local >= '${d0}' AND t.created_at_local < '${d1}' ${indevidasNotIn}`),
      sqlScalar(`SELECT ROUND(((AVG(csat_score) - 1) / 4.0 * 100)::numeric, 1) FROM dw.fact_cloudchat_tickets WHERE csat_score IS NOT NULL AND agent_on_resolution_name ILIKE '%claudia%' AND agent_on_resolution_name NOT ILIKE '%projetos%' AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'resolved' AND agent_on_resolution_name ILIKE '%claudia%' AND agent_on_resolution_name NOT ILIKE '%projetos%' AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND(AVG(first_agent_reply_time_min) / 60.0, 1) FROM dw.fact_cloudchat_tickets WHERE first_agent_first_reply_at_local IS NOT NULL AND first_agent_reply_time_min IS NOT NULL AND first_agent_reply_time_min >= 1 AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND(AVG(first_agent_resolution_time_min) / 60.0, 1) FROM dw.fact_cloudchat_tickets WHERE resolved_at_local IS NOT NULL AND first_agent_resolution_time_min IS NOT NULL AND first_agent_resolution_time_min > 0 AND first_agent_resolution_time_min < 2880 AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_agent_reply_time_min))::numeric / 60.0, 1) FROM dw.fact_cloudchat_tickets WHERE first_agent_first_reply_at_local IS NOT NULL AND first_agent_reply_time_min IS NOT NULL AND first_agent_reply_time_min >= 1 AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_agent_resolution_time_min))::numeric / 60.0, 1) FROM dw.fact_cloudchat_tickets WHERE resolved_at_local IS NOT NULL AND first_agent_resolution_time_min IS NOT NULL AND first_agent_resolution_time_min > 0 AND first_agent_resolution_time_min < 2880 AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT COUNT(ticket_id) FROM dw.fact_cloudchat_tickets WHERE created_at_local >= '${pd0}' AND created_at_local < '${d0}'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'resolved' AND agent_on_resolution_name ILIKE '%claudia%' AND agent_on_resolution_name NOT ILIKE '%projetos%' AND created_at_local >= '${pd0}' AND created_at_local < '${d0}'`),
      sqlScalar(`SELECT ROUND(((AVG(csat_score) - 1) / 4.0 * 100)::numeric, 1) FROM dw.fact_cloudchat_tickets WHERE csat_score IS NOT NULL AND agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') AND created_at_local >= '${pd0}' AND created_at_local < '${d0}'`),
      sqlRows(`
        SELECT
          COALESCE(t.agent_on_resolution_name, '(sem agente)') AS agente,
          COUNT(*) AS volume,
          ROUND(AVG(CASE WHEN t.first_agent_resolution_time_min > 0 AND t.first_agent_resolution_time_min < 2880 AND t.resolved_at_local IS NOT NULL THEN t.first_agent_resolution_time_min END) / 60.0, 1) AS tempo_enc_h,
          ROUND(COUNT(CASE WHEN t.csat_score >= 4 ${indevidasNotIn} THEN 1 END) * 100.0 / NULLIF(COUNT(CASE WHEN t.csat_score IS NOT NULL ${indevidasNotIn} THEN 1 END), 0), 1) AS csat,
          ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.first_agent_resolution_time_min) FILTER (WHERE t.first_agent_resolution_time_min > 0 AND t.first_agent_resolution_time_min < 2880 AND t.resolved_at_local IS NOT NULL))::numeric / 60.0, 1) AS mediana_enc_h
        FROM dw.fact_cloudchat_tickets t
        WHERE t.agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz')
          AND t.ticket_status = 'resolved'
          AND t.resolved_at_local >= '${d0}' AND t.resolved_at_local < '${d1}'
        GROUP BY 1
        ORDER BY volume DESC
      `),
      sqlRows(`
        SELECT
          COALESCE(t.agent_on_resolution_name, '(sem agente)') AS agente,
          COUNT(*) AS total,
          ARRAY_AGG(t.display_ticket_id ORDER BY t.created_at_local DESC) AS ids
        FROM dw.fact_cloudchat_tickets t
        WHERE t.ticket_status = 'snoozed'
          AND t.agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz')
          AND t.created_at_local >= '${d0}' AND t.created_at_local < '${d1}'
        GROUP BY 1
        ORDER BY total DESC
      `),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'open' AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'open' AND agent_on_resolution_name IS NULL AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'pending' AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlRows(`SELECT agent_on_resolution_name, COUNT(*)::int AS resolvidos FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'resolved' AND agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') AND resolved_at_local >= '${d0}' AND resolved_at_local < '${d1}' GROUP BY 1 ORDER BY 2 DESC`),
      sqlRows(`SELECT COALESCE(agent_on_resolution_name,'Encerrado pelo seller'), COUNT(*)::int FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'resolved' AND (agent_on_resolution_name IS NULL OR (agent_on_resolution_name NOT IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') AND agent_on_resolution_name NOT ILIKE '%claudia%')) AND resolved_at_local >= '${d0}' AND resolved_at_local < '${d1}' GROUP BY 1 ORDER BY 2 DESC`),
      sqlRows(`SELECT display_ticket_id, DATE(created_at_local)::text, ticket_status, csat_score, csat_feedback, contact_name FROM dw.fact_cloudchat_tickets WHERE agent_on_resolution_name ILIKE '%claudia%' AND agent_on_resolution_name NOT ILIKE '%projetos%' AND created_at_local >= '${d0}' AND created_at_local < '${d1}' ORDER BY created_at_local DESC LIMIT 300`),
      sqlRows(`SELECT agent_on_resolution_name, COUNT(*)::int FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'pending' AND agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') AND created_at_local >= '${d0}' AND created_at_local < '${d1}' GROUP BY 1`),
      sqlRows(`SELECT COALESCE(agent_on_resolution_name,'Sem atribuição'), COUNT(*)::int FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'open' AND agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') GROUP BY 1`),
      sqlRows(`SELECT COALESCE(agent_on_resolution_name,'Sem atribuição'), COUNT(*)::int FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'open' AND (agent_on_resolution_name IS NULL OR (agent_on_resolution_name NOT IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') AND agent_on_resolution_name NOT ILIKE '%claudia%')) GROUP BY 1`),
    ]);

    const csatTime = csatTimeDW;

    const firstReplyCC = await _getFirstReplyCC(d0, d1);

    const porAgente = porAgenteRows.map(r => {
      const agente = r[0];
      const rep = csatByAgentReports[agente];
      let csat = null;
      if (rep) {
        const tot = rep.neg + rep.pos;
        if (tot > 0) csat = Math.round(rep.pos / tot * 1000) / 10;
      }
      // DW só é fallback quando csat_reports ainda não tem dados do período
      if (csat === null && !reportsTemDados && r[3] !== null && r[3] !== undefined) {
        csat = Number(r[3]);
      }
      const frCC = firstReplyCC.by_agent?.[agente] || {};
      return {
        agente,
        volume:          Number(r[1]) || 0,
        tempo_resp_h:    frCC.avg    ?? null,
        mediana_resp_h:  frCC.median ?? null,
        tempo_enc_h:     r[2] !== null && r[2] !== undefined ? Number(r[2]) : null,
        csat,
        mediana_enc_h:   r[4] !== null && r[4] !== undefined ? Number(r[4]) : null,
      };
    });

    const snoozedPorAgente = snoozedRows.map(r => ({
      agente: r[0],
      total:  Number(r[1]) || 0,
      ids:    Array.isArray(r[2]) ? r[2].map(String) : [],
    }));

    const diasUteis = countBusinessDays(d0, d1);
    const kpisResult = {
      fetched_at: new Date().toISOString(),
      first_reply_loading: firstReplyCC.loading,
      modo: modoLabel,
      semana: d0,
      semana_fim: new Date(new Date(d1) - 86400000).toISOString().slice(0, 10),
      semana_anterior: pd0,
      dias_uteis: diasUteis,
      meta_volume_por_agente: 45 * diasUteis,
      atual: {
        volume:               volume      ?? 0,
        novos_monitoradas:    novosMonitoradas ?? 0,
        respondidos:          respondidos ?? 0,
        media_diaria:         mediaDiaria ?? 0,
        csat_time:            csatTime,
        csat_claudia:         csatClaudia,
        retencao_n1:          retencaoN1  ?? 0,
        tempo_resposta_h:       firstReplyCC.by_agent?.['__global__']?.avg ?? null,
        tempo_encerramento_h:   tempoEncerramento,
        mediana_resposta_h:     firstReplyCC.by_agent?.['__global__']?.median ?? null,
        mediana_encerramento_h: medEncerramento,
        por_agente:              porAgente,
        snoozed_por_agente:      snoozedPorAgente,
        resolvidos_por_agente:   resolvidosPorAgenteRows.map(r => ({ agente: r[0], resolvidos: Number(r[1]) || 0 })),
        outros_resolvidos:       outrosRows.map(r => ({ agente: r[0], resolvidos: Number(r[1]) || 0 })),
        claudia_tickets:         claudiaTicketsRows.map(r => ({ id: String(r[0]), data: String(r[1]||''), status: r[2], nota: r[3]!==null?Number(r[3]):null, feedback: r[4]||null, cliente: r[5]||null })),
        em_aberto:               emAberto      ?? 0,
        sem_atribuicao:          semAtribuicao ?? 0,
        pendentes:               pendentes     ?? 0,
        pendentes_por_agente:    Object.fromEntries((pendentesAgenteRows || []).map(r => [r[0], Number(r[1]) || 0])),
        em_aberto_por_agente:    Object.fromEntries((emAbertoAgenteRows  || []).map(r => [r[0], Number(r[1]) || 0])),
        em_aberto_outros:        Object.fromEntries((emAbertoOutrosRows  || []).map(r => [r[0], Number(r[1]) || 0])),
      },
      anterior: {
        volume:      volAnterior       ?? 0,
        retencao_n1: retencaoAnterior  ?? 0,
        csat_time:   csatAnterior,
      },
    };
    // Backlog global (sem filtro de data) — executa fora do cache de período
    try {
      const [bgOpen, bgPending, bgSemAgent, bgPendingRows] = await Promise.all([
        sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'open' AND (agent_on_resolution_name IS NULL OR agent_on_resolution_name NOT ILIKE '%projetos%')`),
        sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'pending' AND (agent_on_resolution_name IS NULL OR agent_on_resolution_name NOT ILIKE '%projetos%')`),
        sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status IN ('open','pending') AND agent_on_resolution_name IS NULL`),
        sqlRows(`SELECT agent_on_resolution_name, COUNT(*)::int FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'pending' AND agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz') GROUP BY 1`),
      ]);
      const pendingPorAgente = {};
      for (const r of bgPendingRows) pendingPorAgente[r[0]] = Number(r[1]) || 0;
      kpisResult.backlog = { open: bgOpen ?? 0, pending: bgPending ?? 0, sem_agente: bgSemAgent ?? 0, pending_por_agente: pendingPorAgente };
    } catch(e) { kpisResult.backlog = null; }
    if (!firstReplyCC.loading) {
      pool.query(
        `INSERT INTO support_bi.kpis_op_cache (period_key, data) VALUES ($1,$2)
         ON CONFLICT (period_key) DO UPDATE SET data=$2, fetched_at=NOW()`,
        [periodKey, JSON.stringify(kpisResult)]
      ).catch(e => console.error('[kpis-cache]', e.message));
    }
    res.json(kpisResult);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Poll endpoint — frontend verifica se o cálculo de 1ª resposta CloudChat terminou
app.get('/kpis-semanais/first-reply-poll', async (req, res) => {
  try {
    let d0, d1;
    if (req.query.dia) {
      d0 = req.query.dia;
      const fim = new Date(d0 + 'T12:00:00Z'); fim.setUTCDate(fim.getUTCDate() + 1);
      d1 = fim.toISOString().slice(0, 10);
    } else if (req.query.mes) {
      const [y, m] = req.query.mes.split('-').map(Number);
      d0 = `${y}-${String(m).padStart(2, '0')}-01`;
      d1 = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    } else if (req.query.inicio && req.query.fim) {
      d0 = req.query.inicio;
      const fimD = new Date(req.query.fim + 'T12:00:00Z'); fimD.setUTCDate(fimD.getUTCDate() + 1);
      d1 = fimD.toISOString().slice(0, 10);
    } else {
      let semana = req.query.semana;
      if (!semana) {
        const h = new Date(); const dow = h.getUTCDay();
        h.setUTCDate(h.getUTCDate() - dow); semana = h.toISOString().slice(0, 10);
      }
      const sun = new Date(semana + 'T12:00:00Z');
      const nextSun = new Date(sun); nextSun.setUTCDate(nextSun.getUTCDate() + 7);
      d0 = semana; d1 = nextSun.toISOString().slice(0, 10);
    }
    res.json(await _getFirstReplyCC(d0, d1));
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
// Verifica se as datas das indevidas importadas batem com o Metabase e corrige se necessário
app.get('/admin/corrigir-datas-indevidas', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const dryRun = req.query.dry !== 'false';
  try {
    const token = await getMetabaseToken();

    // Pega todas as indevidas de junho no banco
    const { rows: indevidas } = await pool.query(
      "SELECT ticket_id, date FROM support_bi.csat_indevidas WHERE date LIKE '2026-06%'"
    );

    const ticketIds = indevidas.map(r => r.ticket_id);
    if (!ticketIds.length) return res.json({ msg: 'Sem indevidas de junho no banco' });

    // Busca esses tickets no Metabase para ver qual data (field 174139) cada um tem
    const filter = ticketIds.length === 1
      ? ['=', ['field', 174172, null], Number(ticketIds[0])]
      : ['or', ...ticketIds.map(id => ['=', ['field', 174172, null], Number(id)])];

    const data = await queryMetabase(token, {
      database: METABASE_DATABASE_ID,
      type: 'query',
      query: {
        'source-table': METABASE_TABLE_ID,
        filter,
        fields: [
          ['field', 174172, null], // ticket_id (interno)
          ['field', 174143, null], // display_ticket_id
          ['field', 174139, null], // data usada pelo sistema
        ],
        limit: 500,
      },
    });

    const cols = data.data.cols.map(c => c.name);
    const metabasePorTicket = {};
    for (const row of data.data.rows) {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      if (obj.display_ticket_id) {
        metabasePorTicket[String(obj.display_ticket_id)] = obj[cols[2]]; // data
      }
    }

    // Verifica mismatches
    const mismatches = [];
    const matches = [];
    for (const inv of indevidas) {
      const metaDate = metabasePorTicket[String(inv.ticket_id)];
      if (!metaDate) {
        mismatches.push({ ticket_id: inv.ticket_id, banco: inv.date, metabase: 'não encontrado' });
      } else {
        const metaDateStr = metaDate.slice(0, 10);
        if (metaDateStr !== inv.date) {
          mismatches.push({ ticket_id: inv.ticket_id, banco: inv.date, metabase: metaDateStr });
        } else {
          matches.push({ ticket_id: inv.ticket_id, date: inv.date });
        }
      }
    }

    if (dryRun) {
      return res.json({ dry_run: true, total: indevidas.length, corretos: matches.length, mismatches });
    }

    // Corrige as datas erradas
    const datesParaReprocessar = new Set();
    let corrigidos = 0;
    for (const m of mismatches) {
      if (m.metabase === 'não encontrado') continue;
      await pool.query(
        'UPDATE support_bi.csat_indevidas SET date=$1 WHERE ticket_id=$2',
        [m.metabase, m.ticket_id]
      );
      datesParaReprocessar.add(m.banco);      // reprocessa data antiga
      datesParaReprocessar.add(m.metabase);   // e nova
      corrigidos++;
    }

    // Reprocessa datas afetadas
    const resultados = [];
    for (const date of [...datesParaReprocessar].sort()) {
      try {
        const r = await runDailyReport(date, true);
        resultados.push({ date, status: 'ok', ...r });
      } catch (e) {
        resultados.push({ date, status: 'erro', error: e.message });
      }
    }

    res.json({ dry_run: false, total: indevidas.length, corretos: matches.length, mismatches_encontrados: mismatches.length, corrigidos, datas_reprocessadas: resultados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnóstico: indevidas no banco + totais dos reports de junho
app.get('/admin/diagnostico-junho', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  try {
    const [r1, r2] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM support_bi.csat_indevidas WHERE date LIKE '2026-06%'"),
      pool.query("SELECT date, data->>'total' neg, data->>'total_positivos' pos, data->>'total_avaliados' aval, data->>'indevidas_removidas' indev FROM support_bi.csat_reports WHERE date LIKE '2026-06%' ORDER BY date"),
    ]);
    res.json({
      indevidas_junho_banco: parseInt(r1.rows[0].count),
      reports: r2.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/backlog-tickets', async (req, res) => {
  try {
    const rows = await dwQuery(`
      SELECT display_ticket_id, ticket_status,
             COALESCE(agent_on_resolution_name, '(sem atribuição)') AS agente,
             DATE(created_at_local) AS criado_em
      FROM dw.fact_cloudchat_tickets
      WHERE ticket_status IN ('open', 'pending')
        AND (agent_on_resolution_name IS NULL OR agent_on_resolution_name NOT ILIKE '%projetos%')
      ORDER BY created_at_local ASC
    `);
    res.json(rows.map(r => ({ id: r[0], status: r[1], agente: r[2], criado_em: r[3] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/csat-tickets-agente', async (req, res) => {
  const { agente, d0, d1, tipo } = req.query;
  if (!agente || !d0 || !d1) return res.status(400).json({ error: 'agente, d0, d1 obrigatórios' });
  const campo = tipo === 'pos' ? 'tickets_positivos' : 'tickets';
  try {
    const rows = await pool.query(`
      SELECT r.date::text, t
      FROM support_bi.csat_reports r,
           jsonb_array_elements(r.data->'${campo}') AS t
      WHERE r.date >= $1 AND r.date < $2
        AND t->>'agente' = $3
      ORDER BY r.date DESC
    `, [d0, d1, agente]);
    res.json(rows.rows.map(r => ({
      date: r.date,
      id: r.t.id,
      link: r.t.link,
      nota: r.t.nota,
      agente: r.t.agente,
      feedback: r.t.feedback || null,
      cliente_nome: r.t.cliente_nome || null,
      tags: Array.isArray(r.t.tags) ? r.t.tags : [],
    })));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/agent-tickets-op', async (req, res) => {
  const AGENTES = ['Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz']; // lista local deste endpoint
  const { agente, semana, mes, dia, inicio, fim } = req.query;
  if (!agente || !AGENTES.includes(agente)) return res.status(400).json({ error: 'agente inválido' });
  let d0, d1;
  if (dia) {
    d0 = dia; const nd = new Date(dia + 'T12:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 1); d1 = nd.toISOString().slice(0, 10);
  } else if (mes) {
    const [y, m] = mes.split('-').map(Number); d0 = `${y}-${String(m).padStart(2,'0')}-01`;
    const nd = new Date(Date.UTC(y, m, 1)); d1 = nd.toISOString().slice(0, 10);
  } else if (inicio && fim) {
    d0 = inicio; const nd = new Date(fim + 'T12:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 1); d1 = nd.toISOString().slice(0, 10);
  } else {
    const s = semana || (() => { const h=new Date(); const dow=h.getUTCDay(); const ls=new Date(h); ls.setUTCDate(ls.getUTCDate()-dow); return ls.toISOString().slice(0,10); })();
    d0 = s; const nd = new Date(s + 'T12:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 7); d1 = nd.toISOString().slice(0, 10);
  }
  try {
    const [rows, indevidasRes] = await Promise.all([
      dwQuery(`
        SELECT t.display_ticket_id, t.ticket_status, t.contact_name, t.csat_score,
               CASE WHEN t.ticket_status = 'snoozed' THEN 'snoozed' ELSE 'encerrado' END AS tipo
        FROM dw.fact_cloudchat_tickets t
        WHERE t.agent_on_resolution_name = '${agente}'
          AND (
            (t.ticket_status = 'resolved' AND t.resolved_at_local >= '${d0}' AND t.resolved_at_local < '${d1}')
            OR (t.ticket_status = 'snoozed' AND t.created_at_local >= '${d0}' AND t.created_at_local < '${d1}')
          )
        ORDER BY t.created_at_local DESC LIMIT 500
      `),
      pool.query('SELECT ticket_id FROM support_bi.csat_indevidas'),
    ]);
    const indevidasSet = new Set(indevidasRes.rows.map(r => String(r.ticket_id)));
    const tickets = rows
      .map(r => ({ id: String(r[0]), status: r[1], cliente: r[2]||null, nota: r[3]!==null?Number(r[3]):null, tipo: r[4] }))
      .filter(t => !(indevidasSet.has(t.id) && t.nota !== null && t.nota <= 3));
    res.json(tickets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/mark-indevida', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const { ticket_id, date, observacao } = req.query;
  if (!ticket_id || !date) return res.status(400).json({ error: 'ticket_id e date obrigatorios' });
  try {
    await pool.query(
      `INSERT INTO support_bi.csat_indevidas (ticket_id, date, motivo, observacao)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ticket_id) DO UPDATE SET motivo=$3, observacao=$4, marcado_em=NOW()`,
      [ticket_id, date, 'avaliacao_reaberto', observacao || null]
    );
    await pool.query(`DELETE FROM support_bi.kpis_op_cache WHERE period_key LIKE 'semana:%' OR period_key LIKE 'mes:%' OR period_key LIKE 'dia:%'`).catch(() => {});
    const r = await runDailyReport(date, true);
    res.json({ ok: true, ticket_id, date, total_dia: r.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Destrincha os tickets "recebidos" que não aparecem em Resolvidos (5 agentes) nem Claudia
app.get('/admin/breakdown-recebidos', async (req, res) => {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const mes = req.query.mes || '2026-06';
  const [ano, mm] = mes.split('-').map(Number);
  const d0 = `${mes}-01`;
  const d1 = `${ano}-${String(mm < 12 ? mm + 1 : 1).padStart(2,'0')}-01`;
  try {
    const [totalRows, breakdownRows] = await Promise.all([
      dwQuery(`SELECT COUNT(*)::int FROM dw.fact_cloudchat_tickets WHERE created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      dwQuery(`
        SELECT
          ticket_status,
          COALESCE(agent_on_resolution_name, 'Sem atribuição') AS agente,
          COUNT(*)::int AS total
        FROM dw.fact_cloudchat_tickets
        WHERE (
          (ticket_status = 'resolved' AND resolved_at_local >= '${d0}' AND resolved_at_local < '${d1}')
          OR
          (ticket_status != 'resolved' AND created_at_local >= '${d0}' AND created_at_local < '${d1}')
        )
          AND NOT (ticket_status = 'resolved' AND agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz'))
          AND NOT (ticket_status = 'resolved' AND agent_on_resolution_name ILIKE '%claudia%' AND agent_on_resolution_name NOT ILIKE '%projetos%')
        GROUP BY 1, 2
        ORDER BY 3 DESC, 1
      `),
    ]);
    const total = totalRows[0]?.[0] || 0;
    const rows = breakdownRows.map(r => ({ status: r[0], agente: r[1], total: r[2] }));
    const totalOthers = rows.reduce((s, r) => s + r.total, 0);
    res.json({ mes, total_recebidos: total, total_outros: totalOthers, breakdown: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Outliers de 1ª resposta por agente — diagnóstico
app.get('/admin/first-reply-outliers', async (req, res) => {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const inicio = req.query.inicio || '2026-07-03';
  const fim    = req.query.fim    || '2026-07-10';
  const agente = req.query.agente || null; // ex: "Paty" ou "Lu Almeida"
  const limit  = Math.min(parseInt(req.query.limit || '20'), 100);
  const porResolucao = req.query.por_resolucao === 'true'; // filtra por resolved_at em vez de created_at
  const d1 = new Date(fim + 'T12:00:00Z'); d1.setUTCDate(d1.getUTCDate() + 1);
  const d1str = d1.toISOString().slice(0, 10);
  const agenteFilter = agente ? `AND agent_on_resolution_name ILIKE '%${agente.replace(/'/g,"''")}%'` : '';
  const dateCol = porResolucao ? 'resolved_at_local' : 'created_at_local';
  try {
    const rows = await dwQuery(`
      SELECT
        display_ticket_id,
        agent_on_resolution_name,
        ROUND(first_agent_reply_time_min::numeric, 1) AS first_reply_min,
        ROUND(first_agent_reply_time_min::numeric / 60.0, 2) AS first_reply_h,
        DATE(created_at_local)::text AS criado_em,
        DATE(first_agent_first_reply_at_local)::text AS primeira_resposta_em,
        ticket_status,
        csat_score
      FROM dw.fact_cloudchat_tickets
      WHERE ${dateCol} >= '${inicio}'
        AND ${dateCol} < '${d1str}'
        AND first_agent_reply_time_min IS NOT NULL
        AND first_agent_reply_time_min >= 0
        AND first_agent_first_reply_at_local IS NOT NULL
        ${agenteFilter}
      ORDER BY first_agent_reply_time_min DESC
      LIMIT ${limit}
    `);
    const result = rows.map(r => ({
      ticket: r[0],
      agente: r[1],
      first_reply_min: r[2],
      first_reply_h: r[3],
      criado_em: r[4],
      primeira_resposta_em: r[5],
      status: r[6],
      csat: r[7],
    }));
    res.json({ inicio, fim, agente: agente || 'todos', total: result.length, rows: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tickets snoozed por agente — diagnóstico de adiados com/sem flag
app.get('/admin/snoozed-tickets', async (req, res) => {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const inicio = req.query.inicio || new Date().toISOString().slice(0, 10);
  const fim    = req.query.fim    || inicio;
  const agente = req.query.agente || null;
  const d1 = new Date(fim + 'T12:00:00Z'); d1.setUTCDate(d1.getUTCDate() + 1);
  const d1str = d1.toISOString().slice(0, 10);
  const agenteFilter = agente ? `AND t.agent_on_resolution_name ILIKE '%${agente.replace(/'/g,"''")}%'` : '';
  try {
    const rows = await dwQuery(`
      SELECT
        t.display_ticket_id,
        t.agent_on_resolution_name,
        DATE(t.created_at_local)::text AS criado_em,
        t.contact_name
      FROM dw.fact_cloudchat_tickets t
      WHERE t.ticket_status = 'snoozed'
        AND t.created_at_local >= '${inicio}'
        AND t.created_at_local < '${d1str}'
        ${agenteFilter}
      ORDER BY t.agent_on_resolution_name, t.created_at_local DESC
    `);
    const result = rows.map(r => ({
      ticket: r[0],
      agente: r[1],
      criado_em: r[2],
      contato: r[3],
    }));
    const resumo = {};
    for (const r of result) {
      if (!resumo[r.agente]) resumo[r.agente] = { total: 0 };
      resumo[r.agente].total++;
    }
    res.json({ inicio, fim, agente: agente || 'todos', total: result.length, resumo, tickets: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Verifica negativos em csat_reports cujo csat_score foi zerado no DW (ticket reaberto)
// action=fix → adiciona às indevidas e reprocessa os dias afetados
app.get('/admin/check-stale-csat', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const mes = req.query.mes || '2026-06';
  const action = req.query.action;
  try {
    const reportsRes = await pool.query(
      `SELECT r.date::text, t->>'id' AS id, t->>'agente' AS agente, (t->>'nota')::numeric AS nota
       FROM support_bi.csat_reports r,
            jsonb_array_elements(r.data->'tickets') AS t
       WHERE r.date LIKE $1
       ORDER BY r.date`,
      [mes + '%']
    );
    if (reportsRes.rows.length === 0) return res.json({ stale: [], total_negativos: 0 });

    const ticketMap = {};
    for (const row of reportsRes.rows) {
      ticketMap[String(row.id)] = { id: String(row.id), date: row.date, agente: row.agente, nota: Number(row.nota) };
    }
    const ids = Object.keys(ticketMap);

    const dwRows = await dwQuery(`
      SELECT display_ticket_id::text, csat_score, ticket_status, agent_on_resolution_name,
             DATE(resolved_at_local)::text
      FROM dw.fact_cloudchat_tickets
      WHERE display_ticket_id::text IN (${ids.map(i => `'${i}'`).join(',')})
    `);
    const dwMap = {};
    for (const r of dwRows) dwMap[String(r[0])] = {
      nota: r[1] !== null ? Number(r[1]) : null, status: r[2], agente: r[3], resolved_at: r[4]
    };

    const stale = [];
    for (const [id, info] of Object.entries(ticketMap)) {
      const dw = dwMap[id];
      const dwNota = dw ? dw.nota : null;
      const dwStatus = dw ? dw.status : 'NOT_FOUND';
      const dwAgente = dw ? dw.agente : null;
      const dwResolvedAt = dw ? dw.resolved_at : null;
      // Stale: score zerado, score virou positivo, não mais resolvido, não encontrado, ou agente mudou
      if (dwNota === null || dwNota > 3 || dwStatus !== 'resolved' || dwAgente !== info.agente) {
        stale.push({ ...info, dw_nota: dwNota, dw_status: dwStatus, dw_agente: dwAgente, dw_resolved_at: dwResolvedAt });
      }
    }

    if (action === 'fix' && stale.length > 0) {
      await Promise.all(stale.map(t =>
        pool.query(
          `INSERT INTO support_bi.csat_indevidas (ticket_id, date, motivo, observacao)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (ticket_id) DO UPDATE SET motivo=$3, observacao=$4, marcado_em=NOW()`,
          [t.id, t.date, 'avaliacao_reaberto', `Avaliação de mês anterior — ticket reaberto e refinalizado em ${t.date}`]
        )
      ));
      pool.query(`DELETE FROM support_bi.kpis_op_cache WHERE period_key LIKE 'semana:%' OR period_key LIKE 'mes:%' OR period_key LIKE 'dia:%'`).catch(() => {});
      const dates = [...new Set(stale.map(t => t.date))].sort();
      const reprocessados = [];
      for (const date of dates) {
        try { const r = await runDailyReport(date, true); reprocessados.push({ date, total: r.total }); }
        catch (e) { reprocessados.push({ date, erro: e.message }); }
        await new Promise(r => setTimeout(r, 300));
      }
      return res.json({ adicionadas_indevidas: stale.length, reprocessados, tickets: stale });
    }

    res.json({ total_negativos: ids.length, stale_count: stale.length, stale });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reprocessa apenas os dias que têm indevidas registradas
app.get('/admin/reprocess-indevidas', async (req, res) => {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await pool.query(`SELECT DISTINCT date::text FROM support_bi.csat_indevidas ORDER BY date`);
    const dates = r.rows.map(row => String(row.date).slice(0, 10));
    res.json({ started: true, total: dates.length, dates });
    (async () => {
      let ok = 0, err = 0;
      for (const date of dates) {
        try { await runDailyReport(date, true); ok++; console.log(`[reprocess-indevidas] ${ok}/${dates.length} ${date} ok`); }
        catch (e) { err++; console.error(`[reprocess-indevidas] ${date} ERRO: ${e.message}`); }
        await new Promise(r => setTimeout(r, 300));
      }
      pool.query(`DELETE FROM support_bi.kpis_op_cache`).catch(() => {});
      console.log(`[reprocess-indevidas] concluido: ${ok} ok, ${err} erros`);
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/reprocess-all', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await pool.query('SELECT date FROM support_bi.csat_reports ORDER BY date');
    const dates = r.rows.map(row => row.date instanceof Date ? row.date.toISOString().slice(0,10) : String(row.date).slice(0,10));
    res.json({ started: true, total: dates.length, dates });
    // Reprocessa em background, sem await no response
    (async () => {
      let ok = 0, err = 0;
      for (const date of dates) {
        try { await runDailyReport(date, true); ok++; console.log(`[reprocess-all] ${ok}/${dates.length} ${date} ok`); }
        catch (e) { err++; console.error(`[reprocess-all] ${date} ERRO: ${e.message}`); }
        await new Promise(r => setTimeout(r, 300));
      }
      console.log(`[reprocess-all] concluido: ${ok} ok, ${err} erros`);
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tempos de resposta subsequente por tag ────────────────────────────────

let _rjtJob = { running: false, total: 0, processed: 0, errors: 0, startedAt: null, completedAt: null };

function calcSubsequentReplyTime(msgs) {
  const sorted = msgs
    .filter(m => m.message_type !== 2)
    .sort((a, b) => a.created_at - b.created_at);
  const firstIdx = sorted.findIndex(m => m.message_type === 1 && m.sender?.type === 'user');
  if (firstIdx < 0) return null;
  const pairs = [];
  let lastSellerTs = null;
  for (let i = firstIdx + 1; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.message_type === 0) {
      lastSellerTs = m.created_at;
    } else if (m.message_type === 1 && m.sender?.type === 'user' && lastSellerTs) {
      const diff = m.created_at - lastSellerTs;
      if (diff > 0 && diff < 259200) { pairs.push(diff); lastSellerTs = null; }
    }
  }
  if (!pairs.length) return null;
  return { avg_sec: Math.round(pairs.reduce((a, b) => a + b, 0) / pairs.length), count: pairs.length };
}

app.get('/admin/setup-reply-times', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_bi.ticket_times_enriched (
        display_ticket_id bigint PRIMARY KEY,
        tag_grupo         text NOT NULL DEFAULT 'sem_tag',
        created_at_local  timestamp,
        first_reply_min   numeric,
        resolution_min    numeric,
        avg_subsequent_reply_sec  numeric,
        count_subsequent_pairs    int DEFAULT 0,
        processed_at      timestamp DEFAULT NOW()
      )
    `);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/process-reply-times', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  if (_rjtJob.running) return res.json({ ok: false, message: 'Job já em execução', state: _rjtJob });
  const from  = req.query.from || '2026-04-01';
  const to    = req.query.to   || '2026-07-01';
  const token = process.env.CLOUDCHAT_TOKEN;
  if (!token) return res.status(500).json({ error: 'CLOUDCHAT_TOKEN não configurado' });
  _rjtJob = { running: true, total: 0, processed: 0, errors: 0, startedAt: new Date().toISOString(), completedAt: null };
  res.json({ ok: true, message: 'Job iniciado em background', params: { from, to } });
  (async () => {
    try {
      const dwRows = await dwQuery(`
        SELECT t.display_ticket_id, t.first_agent_reply_time_min, t.first_agent_resolution_time_min,
          t.created_at_local,
          COALESCE(
            (SELECT CASE WHEN l2.label_name = 'no_tag' THEN 'sem_tag'
                         ELSE SPLIT_PART(l2.label_name, '_', 1) END
             FROM dw.fact_cloudchat_ticket_labels l2
             WHERE l2.ticket_id = t.ticket_id AND l2.label_name != 'no_tag'
             ORDER BY l2.label_name LIMIT 1),
            'sem_tag'
          ) AS tag_grupo
        FROM dw.fact_cloudchat_tickets t
        WHERE t.created_at_local >= '${from}' AND t.created_at_local < '${to}'
        ORDER BY t.display_ticket_id
      `);
      const existing = new Set(
        (await pool.query('SELECT display_ticket_id FROM support_bi.ticket_times_enriched')).rows.map(r => Number(r.display_ticket_id))
      );
      const toProcess = dwRows.filter(r => !existing.has(Number(r[0])));
      _rjtJob.total = toProcess.length;
      for (const row of toProcess) {
        const [display_id, first_reply, resolution, created_at, tag] = row;
        try {
          const msgs = await fetchCloudChat(`/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${display_id}/messages`, token);
          const payload = msgs.payload || msgs || [];
          const result = calcSubsequentReplyTime(Array.isArray(payload) ? payload : []);
          await pool.query(`
            INSERT INTO support_bi.ticket_times_enriched
              (display_ticket_id, tag_grupo, created_at_local, first_reply_min, resolution_min, avg_subsequent_reply_sec, count_subsequent_pairs)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (display_ticket_id) DO UPDATE SET
              tag_grupo=$2, created_at_local=$3, first_reply_min=$4, resolution_min=$5,
              avg_subsequent_reply_sec=$6, count_subsequent_pairs=$7, processed_at=NOW()
          `, [Number(display_id), tag || 'sem_tag', created_at || null,
              first_reply != null ? Number(first_reply) : null,
              resolution != null ? Number(resolution) : null,
              result?.avg_sec ?? null, result?.count ?? 0]);
          _rjtJob.processed++;
        } catch(_e) { _rjtJob.errors++; }
        await new Promise(r => setTimeout(r, 150));
      }
      _rjtJob.running = false;
      _rjtJob.completedAt = new Date().toISOString();
    } catch(e) { _rjtJob.running = false; _rjtJob.error = e.message; }
  })();
});

app.get('/admin/reply-times-status', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const dbCount = await pool.query('SELECT COUNT(*) FROM support_bi.ticket_times_enriched').catch(() => ({ rows: [{ count: 0 }] }));
  res.json({ job: _rjtJob, db_count: Number(dbCount.rows[0].count) });
});

app.get('/admin/report-tag-times', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const from = req.query.from || '2026-04-01';
  const to   = req.query.to   || '2026-07-01';
  try {
    const { rows } = await pool.query(`
      SELECT
        tag_grupo AS grupo,
        COUNT(*) AS tickets,
        ROUND(AVG(first_reply_min) / 60.0, 2)                             AS media_1a_resp_h,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_reply_min) FILTER (WHERE first_reply_min IS NOT NULL AND first_reply_min >= 0)::numeric / 60.0, 2) AS med_1a_resp_h,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY first_reply_min) FILTER (WHERE first_reply_min IS NOT NULL AND first_reply_min >= 0)::numeric / 60.0, 2) AS p75_1a_resp_h,
        ROUND(AVG(CASE WHEN resolution_min > 0 AND resolution_min < 2880 THEN resolution_min END) / 60.0, 2) AS media_fechamento_h,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY resolution_min) FILTER (WHERE resolution_min > 0 AND resolution_min < 2880)::numeric / 60.0, 2) AS med_fechamento_h,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY resolution_min) FILTER (WHERE resolution_min > 0 AND resolution_min < 2880)::numeric / 60.0, 2) AS p75_fechamento_h,
        ROUND(AVG(CASE WHEN avg_subsequent_reply_sec > 0 THEN avg_subsequent_reply_sec END) / 60.0, 2) AS media_subseq_min,
        COUNT(CASE WHEN avg_subsequent_reply_sec > 0 THEN 1 END)           AS tickets_com_subseq
      FROM support_bi.ticket_times_enriched
      WHERE created_at_local >= $1 AND created_at_local < $2
      GROUP BY 1
      ORDER BY tickets DESC
    `, [from, to]);
    res.json({ from, to, rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/debug-msgs/:ticketId', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const token = process.env.CLOUDCHAT_TOKEN;
  if (!token) return res.status(500).json({ error: 'sem CLOUDCHAT_TOKEN' });
  try {
    const data = await fetchCloudChat(
      `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${req.params.ticketId}/messages`, token
    );
    const payload = Array.isArray(data.payload) ? data.payload : (Array.isArray(data) ? data : []);
    const summary = payload.map(m => ({
      id: m.id,
      message_type: m.message_type,
      sender_type: m.sender?.type,
      sender_name: m.sender?.name,
      private: m.private,
      created_at: m.created_at,
      content: (m.content || '').slice(0, 80),
    }));
    res.json({ total: summary.length, messages: summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/kpis-op-diario', async (req, res) => {
  const { inicio, fim } = req.query;
  if (!inicio || !fim) return res.status(400).json({ error: 'inicio e fim obrigatórios' });
  try {
    const indevidasRows = await pool.query(`SELECT ticket_id FROM support_bi.csat_indevidas`).catch(() => ({ rows: [] }));
    const indevidas = indevidasRows.rows.map(r => String(r.ticket_id));
    const indevidasNotIn = indevidas.length
      ? `AND display_ticket_id::text NOT IN (${indevidas.map(i => `'${i}'`).join(',')})`
      : '';
    const rows = await dwQuery(`
      SELECT
        DATE(first_agent_first_reply_at_local)::text AS dia,
        COUNT(*)::int AS volume,
        ROUND(COUNT(CASE WHEN csat_score >= 4 ${indevidasNotIn} THEN 1 END) * 100.0
          / NULLIF(COUNT(CASE WHEN csat_score IS NOT NULL ${indevidasNotIn} THEN 1 END), 0), 1) AS csat,
        ROUND(AVG(CASE WHEN first_agent_reply_time_min >= 0 AND first_agent_reply_time_min <= 480 THEN first_agent_reply_time_min END) / 60.0, 1) AS resp_h
      FROM dw.fact_cloudchat_tickets
      WHERE first_agent_reply_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz')
        AND first_agent_first_reply_at_local IS NOT NULL
        AND first_agent_first_reply_at_local >= '${inicio}' AND first_agent_first_reply_at_local < '${fim}'
      GROUP BY 1
      ORDER BY 1
    `);
    res.json(rows.map(r => ({ dia: r[0], volume: Number(r[1])||0, csat: r[2]!==null?Number(r[2]):null, resp_h: r[3]!==null?Number(r[3]):null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/kpis-op-diario-agente', async (req, res) => {
  const { inicio, fim } = req.query;
  if (!inicio || !fim) return res.status(400).json({ error: 'inicio e fim obrigatórios' });
  try {
    const indevidasRows = await pool.query(`SELECT ticket_id FROM support_bi.csat_indevidas`).catch(() => ({ rows: [] }));
    const indevidas = indevidasRows.rows.map(r => String(r.ticket_id));
    const indevidasNotIn = indevidas.length
      ? `AND display_ticket_id::text NOT IN (${indevidas.map(i => `'${i}'`).join(',')})`
      : '';
    const rows = await dwQuery(`
      SELECT
        DATE(resolved_at_local)::text AS dia,
        agent_on_resolution_name AS agente,
        COUNT(*)::int AS volume,
        ROUND(COUNT(CASE WHEN csat_score >= 4 ${indevidasNotIn} THEN 1 END) * 100.0
          / NULLIF(COUNT(CASE WHEN csat_score IS NOT NULL ${indevidasNotIn} THEN 1 END), 0), 1) AS csat,
        ROUND(AVG(CASE WHEN first_agent_reply_time_min >= 0 AND first_agent_reply_time_min <= 480 THEN first_agent_reply_time_min END) / 60.0, 1) AS resp_h
      FROM dw.fact_cloudchat_tickets
      WHERE agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz')
        AND ticket_status = 'resolved'
        AND resolved_at_local >= '${inicio}' AND resolved_at_local < '${fim}'
      GROUP BY 1, 2 ORDER BY 1, 2
    `);
    const byAgent = {};
    for (const r of rows) {
      const [dia, agente, volume, csat, resp_h] = r;
      if (!byAgent[agente]) byAgent[agente] = [];
      byAgent[agente].push({ dia, volume: Number(volume)||0, csat: csat!==null?Number(csat):null, resp_h: resp_h!==null?Number(resp_h):null });
    }
    res.json(byAgent);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/clear-ops-cache', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await pool.query(`DELETE FROM support_bi.kpis_op_cache`);
    // Also reset in-memory first-reply cache so stale DB entries are ignored
    Object.keys(_frCC).forEach(k => delete _frCC[k]);
    const r2 = await pool.query(`DELETE FROM support_bi.first_reply_cc_cache`);
    res.json({ ok: true, deleted_ops: r.rowCount, deleted_fr: r2.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
      const sun = new Date(d);
      sun.setUTCDate(d.getUTCDate() - dow); // volta até o domingo da semana
      const semChave = sun.toISOString().slice(0, 10);
      if (!semanas[semChave]) semanas[semChave] = { total: 0, total_recebidos: 0, total_avaliados: 0, total_positivos: 0, dias: 0, por_agente: {}, por_agente_positivos: {}, por_agente_outros: {}, tags: {}, tags_positivos: {}, pior_dia: null, pior_total: 0 };
      semanas[semChave].total           += total;
      semanas[semChave].total_recebidos += total_recebidos;
      semanas[semChave].total_avaliados += total_avaliados;
      semanas[semChave].total_positivos += total_positivos;
      semanas[semChave].dias++;
      for (const [a, c] of Object.entries(por_agente))              semanas[semChave].por_agente[a]          = (semanas[semChave].por_agente[a]          || 0) + c;
      for (const [a, c] of Object.entries(por_agente_positivos))    semanas[semChave].por_agente_positivos[a] = (semanas[semChave].por_agente_positivos[a] || 0) + c;
      for (const [a, c] of Object.entries(por_agente_outros))       semanas[semChave].por_agente_outros[a]    = (semanas[semChave].por_agente_outros[a]    || 0) + c;
      for (const [t, c] of Object.entries(tags_resumo))             semanas[semChave].tags[t]                = (semanas[semChave].tags[t]                 || 0) + c;
      for (const [t, c] of Object.entries(tags_resumo_positivos))   semanas[semChave].tags_positivos[t]      = (semanas[semChave].tags_positivos[t]       || 0) + c;
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

// Pré-aquece cache de 1ª resposta para semana e mês atuais (em sequência, respeitando rate limit)
function _warmupFirstReplyCache() {
  const now = new Date(Date.now() - 3 * 3600000); // hora BRT
  const dow  = now.getDay();
  const diff = dow === 0 ? 6 : dow - 1;
  const monday = new Date(now.getTime() - diff * 86400000);
  const d0Week  = monday.toISOString().slice(0, 10);
  const d0Month = now.toISOString().slice(0, 7) + '-01';
  const d1      = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  const keyWeek  = `${d0Week}_${d1}`;
  const keyMonth = `${d0Month}_${d1}`;
  // Semana: começa após 10s (cache já invalidado)
  setTimeout(() => {
    console.log('[warmup] 1ª resposta semana:', keyWeek);
    _computeFirstReplyCC(d0Week, d1, keyWeek).catch(e => console.error('[warmup] semana:', e.message));
  }, 10000);
  // Mês: começa após 120s (semana já terminou, respeita rate limit)
  setTimeout(() => {
    console.log('[warmup] 1ª resposta mês:', keyMonth);
    _computeFirstReplyCC(d0Month, d1, keyMonth).catch(e => console.error('[warmup] mês:', e.message));
  }, 120000);
}

// Cron: todo dia às 10h UTC (7h Brasília) — data de criação do ticket, alinhado com CloudChat
cron.schedule('0 10 * * *', () => {
  console.log('Cron 7h — processando ontem...');
  runDailyReport(null, false).catch(err => console.error('Erro no cron 7h:', err.message));
  pool.query(`DELETE FROM support_bi.kpis_op_cache WHERE period_key LIKE 'semana:%' OR period_key LIKE 'mes:%' OR period_key LIKE 'dia:%'`)
    .then(() => { console.log('[cron 7h] cache kpis-op invalidado'); _warmupFirstReplyCache(); })
    .catch(err => console.error('[cron 7h] erro ao invalidar cache kpis-op:', err.message));
});

// Cron: todo dia às 15h UTC (12h Brasília) — reprocessa ontem para capturar avaliações tardias
cron.schedule('0 15 * * *', () => {
  console.log('Cron 12h — reprocessando ontem com force...');
  runDailyReport(null, true).catch(err => console.error('Erro no cron 12h:', err.message));
  pool.query(`DELETE FROM support_bi.kpis_op_cache WHERE period_key LIKE 'semana:%' OR period_key LIKE 'mes:%' OR period_key LIKE 'dia:%'`)
    .then(() => console.log('[cron 12h] cache kpis-op invalidado'))
    .catch(err => console.error('[cron 12h] erro ao invalidar cache kpis-op:', err.message));
});

// --- Lógica principal ---

function isAgentMonitorada(nome) {
  if (!nome) return false;
  return AGENTES.some(a => nome.includes(a));
}

async function runDailyReport(dateOverride = null, force = false) {
  const date = dateOverride || yesterdayDate();

  const existing = await pool.query(
    'SELECT 1 FROM support_bi.csat_reports WHERE date = $1',
    [date]
  );
  if (existing.rows.length > 0 && !force) return { status: 'ja_existe', date };

  const token = await getMetabaseToken();

  // Tickets marcados como indevidos para esse dia são excluídos dos totais
  const indevidasRes = await pool.query(
    'SELECT ticket_id FROM support_bi.csat_indevidas'
  );
  const indevidasSet = new Set(indevidasRes.rows.map(r => String(r.ticket_id)));

  // Busca avaliações via DW por resolved_at_local — mesma base das Métricas Ops
  const dateNext = addOneDay(date);
  const dwCsatRows = await dwQuery(`
    SELECT display_ticket_id, agent_on_resolution_name, csat_score,
           csat_feedback, contact_name, ticket_link
    FROM dw.fact_cloudchat_tickets
    WHERE csat_score IS NOT NULL
      AND ticket_status = 'resolved'
      AND resolved_at_local >= '${date}'
      AND resolved_at_local < '${dateNext}'
    ORDER BY resolved_at_local DESC
    LIMIT 2000
  `);
  const todosCsats = dwCsatRows.map(r => ({
    display_ticket_id:        r[0],
    agent_on_resolution_name: r[1],
    csat_score:               r[2] !== null ? Number(r[2]) : null,
    csat_feedback:            r[3] || null,
    contact_name:             r[4] || null,
    contact_email:            null,
    ticket_link:              r[5] || null,
  }));
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
    const nome = t.agent_on_resolution_name || 'Encerrado pelo seller';
    por_agente_outros[nome] = (por_agente_outros[nome] || 0) + 1;
  }
  const tickets_outros = outrosTickets.map(t => ({
    id:       t.display_ticket_id,
    link:     t.ticket_link || `https://cloudchat3.cloudhumans.com/app/accounts/73/conversations/${t.display_ticket_id}`,
    nota:     t.csat_score,
    agente:   t.agent_on_resolution_name || 'Encerrado pelo seller',
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
    total:           tickets.length,
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

function countBusinessDays(d0, d1) {
  let count = 0;
  const cur = new Date(d0 + 'T12:00:00Z');
  const end = new Date(d1 + 'T12:00:00Z');
  while (cur < end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

function yesterdayDate() {
  const date = new Date();
  date.setUTCHours(date.getUTCHours() - 3);
  date.setUTCDate(date.getUTCDate() - 1);
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

async function dwQuery(sql) {
  const token = await getMetabaseToken();
  const resp = await fetch(`${METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': token },
    body: JSON.stringify({ database: METABASE_DATABASE_ID, type: 'native', native: { query: sql } }),
  });
  const data = await resp.json();
  return data.data?.rows || [];
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

async function _tableExists(name) {
  const { rows } = await pool.query(`SELECT to_regclass($1) AS oid`, [`support_bi.${name}`]);
  return rows[0].oid !== null;
}

async function initDb() {
  const tables = [
    { name: 'csat_reports', ddl: `CREATE TABLE support_bi.csat_reports (
        date       VARCHAR(10) PRIMARY KEY,
        data       JSONB       NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )` },
    { name: 'csat_indevidas', ddl: `CREATE TABLE support_bi.csat_indevidas (
        ticket_id  VARCHAR(50) PRIMARY KEY,
        date       VARCHAR(10) NOT NULL,
        motivo     VARCHAR(100),
        observacao TEXT,
        marcado_em TIMESTAMPTZ DEFAULT NOW()
      )` },
    { name: 'csat_users', ddl: `CREATE TABLE support_bi.csat_users (
        id            SERIAL PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        name          TEXT,
        password_hash TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )` },
    { name: 'csat_reset_tokens', ddl: `CREATE TABLE support_bi.csat_reset_tokens (
        id         SERIAL PRIMARY KEY,
        email      TEXT NOT NULL,
        token      TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )` },
    { name: 'kpis_op_cache', ddl: `CREATE TABLE support_bi.kpis_op_cache (
        period_key  TEXT PRIMARY KEY,
        data        JSONB NOT NULL,
        fetched_at  TIMESTAMPTZ DEFAULT NOW()
      )` },
    { name: 'audit_absences', ddl: `CREATE TABLE support_bi.audit_absences (
        id         SERIAL PRIMARY KEY,
        agent      TEXT NOT NULL,
        start_date DATE NOT NULL,
        end_date   DATE NOT NULL,
        type       TEXT NOT NULL DEFAULT 'ausencia',
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )` },
    { name: 'audit_snooze_tickets', ddl: `CREATE TABLE support_bi.audit_snooze_tickets (
        id               INTEGER PRIMARY KEY,
        computed_at      DATE NOT NULL,
        agente           TEXT,
        snoozed_by       TEXT,
        n_snoozes        INTEGER DEFAULT 0,
        snoozes_com_nota INTEGER DEFAULT 0,
        snoozes_sem_nota INTEGER DEFAULT 0,
        is_s1            BOOLEAN DEFAULT FALSE,
        is_s1_pre        BOOLEAN DEFAULT FALSE,
        is_s1_post       BOOLEAN DEFAULT FALSE,
        s1_pre_com_nota  BOOLEAN DEFAULT FALSE,
        s1_post_com_nota BOOLEAN DEFAULT FALSE,
        is_s3            BOOLEAN DEFAULT FALSE,
        s3_max_gap_bh    NUMERIC DEFAULT 0,
        max_gap_bh       NUMERIC DEFAULT 0,
        has_big_gap      BOOLEAN DEFAULT FALSE,
        note_count       INTEGER DEFAULT 0,
        excluded_absence BOOLEAN DEFAULT FALSE,
        resolved_at      BIGINT,
        data             JSONB
      )` },
    { name: 'audit_validations', ddl: `CREATE TABLE support_bi.audit_validations (
        id           SERIAL PRIMARY KEY,
        ticket_id    INTEGER NOT NULL,
        indicator    TEXT NOT NULL,
        validated_by TEXT NOT NULL,
        status       TEXT NOT NULL,
        reason       TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(ticket_id, indicator)
      )` },
  ];
  for (const { name, ddl } of tables) {
    if (!await _tableExists(name)) {
      await pool.query(ddl);
      console.log(`[initDb] tabela criada: ${name}`);
    }
  }
  await pool.query(`ALTER TABLE support_bi.csat_users ALTER COLUMN password_hash DROP NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE support_bi.audit_snooze_tickets ADD COLUMN IF NOT EXISTS is_s1_pre BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE support_bi.audit_snooze_tickets ADD COLUMN IF NOT EXISTS is_s1_post BOOLEAN DEFAULT FALSE`).catch(() => {});
  const _auditHasCol = async col => (await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='support_bi' AND table_name='audit_snooze_tickets' AND column_name=$1`, [col]
  )).rows.length > 0;
  if (!await _auditHasCol('s1_pre_com_nota'))
    await pool.query(`ALTER TABLE support_bi.audit_snooze_tickets ADD COLUMN s1_pre_com_nota BOOLEAN DEFAULT FALSE`);
  if (!await _auditHasCol('s1_post_com_nota'))
    await pool.query(`ALTER TABLE support_bi.audit_snooze_tickets ADD COLUMN s1_post_com_nota BOOLEAN DEFAULT FALSE`);
  await auditSeedAbsences().catch(e => console.error('[initDb] seed ausências:', e.message));
  console.log('[initDb] banco de dados pronto.');
}

// ══════════════════════════════════════════════════════════════════════════════
// AUDIT PANEL — Adiamentos e follow-up (gestão apenas)
// Rota separada: não afeta nada visível para as agentes.
// ══════════════════════════════════════════════════════════════════════════════

const MONITORED_AUDIT  = ['Mari', 'Fernanda Cavalcante', 'Paty', 'Lu Almeida', 'Rafa', 'Natchely Ortiz'];
const MONITORED_FIRST  = MONITORED_AUDIT.map(n => n.toLowerCase().split(' ')[0]);
const AUDIT_BH_START  = 9 * 60;         // 9:00 BRT em minutos
const AUDIT_BH_END    = 18 * 60 + 48;   // 18:48 BRT em minutos (588 min/dia)
const AUDIT_BRT_OFF   = -3 * 3600000;   // UTC-3 em ms
const AUDIT_BH_DAY    = 588;            // minutos por dia útil

function auditRequireMgmt(req, res, next) {
  const email = verifySession(getSessionToken(req));
  if (!email) return res.status(401).json({ error: 'Não autorizado' });
  const mgmt = (process.env.MANAGEMENT_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!mgmt.length) return res.status(403).json({ error: 'Acesso bloqueado: configure MANAGEMENT_EMAILS no Heroku' });
  if (!mgmt.includes(email.toLowerCase())) return res.status(403).json({ error: 'Acesso restrito à gestão' });
  req.auditEmail = email;
  next();
}

function auditBhMins(sTs, eTs) {
  if (!sTs || !eTs || eTs <= sTs) return 0;
  let tot = 0;
  const sMs = sTs * 1000 + AUDIT_BRT_OFF;
  const eMs = eTs * 1000 + AUDIT_BRT_OFF;
  const d = new Date(sMs); d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() < eMs) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      const open  = d.getTime() + AUDIT_BH_START * 60000;
      const close = d.getTime() + AUDIT_BH_END   * 60000;
      const f = Math.max(sMs, open), t = Math.min(eMs, close);
      if (t > f) tot += (t - f) / 60000;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return tot;
}

async function auditCc(path, method = 'GET', body = null, retries = 3) {
  const token = process.env.CLOUDCHAT_TOKEN;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await fetchCloudChat(path, token, method, body);
      return data;
    } catch (e) {
      if (e.httpStatus === 429) { await new Promise(r => setTimeout(r, 30000)); continue; }
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function auditPooled(items, fn, concurrency = 6) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency)
    out.push(...await Promise.all(items.slice(i, i + concurrency).map(fn)));
  return out;
}

function parseSnoozedBy(content) {
  const m = (content || '').match(/adiada?\s+por\s+(.+)/i);
  return m ? m[1].trim() : null;
}

// Verifica se um nome de ausência corresponde ao nome de quem adiou
function auditAgentMatches(absAgent, snoozedByName) {
  if (!snoozedByName) return false;
  const a = absAgent.toLowerCase().trim();
  const s = snoozedByName.toLowerCase().trim();
  return a === s || a.startsWith(s) || s.startsWith(a.split(' ')[0]);
}

// Data do timestamp em BRT (YYYY-MM-DD)
function auditDateBRT(ts) {
  return new Date(ts * 1000 + AUDIT_BRT_OFF).toISOString().slice(0, 10);
}

// Retorna true se o snooze em `actTs` caiu durante uma ausência do agente `snoozedByName`
function isSnoozeExcused(actTs, snoozedByName, absences) {
  const dateStr = auditDateBRT(actTs);
  return absences.some(a => auditAgentMatches(a.agent, snoozedByName) && dateStr >= a.start_date && dateStr <= a.end_date);
}

// Retorna true se ts (unix seg) está fora do expediente BRT (antes 9h, após 18h48, sáb, dom)
// Usa o mesmo padrão de auditBhMins: adiciona AUDIT_BRT_OFF para operar em espaço BRT
function isAuditOffHours(ts) {
  if (!ts) return false;
  const d = new Date(ts * 1000 + AUDIT_BRT_OFF);
  const dow = d.getUTCDay(), min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow === 0 || dow === 6 || min < AUDIT_BH_START || min >= AUDIT_BH_END;
}

// Retorna unix seg do início do próximo expediente (9h BRT) após ts
// Opera em espaço BRT (+ AUDIT_BRT_OFF), depois converte de volta (- AUDIT_BRT_OFF)
function nextAuditBizStart(ts) {
  if (!ts) return Infinity;
  const d = new Date(ts * 1000 + AUDIT_BRT_OFF); // espaço BRT
  d.setUTCHours(0, 0, 0, 0);                     // meia-noite BRT
  d.setUTCDate(d.getUTCDate() + 1);              // dia seguinte
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  // 9h BRT no espaço BRT = d.getTime() + AUDIT_BH_START * 60000
  // Converte de volta para unix: subtract AUDIT_BRT_OFF (= add 3h)
  return Math.floor((d.getTime() + AUDIT_BH_START * 60000 - AUDIT_BRT_OFF) / 1000);
}

// Busca TODAS as mensagens de uma conversa com paginação (param ?before=id)
// Passa pelo mesmo rate limiter do auditCc (CONC=3 no auditComputeRange)
async function fetchAllAuditMessages(convId) {
  const all = [];
  let before = null;
  for (let page = 0; page < 30; page++) {
    const url = `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${convId}/messages${before ? `?before=${before}` : ''}`;
    let batch;
    try {
      const r = await auditCc(url);
      batch = r?.payload || r?.data?.payload || [];
    } catch { break; }
    if (!batch.length) break;
    batch.sort((a, b) => a.id - b.id);
    before = batch[0].id;
    all.push(...batch);
    if (batch.length < 20) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const seen = new Set();
  return all
    .filter(m => seen.has(m.id) ? false : (seen.add(m.id), true))
    .sort((a, b) => a.created_at - b.created_at);
}

async function auditAnalyzeTicket(ticket, absences) {
  let msgs = [];
  try {
    msgs = await fetchAllAuditMessages(ticket.id);
  } catch { return null; }
  if (!msgs.length) return null;

  const BOT_NAME_RE = /bot|claudia|automac|automat|system/i;
  const snoozeActs = msgs.filter(m => m.message_type === 2 && /adiou|adiada|adiado/i.test(m.content || ''));
  // Só conta respostas e notas de agentes monitoradas (exclui Júlia, Hari e bots)
  const agentOut   = msgs.filter(m => m.message_type === 1 && !m.private && !m.sender?.is_ai_agent &&
                                      MONITORED_FIRST.includes((m.sender?.name || '').toLowerCase().split(' ')[0]));
  const notes      = msgs.filter(m => m.message_type === 1 && m.private &&
                                      !m.sender?.is_ai_agent && !BOT_NAME_RE.test(m.sender?.name || '') &&
                                      MONITORED_FIRST.includes((m.sender?.name || '').toLowerCase().split(' ')[0]));
  const resolvedAt = ticket.last_activity_at || 0;
  const createdAt  = ticket.created_at || 0;

  // Quem adiou em cada atividade (bot snoozes nunca contam)
  let snoozesCom = 0, snoozesSem = 0, snoozedBy = null;
  const effectiveSnoozes = [];

  for (const act of snoozeActs) {
    const byName = parseSnoozedBy(act.content);
    // Ignorar adiamentos de bot ou de agente não monitorada (ex: Júlia, Hari)
    if (!byName || BOT_NAME_RE.test(byName) || act.sender?.type === 'agent_bot') continue;
    if (!MONITORED_FIRST.some(fn => byName.toLowerCase().startsWith(fn))) continue;
    snoozedBy = byName;

    // Nota dentro de ±30 min deste adiamento (humanas monitoradas)
    const hasNote = notes.some(n => n.created_at >= act.created_at - 1800 && n.created_at <= act.created_at + 1800);
    if (hasNote) snoozesCom++; else snoozesSem++;

    // Excluir da análise de S1/S3 apenas o que acontece dentro do período de ausência do adiador
    if (!isSnoozeExcused(act.created_at, byName, absences)) {
      effectiveSnoozes.push(act);
    }
  }

  // agente = quem adiou (não o assignee atual)
  const agente = snoozedBy || ticket.meta?.assignee?.name || '';

  // Mensagens do cliente (tipo 0) e respostas públicas da agente (tipo 1, não bot, não privada)
  const clientMsgs = msgs.filter(m => m.message_type === 0);

  // Helper: havia mensagem do cliente esperando resposta no momento snoozeTs?
  // Retorna { waiting: bool, clientTs: unix|null }
  function clientWaitingAt(snoozeTs) {
    const lastClient = clientMsgs.filter(m => m.created_at < snoozeTs).at(-1);
    const lastAgent  = agentOut.filter(m => m.created_at < snoozeTs).at(-1);
    if (!lastClient) return { waiting: false, clientTs: null };
    const waiting = !lastAgent || lastClient.created_at > lastAgent.created_at;
    return { waiting, clientTs: lastClient.created_at };
  }

  // S1-pre: havia cliente esperando E nenhuma agente humana havia respondido ainda
  // S1-post: havia cliente esperando E alguma agente já havia respondido antes
  // Ambos excluem caso off-hours (msg do cliente fora do expediente + snooze antes do próximo)
  let isS1Pre = false, isS1Post = false;
  if (effectiveSnoozes.length > 0) {
    const { waiting, clientTs } = clientWaitingAt(effectiveSnoozes[0].created_at);
    if (waiting) {
      const offHours       = isAuditOffHours(clientTs);
      const snoozeBeforeNB = effectiveSnoozes[0].created_at < nextAuditBizStart(clientTs);
      if (!(offHours && snoozeBeforeNB)) {
        const hadPriorHumanReply = agentOut.some(m => m.created_at < effectiveSnoozes[0].created_at);
        if (hadPriorHumanReply) { isS1Post = true; } else { isS1Pre = true; }
      }
    }
  }
  const isS1 = isS1Pre || isS1Post;

  // Nota nos adiamentos que geraram S1pre / S1post
  let s1PreComNota = false, s1PostComNota = false;
  if (isS1Pre) {
    const s1PreSnoozes = effectiveSnoozes.filter(act => {
      const { waiting } = clientWaitingAt(act.created_at);
      return waiting && !agentOut.some(m => m.created_at < act.created_at);
    });
    s1PreComNota = s1PreSnoozes.length > 0 &&
      s1PreSnoozes.every(act => notes.some(n => n.created_at >= act.created_at - 1800 && n.created_at <= act.created_at + 1800));
  }
  if (isS1Post) {
    // Todos os adiamentos efetivos onde o cliente estava esperando e já havia resposta anterior
    const s1PostSnoozes = effectiveSnoozes.filter(act => {
      const { waiting } = clientWaitingAt(act.created_at);
      return waiting && agentOut.some(m => m.created_at < act.created_at);
    });
    // "com nota" só se TODOS tiveram nota; qualquer um sem nota → false
    s1PostComNota = s1PostSnoozes.length > 0 &&
      s1PostSnoozes.every(act => notes.some(n => n.created_at >= act.created_at - 1800 && n.created_at <= act.created_at + 1800));
  }

  // S3: grupo de 2+ adiamentos efetivos onde havia cliente esperando em CADA adiamento do grupo,
  //     sem msg da agente entre eles, E ≥ 2h úteis entre 1º e último do grupo
  let isS3 = false, s3MaxGapBH = 0;
  // Filtra para adiamentos onde havia cliente esperando
  const snoozeWithClient = effectiveSnoozes.filter(s => clientWaitingAt(s.created_at).waiting);
  if (snoozeWithClient.length >= 2) {
    const groups = [];
    let cur = [snoozeWithClient[0]];
    for (let i = 1; i < snoozeWithClient.length; i++) {
      const t1 = snoozeWithClient[i-1].created_at, t2 = snoozeWithClient[i].created_at;
      if (!agentOut.some(m => m.created_at > t1 && m.created_at < t2)) {
        cur.push(snoozeWithClient[i]);
      } else {
        groups.push(cur);
        cur = [snoozeWithClient[i]];
      }
    }
    groups.push(cur);
    for (const grp of groups) {
      if (grp.length >= 2) {
        const g = auditBhMins(grp[0].created_at, grp[grp.length - 1].created_at);
        if (g >= 120) {
          isS3 = true;
          if (g > s3MaxGapBH) s3MaxGapBH = g;
        }
      }
    }
  }

  // Timestamp da primeira atribuição do ticket à agente monitorada (atividade "atribu*" no histórico)
  const agenteFn = agente.toLowerCase().split(' ')[0];
  const assignTs = msgs
    .filter(m => m.message_type === 2 && /atribu/i.test(m.content || '') &&
                 new RegExp(agenteFn, 'i').test(m.content || ''))
    .map(m => m.created_at)
    .sort((a, b) => a - b)[0] ?? null;

  // Maior gap: conta a partir da atribuição à agente (tempo em fila/Claudia não conta)
  let maxGapBH = 0;
  const gapClientMsgs = assignTs != null ? clientMsgs.filter(m => m.created_at >= assignTs) : clientMsgs;
  const allGapEvents = [...gapClientMsgs, ...agentOut].sort((a, b) => a.created_at - b.created_at);
  let waitStart = null;
  for (const m of allGapEvents) {
    if (m.message_type === 0) {
      if (waitStart === null) waitStart = m.created_at;
    } else {
      if (waitStart !== null) {
        const bh = auditBhMins(waitStart, m.created_at);
        if (bh > maxGapBH) maxGapBH = bh;
        waitStart = null;
      }
    }
  }
  if (waitStart !== null) {
    const bh = auditBhMins(waitStart, resolvedAt || gapClientMsgs.at(-1)?.created_at || agentOut.at(-1)?.created_at || waitStart);
    if (bh > maxGapBH) maxGapBH = bh;
  }

  // excluded_absence = TRUE somente quando TODOS os adiamentos foram excluídos por ausência
  const excludedAbsence = snoozeActs.length > 0 && effectiveSnoozes.length === 0;

  return {
    id: ticket.id, agente, snoozedBy,
    nSnoozes: snoozeActs.length,
    snoozesCom, snoozesSem,
    isS1, isS1Pre, isS1Post, s1PreComNota, s1PostComNota, isS3, s3MaxGapBH, maxGapBH,
    hasBigGap: maxGapBH >= AUDIT_BH_DAY,
    noteCount: notes.length,
    excludedAbsence, resolvedAt,
  };
}

async function auditComputeRange(fromDate, toDate, onProgress = null) {
  const sinceS = Math.floor(new Date(fromDate + 'T03:00:00Z').getTime() / 1000);
  const untilS = Math.floor(new Date(toDate   + 'T03:00:00Z').getTime() / 1000) + 86400;

  const absRows  = await pool.query(`SELECT agent, start_date::text, end_date::text, type FROM support_bi.audit_absences`);
  const absences = absRows.rows;

  const agentsRaw = await auditCc(`/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/agents`);
  const agentsArr = Array.isArray(agentsRaw) ? agentsRaw : (agentsRaw?.data || []);
  const monIds    = agentsArr.filter(a => MONITORED_AUDIT.includes(a.name)).map(a => a.id);

  const filterPayload = { payload: [
    { attribute_key: 'assignee_id', filter_operator: 'equal_to', values: monIds, query_operator: 'AND' },
    { attribute_key: 'status',      filter_operator: 'equal_to', values: ['resolved'], query_operator: null },
  ]};

  if (onProgress) onProgress({ step: 'paginando', progress: 5, total: 0, analyzed: 0 });

  let tickets = [];
  for (let page = 1; page <= 200; page++) {
    const data  = await auditCc(`/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/filter?page=${page}`, 'POST', filterPayload);
    const items = data?.data?.payload || data?.payload || [];
    if (!items.length) break;
    tickets.push(...items.filter(c => { const lat = c.last_activity_at || 0; return lat >= sinceS && lat < untilS; }));
    const oldest = items.reduce((m, c) => Math.min(m, c.last_activity_at || 0), Infinity);
    if (oldest < sinceS || items.length < 25) break;
  }
  const seen = new Set();
  tickets = tickets.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });

  if (onProgress) onProgress({ step: 'analisando', progress: 10, total: tickets.length, analyzed: 0 });

  // Analisa em batches e atualiza progresso
  const results = [];
  const CONC = 3;
  for (let i = 0; i < tickets.length; i += CONC) {
    const batch = await Promise.all(tickets.slice(i, i + CONC).map(t => auditAnalyzeTicket(t, absences)));
    results.push(...batch.filter(Boolean));
    if (onProgress) {
      const analyzed = i + CONC;
      const progress = 10 + Math.round((analyzed / tickets.length) * 85);
      onProgress({ step: 'analisando', progress: Math.min(progress, 95), total: tickets.length, analyzed: results.length });
    }
  }

  // Persist/upsert computed tickets
  for (const r of results) {
    await pool.query(`
      INSERT INTO support_bi.audit_snooze_tickets
        (id, computed_at, agente, snoozed_by, n_snoozes, snoozes_com_nota, snoozes_sem_nota,
         is_s1, is_s1_pre, is_s1_post, is_s3, s3_max_gap_bh, max_gap_bh, has_big_gap, note_count, excluded_absence, resolved_at, data,
         s1_pre_com_nota, s1_post_com_nota)
      VALUES ($1, NOW()::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (id) DO UPDATE SET
        computed_at=EXCLUDED.computed_at, agente=EXCLUDED.agente, snoozed_by=EXCLUDED.snoozed_by,
        n_snoozes=EXCLUDED.n_snoozes, snoozes_com_nota=EXCLUDED.snoozes_com_nota,
        snoozes_sem_nota=EXCLUDED.snoozes_sem_nota, is_s1=EXCLUDED.is_s1,
        is_s1_pre=EXCLUDED.is_s1_pre, is_s1_post=EXCLUDED.is_s1_post,
        s1_pre_com_nota=EXCLUDED.s1_pre_com_nota, s1_post_com_nota=EXCLUDED.s1_post_com_nota,
        is_s3=EXCLUDED.is_s3, s3_max_gap_bh=EXCLUDED.s3_max_gap_bh, max_gap_bh=EXCLUDED.max_gap_bh,
        has_big_gap=EXCLUDED.has_big_gap, note_count=EXCLUDED.note_count,
        excluded_absence=EXCLUDED.excluded_absence, resolved_at=EXCLUDED.resolved_at, data=EXCLUDED.data
    `, [
      r.id, r.agente, r.snoozedBy, r.nSnoozes, r.snoozesCom, r.snoozesSem,
      r.isS1, r.isS1Pre, r.isS1Post, r.isS3, r.s3MaxGapBH, r.maxGapBH, r.hasBigGap,
      r.noteCount, r.excludedAbsence, r.resolvedAt, JSON.stringify(r),
      r.s1PreComNota, r.s1PostComNota,
    ]).catch(e => console.error('[audit] upsert ticket', r.id, e.message));
  }

  if (onProgress) onProgress({ step: 'concluído', progress: 100, total: tickets.length, analyzed: results.length });
  return { total: tickets.length, analyzed: results.length };
}

function previousBusinessDate() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 3); // BRT
  d.setUTCDate(d.getUTCDate() - 1);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Cron: computa auditoria do dia útil anterior às 6:30 ──
cron.schedule('30 6 * * 1-5', async () => {
  try {
    const prev = previousBusinessDate();
    console.log('[audit-cron] iniciando computo para', prev);
    await auditComputeRange(prev, prev);
    console.log('[audit-cron] concluído para', prev);
  } catch (e) {
    console.error('[audit-cron] erro:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ── Cron: resumo semanal toda segunda às 7h via Discord (canal fórum) ──
cron.schedule('0 7 * * 1', async () => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return console.warn('[audit-weekly] DISCORD_WEBHOOK_URL não definido');
  try {
    // Semana anterior: seg a sex
    const now  = new Date();
    const mon  = new Date(now); mon.setDate(now.getDate() - 7); mon.setHours(0,0,0,0);
    const fri  = new Date(mon); fri.setDate(mon.getDate() + 4);
    const from = mon.toISOString().slice(0, 10);
    const to   = fri.toISOString().slice(0, 10);
    const prevMon = new Date(mon); prevMon.setDate(mon.getDate() - 7);
    const prevFri = new Date(prevMon); prevFri.setDate(prevMon.getDate() + 4);

    async function weekStats(f, t) {
      const r = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE is_s1 AND NOT excluded_absence)       AS s1,
          COUNT(*) FILTER (WHERE is_s3 AND NOT excluded_absence)       AS s3,
          COUNT(*) FILTER (WHERE has_big_gap AND NOT excluded_absence) AS gap,
          SUM(snoozes_sem_nota) FILTER (WHERE NOT excluded_absence)    AS sem_nota,
          SUM(n_snoozes)        FILTER (WHERE NOT excluded_absence)    AS total_snooz,
          COUNT(*)                                                     AS total
        FROM support_bi.audit_snooze_tickets
        WHERE (to_timestamp(resolved_at) AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date
      `, [f, t]);
      return r.rows[0];
    }

    const pendRow = await pool.query(`
      SELECT COUNT(DISTINCT t.id) AS pendentes
      FROM support_bi.audit_snooze_tickets t
      WHERE (t.is_s1 OR t.is_s3 OR t.has_big_gap) AND NOT t.excluded_absence
        AND NOT EXISTS (
          SELECT 1 FROM support_bi.audit_validations v
          WHERE v.ticket_id = t.id
        )
    `);

    const curr  = await weekStats(from, to);
    const prev  = await weekStats(prevMon.toISOString().slice(0,10), prevFri.toISOString().slice(0,10));
    const pendentes = Number(pendRow.rows[0].pendentes);

    const fmtDate = s => s.split('-').reverse().join('/');
    const pctN  = (n, d) => Number(d) > 0 ? Number(n) / Number(d) * 100 : 0;
    const fmt   = (n, d) => `${pctN(n, d).toFixed(0)}% (${n} de ${d})`;
    const arrPp = (cn, cd, pn, pd) => {
      const diff = pctN(cn, cd) - pctN(pn, pd);
      if (Math.abs(diff) < 0.5) return '→ igual';
      const pp = Math.abs(diff).toFixed(0);
      return diff > 0 ? `↑ +${pp} pp` : `↓ -${pp} pp`;
    };

    const msg = {
      content: `**Auditoria de Adiamentos — ${fmtDate(from)} a ${fmtDate(to)}**`,
      embeds: [{
        color: 0xe91e8c,
        fields: [
          { name: '🔶 S1 — 1º adiamento sem resposta',        value: `${fmt(curr.s1,  curr.total)}  ${arrPp(curr.s1,  curr.total,  prev.s1,  prev.total)}`,                     inline: false },
          { name: '🔴 S3 — sem follow-up entre adiamentos',   value: `${fmt(curr.s3,  curr.total)}  ${arrPp(curr.s3,  curr.total,  prev.s3,  prev.total)}`,                     inline: false },
          { name: '🔵 Gap — mais de 1 dia útil sem mensagem', value: `${fmt(curr.gap, curr.total)}  ${arrPp(curr.gap, curr.total,  prev.gap, prev.total)}`,                     inline: false },
          { name: '📝 Adiamentos sem nota (30 min)',           value: `${fmt(curr.sem_nota||0, curr.total_snooz||0)}  ${arrPp(curr.sem_nota, curr.total_snooz, prev.sem_nota, prev.total_snooz)}`, inline: false },
          { name: '📦 Total de tickets resolvidos',            value: `${curr.total} tickets`,                                                                                  inline: true },
          { name: '⏳ Pendentes de validação',                 value: pendentes > 0 ? `**${pendentes}** sem validação` : '✅ Todos validados',                                   inline: true },
        ],
        footer: { text: 'https://gestao-sup-ink-709a6d9e0c6b.herokuapp.com/audit' },
      }],
    };

    const threadId = process.env.DISCORD_THREAD_ID;
    const webhookUrl = threadId ? `${webhook}?thread_id=${threadId}` : webhook;
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    console.log('[audit-weekly] resumo Discord enviado');
  } catch (e) {
    console.error('[audit-weekly] erro:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ── Pré-preenche ausências iniciais apenas se cada registro ainda não existe ──
async function auditSeedAbsences() {
  for (const [agent, date] of [['Paty', '2026-10-05'], ['Lu Almeida', '2026-10-06']]) {
    await pool.query(`
      INSERT INTO support_bi.audit_absences (agent, start_date, end_date, type, created_by)
      SELECT $1, $2::date, $2::date, 'ausencia', 'seed'
      WHERE NOT EXISTS (
        SELECT 1 FROM support_bi.audit_absences WHERE agent = $1 AND start_date = $2::date
      )
    `, [agent, date]);
  }
  console.log('[audit] ausências iniciais verificadas');
}

// ── Jobs em memória para reprocessamento em background (single dyno) ──
const _auditJobs = new Map();

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/audit', auditRequireMgmt, (req, res) => {
  res.sendFile('audit.html', { root: 'site' });
});

app.get('/audit/data', auditRequireMgmt, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from e to são obrigatórios (YYYY-MM-DD)' });

    const rows = await pool.query(`
      SELECT
        t.agente,
        COUNT(*)                                                               AS total,
        COUNT(*) FILTER (WHERE t.is_s1 AND NOT t.excluded_absence)            AS s1_raw,
        COUNT(*) FILTER (WHERE t.is_s1_pre AND NOT t.excluded_absence)        AS s1_pre_raw,
        COUNT(*) FILTER (WHERE t.is_s1_post AND NOT t.excluded_absence)       AS s1_post_raw,
        COUNT(*) FILTER (WHERE t.is_s3 AND NOT t.excluded_absence)            AS s3_raw,
        COUNT(*) FILTER (WHERE t.has_big_gap AND NOT t.excluded_absence)      AS gap_raw,
        SUM(t.snoozes_sem_nota) FILTER (WHERE NOT t.excluded_absence)         AS snoozes_sem_nota,
        SUM(t.n_snoozes)        FILTER (WHERE NOT t.excluded_absence)         AS snoozes_total,
        MAX(t.s3_max_gap_bh)    FILTER (WHERE t.is_s3 AND NOT t.excluded_absence) AS s3_max_gap_bh,
        MAX(t.max_gap_bh)       FILTER (WHERE t.has_big_gap AND NOT t.excluded_absence) AS max_gap_bh,
        COUNT(*) FILTER (WHERE t.is_s1_pre AND NOT t.excluded_absence AND NOT COALESCE(t.s1_pre_com_nota, FALSE))  AS s1_pre_sem_nota,
        COUNT(*) FILTER (WHERE t.is_s1_post AND NOT t.excluded_absence AND NOT COALESCE(t.s1_post_com_nota, FALSE)) AS s1_post_sem_nota,
        COUNT(*) FILTER (WHERE v1pre.status = 'confirmed')                    AS s1_pre_validated,
        COUNT(*) FILTER (WHERE v1post.status = 'confirmed')                   AS s1_post_validated,
        COUNT(*) FILTER (WHERE v1.status = 'confirmed')                       AS s1_validated,
        COUNT(*) FILTER (WHERE v3.status = 'confirmed')                       AS s3_validated,
        COUNT(*) FILTER (WHERE vg.status = 'confirmed')                       AS gap_validated,
        COUNT(*) FILTER (WHERE v1pre.status = 'excluded')                     AS s1_pre_excluded,
        COUNT(*) FILTER (WHERE v1post.status = 'excluded')                    AS s1_post_excluded,
        COUNT(*) FILTER (WHERE v1.status = 'excluded')                        AS s1_excluded,
        COUNT(*) FILTER (WHERE v3.status = 'excluded')                        AS s3_excluded,
        COUNT(*) FILTER (WHERE vg.status = 'excluded')                        AS gap_excluded
      FROM support_bi.audit_snooze_tickets t
      LEFT JOIN support_bi.audit_validations v1pre ON v1pre.ticket_id = t.id AND v1pre.indicator = 'S1pre'
      LEFT JOIN support_bi.audit_validations v1post ON v1post.ticket_id = t.id AND v1post.indicator = 'S1post'
      LEFT JOIN support_bi.audit_validations v1 ON v1.ticket_id = t.id AND v1.indicator = 'S1'
      LEFT JOIN support_bi.audit_validations v3 ON v3.ticket_id = t.id AND v3.indicator = 'S3'
      LEFT JOIN support_bi.audit_validations vg ON vg.ticket_id = t.id AND vg.indicator = 'gap'
      WHERE (to_timestamp(t.resolved_at) AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date
        AND t.agente = ANY(ARRAY['Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz'])
      GROUP BY t.agente
      ORDER BY t.agente
    `, [from, to]);

    res.json({ from, to, byAgent: rows.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/audit/tickets', auditRequireMgmt, async (req, res) => {
  try {
    const { from, to, type, agent } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from e to são obrigatórios' });

    const params = [from, to];
    let where = `(to_timestamp(t.resolved_at) AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date
        AND t.agente = ANY(ARRAY['Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa','Natchely Ortiz'])`;
    if (type === 'S1pre')  where += ` AND t.is_s1_pre = TRUE AND t.excluded_absence = FALSE`;
    else if (type === 'S1post') where += ` AND t.is_s1_post = TRUE AND t.excluded_absence = FALSE`;
    else if (type === 'S1')  where += ` AND t.is_s1 = TRUE AND t.excluded_absence = FALSE`;
    else if (type === 'S3')  where += ` AND t.is_s3 = TRUE AND t.excluded_absence = FALSE`;
    else if (type === 'gap') where += ` AND t.has_big_gap = TRUE AND t.excluded_absence = FALSE`;
    else where += ` AND (t.is_s1 OR t.is_s3 OR t.has_big_gap) AND t.excluded_absence = FALSE`;
    if (agent) { params.push(agent); where += ` AND t.agente = $${params.length}`; }

    const rows = await pool.query(`
      SELECT
        t.id, t.agente, t.snoozed_by, t.n_snoozes,
        t.snoozes_com_nota, t.snoozes_sem_nota,
        t.is_s1, t.is_s1_pre, t.is_s1_post, t.is_s3, t.has_big_gap,
        ROUND(t.s3_max_gap_bh / 588.0, 2) AS s3_max_gap_days,
        ROUND(t.max_gap_bh / 588.0, 2)    AS max_gap_days,
        t.note_count, t.excluded_absence,
        (to_timestamp(t.resolved_at) AT TIME ZONE 'America/Sao_Paulo')::date::text AS resolved_date,
        v1pre.status AS s1pre_status, v1pre.reason AS s1pre_reason, v1pre.validated_by AS s1pre_by,
        v1post.status AS s1post_status, v1post.reason AS s1post_reason, v1post.validated_by AS s1post_by,
        v1.status AS s1_status, v1.reason AS s1_reason, v1.validated_by AS s1_by,
        v3.status AS s3_status, v3.reason AS s3_reason, v3.validated_by AS s3_by,
        vg.status AS gap_status, vg.reason AS gap_reason, vg.validated_by AS gap_by
      FROM support_bi.audit_snooze_tickets t
      LEFT JOIN support_bi.audit_validations v1pre ON v1pre.ticket_id = t.id AND v1pre.indicator = 'S1pre'
      LEFT JOIN support_bi.audit_validations v1post ON v1post.ticket_id = t.id AND v1post.indicator = 'S1post'
      LEFT JOIN support_bi.audit_validations v1 ON v1.ticket_id = t.id AND v1.indicator = 'S1'
      LEFT JOIN support_bi.audit_validations v3 ON v3.ticket_id = t.id AND v3.indicator = 'S3'
      LEFT JOIN support_bi.audit_validations vg ON vg.ticket_id = t.id AND vg.indicator = 'gap'
      WHERE ${where}
      ORDER BY resolved_date DESC, t.id DESC
    `, params);

    res.json({ from, to, tickets: rows.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/audit/detail/:id', auditRequireMgmt, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    const dbRow = await pool.query(
      `SELECT resolved_at FROM support_bi.audit_snooze_tickets WHERE id = $1`, [id]
    );
    const resolvedAt = dbRow.rows[0]?.resolved_at || null;

    const msgs = await fetchAllAuditMessages(id);
    if (!msgs.length) return res.json({ timeline: [], gap: null });

    const BOT_NAME_RE = /bot|claudia|automac|automat|system/i;
    // Respostas e notas: só agentes monitoradas (exclui Júlia, Hari e bots)
    const agentOut  = msgs.filter(m => m.message_type === 1 && !m.private && !m.sender?.is_ai_agent &&
                                       MONITORED_FIRST.includes((m.sender?.name || '').toLowerCase().split(' ')[0]));
    const notesMsgs = msgs.filter(m => m.message_type === 1 && m.private &&
                                       !m.sender?.is_ai_agent && !BOT_NAME_RE.test(m.sender?.name || '') &&
                                       MONITORED_FIRST.includes((m.sender?.name || '').toLowerCase().split(' ')[0]));
    const clientMsgs = msgs.filter(m => m.message_type === 0);

    const timeline = [];
    for (const m of msgs) {
      const senderName = m.sender?.name || '—';
      const ts = m.created_at;

      if (m.message_type === 0) {
        timeline.push({ ts, kind: 'client' });
      } else if (m.message_type === 1 && m.private) {
        timeline.push({ ts, kind: 'note', sender: senderName });
      } else if (m.message_type === 1 && !m.private && !m.sender?.is_ai_agent) {
        timeline.push({ ts, kind: 'agent', sender: senderName });
      } else if (m.message_type === 2 && /adiou|adiada|adiado/i.test(m.content || '')) {
        const byName = parseSnoozedBy(m.content);
        if (byName && !BOT_NAME_RE.test(byName) && m.sender?.type !== 'agent_bot') {
          const agentsBefore = agentOut.filter(mm => mm.created_at < ts);
          const hadPrior     = agentsBefore.length > 0;
          const hadNote      = notesMsgs.some(nm => nm.created_at >= ts - 1800 && nm.created_at <= ts + 1800);
          const lastClient   = clientMsgs.filter(mm => mm.created_at < ts).at(-1);
          const lastAgBefore = agentsBefore.at(-1);
          const clientWaiting = !!lastClient && (!lastAgBefore || lastClient.created_at > lastAgBefore.created_at);
          timeline.push({ ts, kind: 'snooze', sender: byName, hadPrior, hadNote, clientWaiting });
        }
      }
    }
    timeline.sort((a, b) => a.ts - b.ts);

    // Maior gap: só conta tempo em que o cliente estava aguardando resposta
    let gap = null;
    const allGapEvts = [...clientMsgs, ...agentOut].sort((a, b) => a.created_at - b.created_at);
    const endTs = resolvedAt || (msgs.at(-1)?.created_at || 0);
    let bestBH = 0, bestS = null, bestE = null;
    let wStart = null;
    for (const m of allGapEvts) {
      if (m.message_type === 0) {
        if (wStart === null) wStart = m.created_at;
      } else {
        if (wStart !== null) {
          const bh = auditBhMins(wStart, m.created_at);
          if (bh > bestBH) { bestBH = bh; bestS = wStart; bestE = m.created_at; }
          wStart = null;
        }
      }
    }
    if (wStart !== null) {
      const bh = auditBhMins(wStart, endTs || wStart);
      if (bh > bestBH) { bestBH = bh; bestS = wStart; bestE = endTs; }
    }
    if (bestBH > 0) gap = { startTs: bestS, endTs: bestE, bhMins: bestBH };

    res.json({ timeline, gap });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/audit/validate/:id', auditRequireMgmt, express.json(), async (req, res) => {
  try {
    const { indicator, status, reason } = req.body;
    const ticketId = parseInt(req.params.id);
    if (!indicator || !status || !['S1pre','S1post','S1','S3','gap'].includes(indicator) || !['confirmed','excluded'].includes(status))
      return res.status(400).json({ error: 'indicator (S1pre|S1post|S1|S3|gap) e status (confirmed|excluded) são obrigatórios' });

    await pool.query(`
      INSERT INTO support_bi.audit_validations (ticket_id, indicator, validated_by, status, reason)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (ticket_id, indicator) DO UPDATE SET
        validated_by = EXCLUDED.validated_by,
        status       = EXCLUDED.status,
        reason       = EXCLUDED.reason,
        created_at   = NOW()
    `, [ticketId, indicator, req.auditEmail, status, reason || null]);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/audit/ping', auditRequireMgmt, (req, res) => res.json({ ok: true }));

app.get('/audit/absences', auditRequireMgmt, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, agent, start_date::text, end_date::text, type, created_by, created_at::text
      FROM support_bi.audit_absences
      ORDER BY start_date DESC
    `);
    res.json({ absences: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/audit/absences', auditRequireMgmt, express.json(), async (req, res) => {
  try {
    const { agent, start_date, end_date, type } = req.body;
    if (!agent || !start_date || !end_date) return res.status(400).json({ error: 'agent, start_date e end_date são obrigatórios' });
    await pool.query(`
      INSERT INTO support_bi.audit_absences (agent, start_date, end_date, type, created_by)
      VALUES ($1, $2, $3, $4, $5)
    `, [agent, start_date, end_date, type || 'ausencia', req.auditEmail]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/audit/absences/:id', auditRequireMgmt, async (req, res) => {
  try {
    await pool.query(`DELETE FROM support_bi.audit_absences WHERE id = $1`, [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /audit/run — dispara reprocessamento em background, retorna jobId
app.post('/audit/run', auditRequireMgmt, express.json(), (req, res) => {
  const { from, to } = req.body || {};
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !DATE_RE.test(from)) return res.status(400).json({ error: 'from deve ser uma data no formato AAAA-MM-DD' });
  if (to && !DATE_RE.test(to))      return res.status(400).json({ error: 'to deve ser uma data no formato AAAA-MM-DD' });
  const toDate = to || from;

  // Bloqueia reprocessamento manual durante horário comercial (9h–18h48 BRT)
  // Gestoras podem forçar com { force: true } no body
  if (!req.body?.force) {
    const nowBrt  = new Date(Date.now() - 3 * 3600000);
    const brtMins = nowBrt.getUTCHours() * 60 + nowBrt.getUTCMinutes();
    const brtDay  = nowBrt.getUTCDay();
    if (brtDay >= 1 && brtDay <= 5 && brtMins >= 9 * 60 && brtMins < 18 * 60 + 48) {
      return res.status(423).json({ error: 'Reprocessamento manual bloqueado durante o horário comercial (9h–18h48). Tente após as 18h48 ou use "Forçar agora".' });
    }
  }

  // Bloqueia segundo job se já há um rodando
  for (const [, job] of _auditJobs) {
    if (job.status === 'running') return res.status(409).json({ error: 'Já há um reprocessamento em andamento', jobId: job.jobId });
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const job = { jobId, from, to: toDate, status: 'running', step: 'iniciando', progress: 0, total: 0, analyzed: 0, startedAt: new Date().toISOString() };
  _auditJobs.set(jobId, job);
  // Limpa jobs antigos (mantém últimos 10)
  if (_auditJobs.size > 10) { const oldest = [..._auditJobs.keys()][0]; _auditJobs.delete(oldest); }

  const forced = !!req.body?.force;
  console.log(`[audit/run] job=${jobId} por=${req.auditEmail} force=${forced} período=${from}→${toDate} iniciado=${new Date().toISOString()}`);
  (async () => {
    try {
      await auditComputeRange(from, toDate, (prog) => Object.assign(job, prog));
      job.status = 'done';
      console.log(`[audit/run] job=${jobId} concluído: ${job.analyzed}/${job.total}`);
    } catch (e) {
      job.status = 'error'; job.error = e.message;
      console.error(`[audit/run] job=${jobId} erro:`, e.message);
    }
  })();

  res.json({ ok: true, jobId });
});

// GET /audit/run/status/:jobId — progresso do reprocessamento
app.get('/audit/run/status/:jobId', auditRequireMgmt, (req, res) => {
  const job = _auditJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json(job);
});

app.use(require('./ao-vivo-server')({ fetchCloudChat, CLOUDCHAT_BASE, CLOUDCHAT_ACCOUNT, dwQuery }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

(async function _initDbLoop() {
  while (true) {
    try {
      await initDb();
      return;
    } catch (err) {
      console.error('[initDb] falhou:', err.message, '— retentando em 60s');
      await new Promise(r => setTimeout(r, 60000));
    }
  }
})();
