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
  const _statusHistory  = {};
  const _convMsgCache   = new Map(); // conv_id → { lastAct, agentMsgsToday: Map<name,ts> } // { agentName: { status, since_s } } — persiste no PostgreSQL entre reinicios
  const _prevConfirmed  = {}; // { agentName: { status, since_s } } — estado confirmado antes da última transição (rollback)
  let _dbPool  = null;
  let _dbReady = false;

  // Inicializa tabela e carrega histórico persistido
  (async () => {
    try {
      _dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await _dbPool.query(`
        CREATE TABLE IF NOT EXISTS support_bi.ao_vivo_agent_status (
          agent      TEXT PRIMARY KEY,
          status     TEXT,
          since_s    BIGINT,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      const { rows } = await _dbPool.query(
        'SELECT agent, status, since_s FROM support_bi.ao_vivo_agent_status'
      );
      for (const row of rows) {
        _statusHistory[row.agent] = { status: row.status, since_s: Number(row.since_s) };
        _prevConfirmed[row.agent] = { status: row.status, since_s: Number(row.since_s) }; // carregado do DB = já confirmado
      }
      _dbReady = true;
      console.log('[ao-vivo] status history carregado do DB:', rows.length, 'agentes');
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

    // Versão paginada: busca todas as páginas até esgotar (max 10 páginas).
    const postFilterAll = async (payload) => {
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
          if (all.length >= total || items.length === 0 || page >= 10) break;
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
      postFilterAll([CA(todayStartISO), { ...COM_AT, query_operator: 'AND' }, ST('resolved')]),  // resolvidos criados hoje (com assignee)
      postFilterAll([COM_AT, ST('resolved')], 5),  // resolvidos recentes (5 páginas) — captura 1ª resp dada hoje em tickets antigos
    ]);

    // Conta apenas tickets criados hoje atribuídos às agentes monitoradas (exclui N1/Claudia etc.)
    const novosHoje      = novosRaw.tickets.filter(c => CFG.AGENTES.includes(c.meta?.assignee?.name)).length;
    const mt = c => ({ id: c.id, link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${c.id}` });
    const todayStartS = Math.floor(new Date(todayStartISO).getTime() / 1000);
    // Fechados hoje = resolvidos recentes com last_activity_at >= hoje + criados hoje já resolvidos
    // Combina as duas fontes e deduplica por id
    const fechadosHojeMap = new Map();
    for (const c of [...resolvRecentes.tickets, ...resolvHoje.tickets]) {
      if (CFG.AGENTES.includes(c.meta?.assignee?.name) && (c.last_activity_at || 0) >= todayStartS) {
        fechadosHojeMap.set(c.id, c);
      }
    }
    const fechadosHojeTickets = [...fechadosHojeMap.values()];

    return {
      open_count:          open.count,
      pending_count:       pending.count,
      snoozed_count:       snoozed.count,
      novos_hoje:          novosHoje,
      resolv_criados_hoje:         resolvCriados.count,
      resolv_criados_hoje_tickets: resolvCriados.tickets.map(mt),
      resolv_fechados_hoje:         fechadosHojeTickets.length,
      resolv_fechados_hoje_tickets: fechadosHojeTickets.map(mt),
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
        const newSt = agentStatus?.[ag]?.status || null;
        const prev  = _statusHistory[ag];

        if (!prev) {
          // Primeira vez — inicializa
          _statusHistory[ag] = { status: newSt, since_s: now_s };
          _prevConfirmed[ag]  = null;
          _changedAgents.push(ag);
          continue;
        }

        if (newSt === prev.status) {
          // Estável — salva como confirmado
          _prevConfirmed[ag] = prev;
        } else {
          const wasConfirmed = _prevConfirmed[ag];
          if (wasConfirmed && wasConfirmed.status === newSt) {
            // Voltou ao status anterior em 1 poll (piscou) — restaura since_s original
            _statusHistory[ag] = wasConfirmed;
            _prevConfirmed[ag]  = null;
            _changedAgents.push(ag);
          } else {
            // Mudança genuína (persiste por ≥2 polls) — confirma
            _prevConfirmed[ag]  = prev;
            _statusHistory[ag] = { status: newSt, since_s: now_s };
            _changedAgents.push(ag);
          }
        }
      }
      // Persiste mudanças no PostgreSQL (fire-and-forget)
      if (_dbReady && _changedAgents.length > 0) {
        Promise.all(_changedAgents.map(ag => {
          const h = _statusHistory[ag];
          return _dbPool.query(
            `INSERT INTO support_bi.ao_vivo_agent_status (agent, status, since_s, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (agent) DO UPDATE
               SET status = EXCLUDED.status, since_s = EXCLUDED.since_s, updated_at = NOW()`,
            [ag, h.status, h.since_s]
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
            resolv_fechados_hoje:         n2Counts.resolv_fechados_hoje,
            resolv_fechados_hoje_tickets: n2Counts.resolv_fechados_hoje_tickets,
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

  return router;
};
