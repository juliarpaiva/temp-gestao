'use strict';
const express = require('express');
const { Pool } = require('pg');

// ── Config — ajuste aqui ──────────────────────────────────────────────────────
const CFG = {
  POLL_TTL_S:      55,           // cache server-side (segundos)
  SLA_ATENCAO_MIN: 45,           // minutos sem 1ª resposta → atenção (amarelo)
  SLA_CRITICO_MIN: 60,           // minutos sem 1ª resposta → crítico (vermelho)
  BRT_OFFSET_H:   -3,            // fuso Brasília = UTC-3
  HORARIO: {
    inicio_min: 9 * 60,          // 9h00 BRT
    fim_min:    18 * 60 + 30,    // 18h30 BRT
    dias:       [1, 2, 3, 4, 5], // seg–sex
  },
  AGENTES: ['Mari', 'Fernanda Cavalcante', 'Paty', 'Lu Almeida', 'Rafa', 'Natchely Ortiz'],
  DISPLAY: {
    'Mari':                'Mari',
    'Fernanda Cavalcante': 'Fer',
    'Paty':                'Paty',
    'Lu Almeida':          'Lu',
    'Rafa':                'Rafa',
    'Natchely Ortiz':      'Natchely',
  },
};

// Minutos dentro do horário comercial (BRT) entre dois Unix timestamps (s).
function _bhMins(created_s, now_s) {
  const off = CFG.BRT_OFFSET_H * 3600000;
  const { inicio_min, fim_min, dias } = CFG.HORARIO;
  const startMs = created_s * 1000 + off;
  const endMs   = now_s   * 1000 + off;
  let total = 0;
  const d = new Date(startMs);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() < endMs) {
    if (dias.includes(d.getUTCDay())) {
      const open  = d.getTime() + inicio_min * 60000;
      const close = d.getTime() + fim_min   * 60000;
      const from  = Math.max(startMs, open);
      const to    = Math.min(endMs, close);
      if (to > from) total += (to - from) / 60000;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return total;
}

module.exports = function ({ fetchCloudChat, CLOUDCHAT_BASE, CLOUDCHAT_ACCOUNT, dwQuery }) {
  const router = express.Router();
  let _cache   = null;
  let _cacheTs = 0;
  const _statusHistory  = {}; // { agentName: { status, reason, since_s } }
  const _prevConfirmed  = {}; // estado confirmado antes da última transição (debounce)
  const _statusAccum    = {}; // { 'YYYY-MM-DD|agente' → { label → segundos } }
  const _convMsgCache   = new Map(); // conv_id → { lastAct, agentMsgsToday: Map<name,ts> }
  let _dbPool  = null;
  let _dbReady = false;
  let _agentIds = null;    // { agentName → chatwoot_id }, cache diário
  let _agentIdsDay = null;

  // ── resolved_at via activity messages ───────────────────────────────────────
  // Cache: convId → { resolvedAt_s: number|null, fetchedAt_s: number }
  const _resolvedAtCache = new Map();
  let _backlogVerified    = null; // { tickets, count, todayStartS, verifiedAt_s }
  let _backlogVerifyBusy  = false;

  // Retorna Unix timestamp da última activity "resolvid*" (ou null).
  // Cache TTL = 5 min. Não lança exceção.
  const _getResolvedAt = async (convId, token) => {
    const now_s  = Date.now() / 1000;
    const cached = _resolvedAtCache.get(convId);
    if (cached && (now_s - cached.fetchedAt_s) < 300) return cached.resolvedAt_s;
    try {
      const r    = await fetchCloudChat(`/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${convId}/messages`, token);
      const msgs = r?.payload || r?.data?.payload || [];
      // Cobre: "marcada como resolvida por X", "foi resolvida por automação", "resolvida" etc.
      const resActs = msgs
        .filter(m => m.message_type === 2 && /resolvid/i.test(m.content || ''))
        .sort((a, b) => b.created_at - a.created_at);
      const resolvedAt_s = resActs[0]?.created_at ?? null;
      _resolvedAtCache.set(convId, { resolvedAt_s, fetchedAt_s: now_s });
      return resolvedAt_s;
    } catch { return null; }
  };

  // Processa lote de convIds com concorrência limitada (evita burst na API).
  const _batchResolvedAt = async (convIds, token, concurrency = 5) => {
    const out = new Map();
    for (let i = 0; i < convIds.length; i += concurrency) {
      await Promise.all(convIds.slice(i, i + concurrency).map(async id => {
        out.set(id, await _getResolvedAt(id, token));
      }));
    }
    return out;
  };

  // Dispara verificação em background sem bloquear o endpoint.
  // Respeita fuso America/Sao_Paulo (sempre UTC-3 após abolição do horário de verão).
  const _triggerBacklogVerify = (candidates, token, todayStartS) => {
    if (_backlogVerifyBusy || candidates.length === 0) return;
    // Invalida resultado do dia anterior
    if (_backlogVerified && _backlogVerified.todayStartS !== todayStartS) _backlogVerified = null;
    _backlogVerifyBusy = true;
    _batchResolvedAt(candidates.map(c => c.id), token)
      .then(resolvedAtMap => {
        const verified = candidates.filter(c => {
          const rAt = resolvedAtMap.get(c.id);
          return rAt !== null && rAt >= todayStartS;
        });
        _backlogVerified = {
          tickets:      verified,
          count:        verified.length,
          todayStartS,
          verifiedAt_s: Date.now() / 1000,
        };
      })
      .catch(e => console.error('[ao-vivo] backlog verify error:', e.message))
      .finally(() => { _backlogVerifyBusy = false; });
  };

  function _brtDateStr(ts_s) {
    const d = new Date((ts_s * 1000) + (CFG.BRT_OFFSET_H * 3600000));
    return d.toISOString().slice(0, 10);
  }

  function _accumAdd(date, agente, label, secs) {
    if (!secs || secs < 5) return;
    const key = `${date}|${agente}`;
    if (!_statusAccum[key]) _statusAccum[key] = {};
    _statusAccum[key][label] = (_statusAccum[key][label] || 0) + Math.round(secs);
  }

  async function _persistAccum(date, agente) {
    if (!_dbReady) return;
    const key = `${date}|${agente}`;
    const data = _statusAccum[key];
    if (!data) return;
    try {
      await _dbPool.query(
        `INSERT INTO support_bi.agent_status_daily (date, agente, data)
         VALUES ($1, $2, $3)
         ON CONFLICT (date, agente) DO UPDATE
           SET data = support_bi.agent_status_daily.data || $3::jsonb`,
        [date, agente, JSON.stringify(Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, v])
        ))]
      );
    } catch (e) { console.error('[ao-vivo] accum persist error:', e.message); }
  }

  // Inicializa tabelas e carrega histórico persistido
  (async () => {
    try {
      _dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await _dbPool.query(`
        CREATE TABLE IF NOT EXISTS support_bi.ao_vivo_agent_status (
          agent      TEXT PRIMARY KEY,
          status     TEXT,
          reason     TEXT,
          since_s    BIGINT,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await _dbPool.query(`ALTER TABLE support_bi.ao_vivo_agent_status ADD COLUMN IF NOT EXISTS reason TEXT`);
      await _dbPool.query(`
        CREATE TABLE IF NOT EXISTS support_bi.agent_status_daily (
          date   DATE NOT NULL,
          agente TEXT NOT NULL,
          data   JSONB NOT NULL DEFAULT '{}',
          PRIMARY KEY (date, agente)
        )
      `);
      // Carrega status atual
      const { rows } = await _dbPool.query('SELECT agent, status, reason, since_s FROM support_bi.ao_vivo_agent_status');
      const initNow = Date.now() / 1000;
      const today = _brtDateStr(initNow);
      for (const row of rows) {
        const since_s = Number(row.since_s);
        // Se since_s é de um dia anterior, reseta para agora (evita curDate !== today no endpoint)
        const effectiveSince = _brtDateStr(since_s) < today ? initNow : since_s;
        _statusHistory[row.agent] = { status: row.status, reason: row.reason, since_s: effectiveSince };
        _prevConfirmed[row.agent] = { status: row.status, reason: row.reason, since_s: effectiveSince };
      }
      // Carrega acumulado de hoje
      const { rows: accRows } = await _dbPool.query(
        `SELECT agente, data FROM support_bi.agent_status_daily WHERE date = $1`, [today]
      );
      for (const row of accRows) {
        const key = `${today}|${row.agente}`;
        _statusAccum[key] = row.data || {};
      }
      _dbReady = true;
      console.log('[ao-vivo] DB carregado:', rows.length, 'status,', accRows.length, 'acumulados hoje');
    } catch (e) {
      console.error('[ao-vivo] DB init error:', e.message);
    }
  })();

  // ── Helpers internos ────────────────────────────────────────────────────────

  // Status dos agentes via /agents (availability_status: online/busy/offline).
  async function _fetchAgentStatus() {
    try {
      const r = await fetchCloudChat(
        `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/agents`,
        process.env.CLOUDCHAT_TOKEN
      );
      const agents = Array.isArray(r) ? r : (r?.data || []);
      const map = {};
      for (const a of agents) {
        if (!a.name) continue;
        map[a.name] = {
          status: a.availability_status || null,
          reason: a.availability_reason?.reason || null,
          emoji:  a.availability_reason?.emoji  || null,
        };
      }
      return map;
    } catch { return null; }
  }

  // IDs dos agentes Chatwoot (cache diário, para reports API).
  async function _getAgentIds(token) {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (_agentIds && _agentIdsDay === todayKey) return _agentIds;
    try {
      const r = await fetchCloudChat(`/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/agents`, token);
      const agents = Array.isArray(r) ? r : (r?.data || []);
      const map = {};
      for (const a of agents) { if (a.name && a.id) map[a.name] = a.id; }
      _agentIds = map;
      _agentIdsDay = todayKey;
      return map;
    } catch { return {}; }
  }

  // Tickets por status, paginado (open / pending / snoozed).
  async function _fetchAllByStatus(status, maxPages = 20) {
    const token = process.env.CLOUDCHAT_TOKEN;
    const all   = [];
    let page = 1, total = null, truncated = false;
    while (true) {
      const r = await fetchCloudChat(
        `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations?status=${status}&page=${page}`,
        token
      );
      const payload = r?.data?.payload || [];
      if (total === null) total = r?.data?.meta?.all_count ?? payload.length;
      all.push(...payload);
      if (all.length >= total || payload.length === 0) break;
      if (page >= maxPages) { truncated = true; break; }
      page++;
    }
    return { convs: all, truncated };
  }

  const _fetchAllOpen = () => _fetchAllByStatus('open');

  // Contagens N2 via filter API (uma chamada por métrica, paralelas).
  // Fonte: CloudChat filter API — tempo real (não usa DW).
  //
  // Métricas:
  //   open_count          — Em aberto agora (status=open, n2_ticket)
  //   pending_count       — Pendentes agora (status=pending, n2_ticket)
  //   snoozed_count       — Adiados agora   (status=snoozed, n2_ticket)
  //   novos_hoje          — Criados hoje, todos os status (created_at >= 00:00 BRT)
  //   resolv_criados_hoje — Criados hoje E atualmente resolved
  //   nao_atribuidos      — open N2 sem assignee (null) + lista de tickets
  async function _fetchN2Counts(todayStartISO) {
    const token = process.env.CLOUDCHAT_TOKEN;

    const postFilter = async (payload) => {
      try {
        const r = await fetchCloudChat(
          `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/filter?page=1`,
          token,
          'POST',
          { payload }
        );
        // Filter API retorna estrutura FLAT: { meta, payload } — não aninhado em data
        const meta = r?.meta || r?.data?.meta || {};
        const items = r?.payload || r?.data?.payload || [];
        return {
          count:   meta.all_count ?? 0,
          tickets: items,
        };
      } catch { return { count: 0, tickets: [] }; }
    };

    // Versão paginada: busca todas as páginas até esgotar (max maxPages páginas).
    const postFilterAll = async (payload, maxPages = 10) => {
      try {
        const all = [];
        let page = 1, total = null;
        while (true) {
          const r = await fetchCloudChat(
            `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/filter?page=${page}`,
            token, 'POST', { payload }
          );
          const meta  = r?.meta || r?.data?.meta || {};
          const items = r?.payload || r?.data?.payload || [];
          if (total === null) total = meta.all_count ?? items.length;
          all.push(...items);
          if (all.length >= total || items.length === 0 || page >= maxPages) break;
          page++;
        }
        return { count: total ?? all.length, tickets: all };
      } catch { return { count: 0, tickets: [] }; }
    };

    // Condição base: label n2_ticket (com AND para encadear)
    const N2A = { attribute_key: 'labels', filter_operator: 'equal_to', values: ['n2_ticket'], query_operator: 'AND' };
    // Status (último elemento → query_operator: null)
    const ST  = (s)  => ({ attribute_key: 'status',      filter_operator: 'equal_to',      values: [s],              query_operator: null });
    // Data de criação >= ISO (intermediário → AND)
    const CA  = (iso) => ({ attribute_key: 'created_at', filter_operator: 'is_greater_than', values: [iso],           query_operator: 'AND' });
    // Com assignee (intermediário → AND)
    const COM_AT = { attribute_key: 'assignee_id', filter_operator: 'is_present', values: [], query_operator: 'AND' };

    // Não atribuído: todas as conversas abertas sem assignee, sem filtro de label
    // (espelha o que CloudChat exibe na aba "Não atribuída")
    const NAL = { attribute_key: 'assignee_id', filter_operator: 'is_not_present', values: [], query_operator: 'AND' };
    const [open, pending, snoozed, novosRaw, resolvCriados, naoAtrib, resolvHoje, resolvRecentes] = await Promise.all([
      postFilter([N2A, ST('open')]),
      postFilter([N2A, ST('pending')]),
      postFilter([N2A, ST('snoozed')]),
      postFilterAll([CA(todayStartISO), { ...COM_AT, query_operator: null }]),  // todos tickets (paginado p/ filtrar por agente)
      postFilter([N2A, { ...CA(todayStartISO), query_operator: 'AND' }, ST('resolved')]),
      postFilterAll([{ ...NAL }, ST('open')]),  // sem n2_ticket — espelha CloudChat; paginado p/ total exato
      postFilterAll([CA(todayStartISO), COM_AT, ST('resolved')]),  // resolvidos criados hoje (com assignee, qualquer label)
      postFilterAll([COM_AT, ST('resolved')], 8),  // resolvidos recentes (8 páginas = 200 mais recentes, sem filtro de label)
    ]);

    // Conta apenas tickets criados hoje atribuídos às agentes monitoradas (exclui N1/Claudia etc.)
    const novosHoje      = novosRaw.tickets.filter(c => CFG.AGENTES.includes(c.meta?.assignee?.name)).length;
    const mt = c => ({ id: c.id, link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${c.id}` });
    const todayStartS = Math.floor(new Date(todayStartISO).getTime() / 1000);
    // Conta exata de resoluções via reports API v2 (sem dependência de last_activity_at)
    let resolv_v2_total = null;
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const rv2 = await fetchCloudChat(
        `/api/v2/accounts/${CLOUDCHAT_ACCOUNT}/reports?metric=resolutions_count&type=account&since=${todayStartS}&until=${nowS}`,
        token
      );
      if (Array.isArray(rv2) && rv2[0]?.value !== undefined) resolv_v2_total = rv2[0].value;
    } catch { /* silencioso */ }
    // Criados hoje E resolvidos pelas monitoradas (tickets para exibir na lista)
    const fechadosHojeTickets = resolvHoje.tickets.filter(c => CFG.AGENTES.includes(c.meta?.assignee?.name));
    // Total resolvidos hoje = criados hoje resolvidos + antigos resolvidos hoje (1 pág = 25 tickets mais recentes)
    // Usa last_activity_at como proxy de resolved_at (CloudChat não expõe resolved_at na filter API)
    const totalResolvidosMap = new Map();
    for (const c of fechadosHojeTickets) totalResolvidosMap.set(c.id, c);
    for (const c of resolvRecentes.tickets) {
      if (CFG.AGENTES.includes(c.meta?.assignee?.name) && (c.last_activity_at || 0) >= todayStartS) {
        totalResolvidosMap.set(c.id, c);
      }
    }
    const totalResolvidosHoje = totalResolvidosMap.size;

    // Verificação via activity messages (paralela, fire-and-forget)
    // Candidatos de backlog: resolvidos recentes, monitoradas, atividade hoje, não criados hoje
    const backlogCandidates = resolvRecentes.tickets.filter(c =>
      CFG.AGENTES.includes(c.meta?.assignee?.name) &&
      (c.last_activity_at || 0) >= todayStartS &&
      (c.created_at || 0) < todayStartS &&   // excluir criados hoje (já no card N2)
      !fechadosHojeTickets.find(f => f.id === c.id)
    );
    _triggerBacklogVerify(backlogCandidates, token, todayStartS);

    // Snapshot do resultado verificado (pode ser null ou do poll anterior)
    const bv = _backlogVerified;
    const backlogVerificadoTickets = (bv && bv.todayStartS === todayStartS)
      ? bv.tickets.map(c => ({
          id:           c.id,
          link:         `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${c.id}`,
          agent:        c.meta?.assignee?.name || '',
          resolved_at_s: _resolvedAtCache.get(c.id)?.resolvedAt_s ?? null,
        }))
      : null; // null = ainda verificando

    return {
      open_count:          open.count,
      pending_count:       pending.count,
      snoozed_count:       snoozed.count,
      novos_hoje:          novosHoje,
      resolv_criados_hoje:         resolvCriados.count,
      resolv_criados_hoje_tickets: resolvCriados.tickets.map(mt),
      resolv_fechados_hoje:         fechadosHojeTickets.length,
      resolv_fechados_hoje_precisos: fechadosHojeTickets.map(c => ({
        id:    c.id,
        link:  `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${c.id}`,
        agent: c.meta?.assignee?.name || '',
        created_today: true,
      })),
      resolv_v2_total:                  resolv_v2_total,
      resolv_total_hoje:                totalResolvidosHoje,
      resolv_backlog_verificado:        backlogVerificadoTickets,
      resolv_backlog_verificado_count:  backlogVerificadoTickets?.length ?? null,
      resolv_backlog_candidatos:        backlogCandidates.length,
      resolv_fechados_hoje_tickets: [...totalResolvidosMap.values()].map(c => ({
        id:    c.id,
        link:  `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${c.id}`,
        agent: c.meta?.assignee?.name || '',
        created_today: (c.created_at || 0) >= todayStartS,
      })),
      resolv_hoje_tickets:     resolvHoje.tickets,
      resolv_recentes_tickets: resolvRecentes.tickets,
      nao_atribuidos: (() => {
        const off = CFG.BRT_OFFSET_H * 3600000;
        const todayBRT = new Date(Date.now() + off);
        todayBRT.setUTCHours(0, 0, 0, 0);
        const todayS     = (todayBRT.getTime() - off) / 1000;
        const yesterdayS = todayS - 86400;
        const mt = c => ({ id: c.id, link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${c.id}` });
        const hoje      = naoAtrib.tickets.filter(c => c.created_at >= todayS).map(mt);
        const ontem     = naoAtrib.tickets.filter(c => c.created_at >= yesterdayS && c.created_at < todayS).map(mt);
        const anteriores= naoAtrib.tickets.filter(c => c.created_at < yesterdayS).map(mt);
        const oldestTicket = naoAtrib.tickets.length > 0
          ? naoAtrib.tickets.reduce((a, b) => a.created_at <= b.created_at ? a : b)
          : null;
        return {
          total:              naoAtrib.count,
          tickets:            naoAtrib.tickets.map(mt),
          por_dia:            { hoje, ontem, anteriores },
          oldest_created_at:  oldestTicket?.created_at ?? null,
          oldest_ticket:      oldestTicket ? mt(oldestTicket) : null,
        };
      })(),
    };
  }


  // ── Rota principal ──────────────────────────────────────────────────────────

  router.get('/ao-vivo/status', async (req, res) => {
    const nowS = Date.now() / 1000;
    if (_cache && (nowS - _cacheTs) < CFG.POLL_TTL_S) return res.json(_cache);

    try {
      // Início do dia em BRT como ISO UTC (para filtro de criação no filter API)
      const _off = CFG.BRT_OFFSET_H * 3600000;
      const _d   = new Date(Date.now() + _off);
      _d.setUTCHours(0, 0, 0, 0);
      const todayStartISO = new Date(_d.getTime() - _off).toISOString(); // 00:00 BRT → UTC ISO
      const todayStartS   = (_d.getTime() - _off) / 1000;

      const [agentStatus, { convs: allOpenConvs, truncated }, { convs: allPendingConvs }, { convs: allSnoozedConvs }, n2Counts] = await Promise.all([
        _fetchAgentStatus(),
        _fetchAllByStatus('open'),
        _fetchAllByStatus('pending', 5),
        _fetchAllByStatus('snoozed', 5),
        _fetchN2Counts(todayStartISO),
      ]);
      const now_s = Math.floor(Date.now() / 1000);

      // "Na caixa": qualquer ticket aberto COM atendente monitorada como responsável
      // Sem filtro de label → espelha o número que a atendente vê no CloudChat
      const openConvs = allOpenConvs.filter(c =>
        CFG.AGENTES.includes(c.meta?.assignee?.name)
      );

      // Subconjunto N2 com atendente — usado apenas para SLA (que é N2-específico)
      const openN2Convs = allOpenConvs.filter(c =>
        c.labels?.includes('n2_ticket') && CFG.AGENTES.includes(c.meta?.assignee?.name)
      );

      // Atualiza histórico de status com debounce de 1 poll:
      // Se A → B → A em ciclos consecutivos (API pisca), restaura o since_s original do A.
      // Só persiste a mudança se o novo status aparecer por ≥2 polls seguidos.
      const _changedAgents = [];
      for (const ag of CFG.AGENTES) {
        const newSt     = agentStatus?.[ag]?.status || null;
        const newReason = agentStatus?.[ag]?.reason || null;
        const prev      = _statusHistory[ag];

        if (!prev) {
          _statusHistory[ag] = { status: newSt, reason: newReason, since_s: now_s };
          _prevConfirmed[ag]  = null;
          _changedAgents.push(ag);
          continue;
        }

        const sameState = newSt === prev.status && newReason === prev.reason;
        if (sameState) {
          _prevConfirmed[ag] = prev;
        } else {
          const wasConfirmed = _prevConfirmed[ag];
          if (wasConfirmed && wasConfirmed.status === newSt && wasConfirmed.reason === newReason) {
            // Piscou — restaura estado confirmado
            _statusHistory[ag] = wasConfirmed;
            _prevConfirmed[ag]  = null;
            _changedAgents.push(ag);
          } else {
            // Mudança genuína — acumula duração do estado anterior
            if (prev.since_s) {
              const label = prev.reason || prev.status || 'Desconhecido';
              const date  = _brtDateStr(prev.since_s);
              _accumAdd(date, ag, label, now_s - prev.since_s);
              _persistAccum(date, ag);
            }
            _prevConfirmed[ag]  = prev;
            _statusHistory[ag] = { status: newSt, reason: newReason, since_s: now_s };
            _changedAgents.push(ag);
          }
        }
      }
      // Persiste estado atual no PostgreSQL (fire-and-forget)
      if (_dbReady && _changedAgents.length > 0) {
        Promise.all(_changedAgents.map(ag => {
          const h = _statusHistory[ag];
          return _dbPool.query(
            `INSERT INTO support_bi.ao_vivo_agent_status (agent, status, reason, since_s, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (agent) DO UPDATE
               SET status = EXCLUDED.status, reason = EXCLUDED.reason, since_s = EXCLUDED.since_s, updated_at = NOW()`,
            [ag, h.status, h.reason, h.since_s]
          );
        })).catch(e => console.error('[ao-vivo] DB upsert error:', e.message));
      }

      // Tabela por atendente: Na caixa (count + tickets) + status online
      const porAgente = {};
      for (const ag of CFG.AGENTES) {
        const st = agentStatus?.[ag] || null;
        porAgente[ag] = { na_caixa: 0, pendentes: 0, tickets_pendentes: [], adiados: 0, tickets_adiados: [], sem_resp: 0, max_espera_min: null, status: st?.status || null, reason: st?.reason || null, emoji: st?.emoji || null, since_s: _statusHistory[ag]?.since_s || null, tickets: [], ativos_hoje: 0, tickets_tocados_hoje: [], ultima_ativ_s: null };
      }
      for (const conv of openConvs) {
        const key = CFG.AGENTES.find(x => x === conv.meta?.assignee?.name);
        if (!key) continue;
        porAgente[key].na_caixa++;
        porAgente[key].tickets.push({
          id:   conv.id,
          link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${conv.id}`,
        });
        // 1ª resposta: acumula tickets sem reply e o maior tempo de espera (h. comercial)
        if (!conv.first_reply_created_at) {
          const mins = _bhMins(conv.created_at, now_s);
          porAgente[key].sem_resp++;
          if (mins > (porAgente[key].max_espera_min || 0)) porAgente[key].max_espera_min = Math.round(mins);
        }
      }

      // Pendentes e adiados por atendente
      for (const conv of allPendingConvs) {
        const key = CFG.AGENTES.find(x => x === conv.meta?.assignee?.name);
        if (key) {
          porAgente[key].pendentes++;
          porAgente[key].tickets_pendentes.push({ id: conv.id, link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${conv.id}` });
        }
      }
      for (const conv of allSnoozedConvs) {
        const key = CFG.AGENTES.find(x => x === conv.meta?.assignee?.name);
        if (key) {
          porAgente[key].adiados++;
          porAgente[key].tickets_adiados.push({ id: conv.id, link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${conv.id}` });
        }
      }

      // Tempo médio de 1ª resposta hoje por agente
      // Fontes: open/pending/snoozed (qualquer data) + resolvidos criados hoje + resolvidos recentes (5 páginas)
      // Filtra localmente por first_reply_created_at >= hoje, independente de when foi criado o ticket
      const allConvsForResp = [
        ...allOpenConvs,
        ...allPendingConvs,
        ...allSnoozedConvs,
        ...(n2Counts.resolv_hoje_tickets    || []),
        ...(n2Counts.resolv_recentes_tickets || []),
      ];
      const seenForResp = new Set();
      for (const conv of allConvsForResp) {
        const ag = CFG.AGENTES.find(x => x === conv.meta?.assignee?.name);
        if (!ag || seenForResp.has(conv.id)) continue;
        seenForResp.add(conv.id);
        const firstReply = conv.first_reply_created_at;
        if (firstReply >= todayStartS) {
          // 1ª resposta dada hoje → entra na média
          const bhMins = _bhMins(conv.created_at, firstReply);
          if (bhMins >= 1) { // ignora auto-respostas
            if (!porAgente[ag]._resp_samples) porAgente[ag]._resp_samples = [];
            porAgente[ag]._resp_samples.push(bhMins);
          }
        } else if (firstReply && firstReply < todayStartS) {
          // Ticket antigo já respondido (antes de hoje) — está na fila hoje mas não conta na média
          porAgente[ag]._antigos = (porAgente[ag]._antigos || 0) + 1;
        }
        // Tocados hoje: ticket respondido em algum momento + atividade hoje → verifica msgs reais
        const lastAct = conv.last_activity_at;
        if (firstReply && lastAct && lastAct >= todayStartS) {
          if (!porAgente[ag]._followUpCandidates) porAgente[ag]._followUpCandidates = [];
          porAgente[ag]._followUpCandidates.push({ id: conv.id, lastAct });
        }
      }
      // Busca msgs para candidatos a follow-up (em paralelo, com cache por lastAct)
      const token = process.env.CLOUDCHAT_TOKEN;
      const followUpTasks = [];
      for (const ag of CFG.AGENTES) {
        for (const cand of (porAgente[ag]._followUpCandidates || [])) {
          const cached = _convMsgCache.get(cand.id);
          if (cached && cached.lastAct === cand.lastAct) {
            // cache hit — aplica direto
            const ts = cached.agentMsgsToday.get(ag);
            if (ts) {
              porAgente[ag].ativos_hoje++;
              porAgente[ag].tickets_tocados_hoje.push({ id: cand.id, link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${cand.id}` });
              if (!porAgente[ag].ultima_ativ_s || ts > porAgente[ag].ultima_ativ_s)
                porAgente[ag].ultima_ativ_s = ts;
            }
          } else {
            followUpTasks.push({ ag, convId: cand.id, lastAct: cand.lastAct });
          }
        }
        delete porAgente[ag]._followUpCandidates;
      }
      if (followUpTasks.length > 0) {
        const uniqueConvIds = [...new Set(followUpTasks.map(t => t.convId))];
        const msgResults = await Promise.all(uniqueConvIds.map(async (convId) => {
          try {
            const r = await fetchCloudChat(
              `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${convId}/messages`,
              token
            );
            const msgs = r?.payload || r?.data?.payload || [];
            const agentMsgsToday = new Map();
            for (const m of msgs) {
              if (m.message_type === 1 && m.created_at >= todayStartS) {
                const name = m.sender?.name || m.author?.name || '';
                if (!agentMsgsToday.has(name) || m.created_at > agentMsgsToday.get(name))
                  agentMsgsToday.set(name, m.created_at);
              }
            }
            const task = followUpTasks.find(t => t.convId === convId);
            _convMsgCache.set(convId, { lastAct: task?.lastAct, agentMsgsToday });
            return { convId, agentMsgsToday };
          } catch { return { convId, agentMsgsToday: new Map() }; }
        }));
        const msgsMap = new Map(msgResults.map(r => [r.convId, r.agentMsgsToday]));
        for (const { ag, convId, lastAct } of followUpTasks) {
          const agentMsgsToday = msgsMap.get(convId);
          const ts = agentMsgsToday?.get(ag);
          if (ts) {
            porAgente[ag].ativos_hoje++;
            porAgente[ag].tickets_tocados_hoje.push({ id: convId, link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${convId}` });
            if (!porAgente[ag].ultima_ativ_s || ts > porAgente[ag].ultima_ativ_s)
              porAgente[ag].ultima_ativ_s = ts;
          }
        }
      }

      for (const ag of CFG.AGENTES) {
        const samples = porAgente[ag]._resp_samples;
        porAgente[ag].avg_resp_min = samples?.length
          ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
          : null;
        porAgente[ag].antigos_atendidos = porAgente[ag]._antigos || 0;
        delete porAgente[ag]._resp_samples;
        delete porAgente[ag]._antigos;
      }

      // SLA em risco: tickets open N2 com atendente, sem 1ª resposta, dentro do h. comercial
      const slaRisco = [];
      for (const conv of openN2Convs) {
        if (conv.first_reply_created_at) continue;
        const mins = _bhMins(conv.created_at, now_s);
        if (mins < CFG.SLA_ATENCAO_MIN) continue;
        const atendente = conv.meta?.assignee?.name || '';
        slaRisco.push({
          id:        conv.id,
          atendente: CFG.DISPLAY[atendente] || atendente || '(sem)',
          minutos:   Math.round(mins),
          nivel:     mins >= CFG.SLA_CRITICO_MIN ? 'critico' : 'atencao',
          link:      `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${conv.id}`,
        });
      }
      slaRisco.sort((a, b) => b.minutos - a.minutos);

      const result = {
        ao_vivo: {
          updated_at:   new Date().toISOString(),
          has_overview: !!agentStatus,
          truncated,

          // Métricas HOJE — 100% CloudChat ao vivo (25s cache)
          hoje: {
            novos:                        n2Counts.novos_hoje,
            resolv_criados_hoje:          n2Counts.resolv_criados_hoje,
            resolv_criados_hoje_tickets:  n2Counts.resolv_criados_hoje_tickets,
            resolv_fechados_hoje:          n2Counts.resolv_fechados_hoje,
            resolv_fechados_hoje_precisos: n2Counts.resolv_fechados_hoje_precisos,
            resolv_v2_total:                  n2Counts.resolv_v2_total,
            resolv_total_hoje:                n2Counts.resolv_total_hoje,
            resolv_fechados_hoje_tickets:     n2Counts.resolv_fechados_hoje_tickets,
            resolv_backlog_verificado:        n2Counts.resolv_backlog_verificado,
            resolv_backlog_verificado_count:  n2Counts.resolv_backlog_verificado_count,
            resolv_backlog_candidatos:        n2Counts.resolv_backlog_candidatos,
          },

          // Métricas AGORA (fotografia do estoque atual)
          // Usa soma de porAgente para bater com os valores da tabela (sem filtro N2)
          agora: {
            open:           CFG.AGENTES.reduce((s, ag) => s + (porAgente[ag]?.na_caixa    || 0), 0),
            pending:        CFG.AGENTES.reduce((s, ag) => s + (porAgente[ag]?.pendentes   || 0), 0),
            snoozed:        CFG.AGENTES.reduce((s, ag) => s + (porAgente[ag]?.adiados     || 0), 0),
            nao_atribuidos: n2Counts.nao_atribuidos,
          },

          por_agente: porAgente,
          sla_risco:  slaRisco,
        },
      };
      _cache   = result;
      _cacheTs = nowS;
      res.json(result);
    } catch (e) {
      console.error('[ao-vivo]', e.message);
      if (_cache) return res.json({ ..._cache, _stale: true });
      res.status(500).json({ error: e.message });
    }
  });

  // Comparação backlog: lista antiga vs verificada via activity messages
  router.get('/debug-backlog', async (req, res) => {
    const cache = _cache?.ao_vivo?.hoje;
    if (!cache) return res.json({ erro: 'Cache ainda não pronto — abre o painel ao-vivo primeiro.' });

    const bv = _backlogVerified;
    if (!bv) return res.json({ status: 'verificando', message: 'Aguarde ~1 min e tente novamente.' });

    const token = process.env.CLOUDCHAT_TOKEN;

    // Listas base
    const antigas  = (cache.resolv_fechados_hoje_tickets || []).filter(t => !t.created_today);
    const verifs   = bv.tickets;
    const antigasIds = new Set(antigas.map(t => t.id));
    const verifsIds  = new Set(verifs.map(t => t.id));

    const emAmbas      = antigas.filter(t => verifsIds.has(t.id));
    const soAntigas    = antigas.filter(t => !verifsIds.has(t.id));  // falsos positivos
    const soVerificada = verifs.filter(t => !antigasIds.has(t.id));  // novos encontrados

    // Para falsos positivos: busca última activity de resolução e última activity geral
    const detalhes = await Promise.all(soAntigas.map(async t => {
      try {
        const r    = await fetchCloudChat(`/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${t.id}/messages`, token);
        const msgs = r?.payload || r?.data?.payload || [];
        const acts = msgs.filter(m => m.message_type === 2).sort((a, b) => b.created_at - a.created_at);
        const resAct  = acts.find(m => /resolvid/i.test(m.content || ''));
        const lastAct = acts[0];
        return {
          id:             t.id,
          agent:          t.agent,
          link:           t.link,
          resolvido_em:   resAct ? new Date(resAct.created_at * 1000).toISOString() : 'não encontrado',
          ult_atividade:  lastAct ? lastAct.content?.slice(0, 80) : '—',
          ult_ativ_em:    lastAct ? new Date(lastAct.created_at * 1000).toISOString() : '—',
        };
      } catch (e) { return { id: t.id, erro: e.message }; }
    }));

    res.json({
      resumo: {
        antigos_total:         antigas.length,
        verificados_total:     verifs.length,
        em_ambas:              emAmbas.length,
        so_na_antiga:          soAntigas.length,
        so_na_verificada:      soVerificada.length,
        v2_total_conta:        cache.resolv_v2_total,
        verificado_ok:         verifs.length <= (cache.resolv_v2_total ?? Infinity),
      },
      falsos_positivos: detalhes,
      so_na_verificada: soVerificada.map(t => ({ id: t.id, agent: t.agent, link: t.link, resolved_at_s: t.resolved_at_s })),
    });
  });

  // Debug endpoint — testa 3 perguntas sobre a API do CloudChat
  router.get('/debug-ct', async (req, res) => {
    const token = process.env.CLOUDCHAT_TOKEN;
    const result = {};

    try {
      // Busca algumas conversas resolvidas para usar nos testes
      const r = await fetchCloudChat(
        `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/filter?page=1`,
        token, 'POST',
        { payload: [{ attribute_key: 'assignee_id', filter_operator: 'is_present', values: [], query_operator: 'AND' }, { attribute_key: 'status', filter_operator: 'equal_to', values: ['resolved'], query_operator: null }] }
      );
      const convs = (r?.payload || r?.data?.payload || []).slice(0, 3);

      // TESTE 1: mensagens de activity (message_type=2) com resolução/atribuição
      result.teste1_activity_messages = [];
      for (const conv of convs) {
        try {
          const msgs = await fetchCloudChat(`/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${conv.id}/messages`, token);
          const activities = (msgs?.payload || []).filter(m => m.message_type === 2);
          result.teste1_activity_messages.push({
            conv_id: conv.id,
            total_activities: activities.length,
            exemplos: activities.slice(0, 5).map(m => ({
              id: m.id,
              content: m.content,
              created_at: m.created_at,
              created_at_iso: new Date(m.created_at * 1000).toISOString(),
            })),
          });
        } catch (e) { result.teste1_activity_messages.push({ conv_id: conv.id, erro: e.message }); }
      }

      // TESTE 2: campos first_reply_created_at e waiting_since nas conversas
      result.teste2_campos_conversa = convs.map(c => ({
        conv_id: c.id,
        first_reply_created_at: c.first_reply_created_at ?? 'AUSENTE',
        waiting_since: c.waiting_since ?? 'AUSENTE',
        todos_campos: Object.keys(c),
      }));

      // TESTE 3: v2 reports com type=agent
      try {
        const agentsR = await fetchCloudChat(`/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/agents`, token);
        const agents = Array.isArray(agentsR) ? agentsR : (agentsR?.data || []);
        const primeiro = agents[0];
        const nowS = Math.floor(Date.now() / 1000);
        const todayS = nowS - (nowS % 86400);
        const v2Agent = await fetchCloudChat(
          `/api/v2/accounts/${CLOUDCHAT_ACCOUNT}/reports?metric=avg_first_response_time&type=agent&id=${primeiro?.id}&since=${todayS}&until=${nowS}`,
          token
        );
        result.teste3_v2_por_agente = { agente: primeiro?.name, id: primeiro?.id, resposta: v2Agent };
      } catch (e) { result.teste3_v2_por_agente = { erro: e.message }; }

    } catch (e) { result.erro_geral = e.message; }

    res.json(result);
  });

  // Disponibilidade por agente: hoje ou range
  router.get('/ao-vivo/disponibilidade', async (req, res) => {
    if (!_dbReady) return res.status(503).json({ error: 'DB não pronto' });
    try {
      const now_s  = Date.now() / 1000;
      const today  = _brtDateStr(now_s);
      const from   = req.query.from || today;
      const to     = req.query.to   || today;

      // Busca dados persistidos do período
      const { rows } = await _dbPool.query(
        `SELECT date::text AS date, agente, data FROM support_bi.agent_status_daily
         WHERE date >= $1 AND date <= $2 ORDER BY date, agente`,
        [from, to]
      );

      // Mescla com acumulado em memória de hoje (pode ter dados mais recentes)
      const result = {};
      for (const row of rows) {
        if (!result[row.agente]) result[row.agente] = {};
        for (const [label, secs] of Object.entries(row.data || {})) {
          result[row.agente][label] = (result[row.agente][label] || 0) + Number(secs);
        }
      }
      // Acumulado in-memory de hoje (dias dentro do range)
      if (from <= today && today <= to) {
        for (const ag of CFG.AGENTES) {
          const key  = `${today}|${ag}`;
          const mem  = _statusAccum[key] || {};
          if (!result[ag]) result[ag] = {};
          for (const [label, secs] of Object.entries(mem)) {
            result[ag][label] = (result[ag][label] || 0) + Number(secs);
          }
          // Adiciona tempo no status atual (ainda não houve mudança)
          const cur = _statusHistory[ag];
          if (cur && cur.since_s) {
            const curDate = _brtDateStr(cur.since_s);
            if (curDate === today) {
              const label = cur.reason || cur.status || 'Desconhecido';
              result[ag][label] = (result[ag][label] || 0) + Math.round(now_s - cur.since_s);
            }
          }
        }
      }

      res.json({ from, to, por_agente: result });
    } catch (e) {
      console.error('[ao-vivo] disponibilidade error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
