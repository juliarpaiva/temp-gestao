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

const AUTH_SKIP = ['/login', '/logout', '/register', '/forgot-password', '/reset-password', '/health', '/run', '/webhook/csat-invalida', '/admin/indevidas-junho', '/admin/importar-indevidas', '/admin/schema-invalida', '/admin/puxar-indevidas-cloudchat', '/admin/diagnostico-junho', '/admin/corrigir-datas-indevidas', '/admin/clear-ops-cache', '/admin/reprocess-all'];

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

const CLOUDCHAT_BASE = 'https://cloudchat3.cloudhumans.com';
const CLOUDCHAT_ACCOUNT = 73;

async function fetchCloudChat(path, token, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'api_access_token': token, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${CLOUDCHAT_BASE}${path}`, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`CloudChat ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
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
      // Modo semana (padrão sáb–sex)
      let semana = req.query.semana;
      if (!semana) {
        const hoje = new Date();
        const dow  = hoje.getUTCDay();
        const daysSinceLastFri = dow === 5 ? 7 : (dow - 5 + 7) % 7;
        const lastFri = new Date(hoje);
        lastFri.setUTCDate(lastFri.getUTCDate() - daysSinceLastFri);
        const lastCompleteSat = new Date(lastFri);
        lastCompleteSat.setUTCDate(lastCompleteSat.getUTCDate() - 6);
        semana = lastCompleteSat.toISOString().slice(0, 10);
      }
      const sat = new Date(semana + 'T12:00:00Z');
      const nextSat = new Date(sat); nextSat.setUTCDate(nextSat.getUTCDate() + 7);
      const prevSat = new Date(sat); prevSat.setUTCDate(prevSat.getUTCDate() - 7);
      d0  = semana;
      d1  = nextSat.toISOString().slice(0, 10);
      pd0 = prevSat.toISOString().slice(0, 10);
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
      volume, respondidos, mediaDiaria, csatTime, csatClaudia, retencaoN1,
      tempoResposta, tempoEncerramento,
      volAnterior, retencaoAnterior, csatAnterior,
      porAgenteRows, snoozedRows,
      emAberto, semAtribuicao, pendentes
    ] = await Promise.all([
      sqlScalar(`SELECT COUNT(ticket_id) FROM dw.fact_cloudchat_tickets WHERE created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'resolved' AND agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa') AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND(COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT DATE(created_at_local)), 0), 1) FROM dw.fact_cloudchat_tickets WHERE created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND(((AVG(csat_score) - 1) / 4.0 * 100)::numeric, 1) FROM dw.fact_cloudchat_tickets WHERE csat_score IS NOT NULL AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND(((AVG(csat_score) - 1) / 4.0 * 100)::numeric, 1) FROM dw.fact_cloudchat_tickets WHERE csat_score IS NOT NULL AND agent_on_resolution_name ILIKE '%claudia%' AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'resolved' AND agent_on_resolution_name ILIKE '%claudia%' AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND(AVG(first_agent_reply_time_min) / 60.0, 1) FROM dw.fact_cloudchat_tickets WHERE first_agent_first_reply_at_local IS NOT NULL AND first_agent_reply_time_min IS NOT NULL AND first_agent_reply_time_min >= 0 AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT ROUND(AVG(first_agent_resolution_time_min) / 60.0, 1) FROM dw.fact_cloudchat_tickets WHERE resolved_at_local IS NOT NULL AND first_agent_resolution_time_min IS NOT NULL AND first_agent_resolution_time_min > 0 AND first_agent_resolution_time_min < 2880 AND created_at_local >= '${d0}' AND created_at_local < '${d1}'`),
      sqlScalar(`SELECT COUNT(ticket_id) FROM dw.fact_cloudchat_tickets WHERE created_at_local >= '${pd0}' AND created_at_local < '${d0}'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'resolved' AND agent_on_resolution_name ILIKE '%claudia%' AND created_at_local >= '${pd0}' AND created_at_local < '${d0}'`),
      sqlScalar(`SELECT ROUND(((AVG(csat_score) - 1) / 4.0 * 100)::numeric, 1) FROM dw.fact_cloudchat_tickets WHERE csat_score IS NOT NULL AND created_at_local >= '${pd0}' AND created_at_local < '${d0}'`),
      sqlRows(`
        SELECT
          COALESCE(t.agent_on_resolution_name, '(sem agente)') AS agente,
          COUNT(*) AS volume,
          ROUND(AVG(CASE WHEN t.first_agent_reply_time_min IS NOT NULL AND t.first_agent_first_reply_at_local IS NOT NULL AND t.first_agent_reply_time_min >= 0 THEN t.first_agent_reply_time_min END) / 60.0, 1) AS tempo_resp_h,
          ROUND(AVG(CASE WHEN t.first_agent_resolution_time_min IS NOT NULL AND t.first_agent_resolution_time_min > 0 AND t.first_agent_resolution_time_min < 2880 AND t.resolved_at_local IS NOT NULL THEN t.first_agent_resolution_time_min END) / 60.0, 1) AS tempo_enc_h,
          ROUND(((AVG(CASE WHEN t.csat_score IS NOT NULL THEN t.csat_score END) - 1) / 4.0 * 100)::numeric, 1) AS csat
        FROM dw.fact_cloudchat_tickets t
        LEFT JOIN dw.fact_cloudchat_ticket_custom_fields cf
          ON cf.ticket_id = t.ticket_id
          AND cf.field_name = 'aguardando_confirmao_de_resoluo_lojista'
        WHERE t.agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa')
          AND (
            (t.ticket_status = 'resolved' AND t.resolved_at_local >= '${d0}' AND t.resolved_at_local < '${d1}')
            OR (cf.field_value_bool = true AND t.created_at_local >= '${d0}' AND t.created_at_local < '${d1}')
          )
        GROUP BY 1
        ORDER BY volume DESC
      `),
      sqlRows(`
        SELECT
          COALESCE(t.agent_on_resolution_name, '(sem agente)') AS agente,
          COUNT(*) FILTER (WHERE cf.field_value_bool = true)   AS com_flag,
          COUNT(*) FILTER (WHERE cf.field_value_bool IS NOT TRUE) AS sem_flag,
          COUNT(*) AS total,
          ARRAY_AGG(t.display_ticket_id ORDER BY t.created_at_local DESC) FILTER (WHERE cf.field_value_bool = true) AS ids_com_flag,
          ARRAY_AGG(t.display_ticket_id ORDER BY t.created_at_local DESC) FILTER (WHERE cf.field_value_bool IS NOT TRUE) AS ids_sem_flag
        FROM dw.fact_cloudchat_tickets t
        LEFT JOIN dw.fact_cloudchat_ticket_custom_fields cf
          ON cf.ticket_id = t.ticket_id
          AND cf.field_name = 'aguardando_confirmao_de_resoluo_lojista'
        WHERE t.ticket_status = 'snoozed'
          AND t.agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa')
          AND t.created_at_local >= '${d0}' AND t.created_at_local < '${d1}'
        GROUP BY 1
        ORDER BY total DESC
      `),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'open'`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'open' AND agent_on_resolution_name IS NULL`),
      sqlScalar(`SELECT COUNT(*) FROM dw.fact_cloudchat_tickets WHERE ticket_status = 'pending'`)
    ]);

    const porAgente = porAgenteRows.map(r => ({
      agente: r[0],
      volume: Number(r[1]) || 0,
      tempo_resp_h: r[2] !== null ? Number(r[2]) : null,
      tempo_enc_h:  r[3] !== null ? Number(r[3]) : null,
      csat:         r[4] !== null ? Number(r[4]) : null,
    }));

    const snoozedPorAgente = snoozedRows.map(r => ({
      agente:       r[0],
      com_flag:     Number(r[1]) || 0,
      sem_flag:     Number(r[2]) || 0,
      total:        Number(r[3]) || 0,
      ids_com_flag: Array.isArray(r[4]) ? r[4].map(String) : [],
      ids_sem_flag: Array.isArray(r[5]) ? r[5].map(String) : [],
    }));

    const diasUteis = countBusinessDays(d0, d1);
    const kpisResult = {
      fetched_at: new Date().toISOString(),
      modo: modoLabel,
      semana: d0,
      semana_fim: new Date(new Date(d1) - 86400000).toISOString().slice(0, 10),
      semana_anterior: pd0,
      dias_uteis: diasUteis,
      meta_volume_por_agente: 45 * diasUteis,
      atual: {
        volume:               volume      ?? 0,
        respondidos:          respondidos ?? 0,
        media_diaria:         mediaDiaria ?? 0,
        csat_time:            csatTime,
        csat_claudia:         csatClaudia,
        retencao_n1:          retencaoN1  ?? 0,
        tempo_resposta_h:     tempoResposta,
        tempo_encerramento_h: tempoEncerramento,
        por_agente:           porAgente,
        snoozed_por_agente:   snoozedPorAgente,
        em_aberto:            emAberto      ?? 0,
        sem_atribuicao:       semAtribuicao ?? 0,
        pendentes:            pendentes     ?? 0,
      },
      anterior: {
        volume:      volAnterior       ?? 0,
        retencao_n1: retencaoAnterior  ?? 0,
        csat_time:   csatAnterior,
      },
    };
    pool.query(
      `INSERT INTO support_bi.kpis_op_cache (period_key, data) VALUES ($1,$2)
       ON CONFLICT (period_key) DO UPDATE SET data=$2, fetched_at=NOW()`,
      [periodKey, JSON.stringify(kpisResult)]
    ).catch(e => console.error('[kpis-cache]', e.message));
    res.json(kpisResult);
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

app.get('/admin/clear-ops-cache', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await pool.query(`DELETE FROM support_bi.kpis_op_cache`);
    res.json({ ok: true, deleted: r.rowCount });
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
      const mon = new Date(d);
      mon.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
      const semChave = mon.toISOString().slice(0, 10);
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

// Cron: todo dia útil às 10h UTC (7h Brasília)
cron.schedule('0 10 * * 1-5', () => {
  console.log('Cron disparado — processando dia útil anterior...');
  runDailyReport(null, false).catch(err => console.error('Erro no cron:', err.message));
  // Invalida cache de KPIs operacionais para forçar re-fetch com dados do dia
  pool.query(`DELETE FROM support_bi.kpis_op_cache WHERE period_key LIKE 'semana:%' OR period_key LIKE 'mes:%' OR period_key LIKE 'dia:%'`)
    .then(() => console.log('[cron] cache kpis-op invalidado'))
    .catch(err => console.error('[cron] erro ao invalidar cache kpis-op:', err.message));
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
    const nome = t.agent_on_resolution_name || 'Resolvido pelo seller';
    por_agente_outros[nome] = (por_agente_outros[nome] || 0) + 1;
  }
  const tickets_outros = outrosTickets.map(t => ({
    id:       t.display_ticket_id,
    link:     t.ticket_link || `https://cloudchat3.cloudhumans.com/app/accounts/73/conversations/${t.display_ticket_id}`,
    nota:     t.csat_score,
    agente:   t.agent_on_resolution_name || 'Resolvido pelo seller',
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_bi.kpis_op_cache (
      period_key  TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      fetched_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Banco de dados pronto.');
}

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)))
  .catch(err => { console.error('Erro ao inicializar:', err.message); process.exit(1); });
