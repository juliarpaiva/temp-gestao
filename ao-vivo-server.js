'use strict';
const express = require('express');

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
    const [open, pending, snoozed, novos, resolvCriados, naoAtrib] = await Promise.all([
      postFilter([N2A, ST('open')]),
      postFilter([N2A, ST('pending')]),
      postFilter([N2A, ST('snoozed')]),
      postFilter([CA(todayStartISO), { ...COM_AT, query_operator: null }]),  // todos tickets, não só N2
      postFilter([N2A, { ...CA(todayStartISO), query_operator: 'AND' }, ST('resolved')]),
      postFilterAll([{ ...NAL }, ST('open')]),  // sem n2_ticket — espelha CloudChat; paginado p/ total exato
    ]);

    return {
      open_count:          open.count,
      pending_count:       pending.count,
      snoozed_count:       snoozed.count,
      novos_hoje:          novos.count,
      resolv_criados_hoje: resolvCriados.count,
      nao_atribuidos: {
        total:   naoAtrib.count,
        tickets: naoAtrib.tickets.map(c => ({
          id:   c.id,
          link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${c.id}`,
        })),
      },
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

      // Tabela por atendente: Na caixa (count + tickets) + status online
      const porAgente = {};
      for (const ag of CFG.AGENTES) {
        const st = agentStatus?.[ag] || null;
        porAgente[ag] = { na_caixa: 0, pendentes: 0, tickets_pendentes: [], adiados: 0, tickets_adiados: [], sem_resp: 0, max_espera_min: null, status: st?.status || null, reason: st?.reason || null, emoji: st?.emoji || null, tickets: [] };
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
            novos:               n2Counts.novos_hoje,           // CloudChat filter API
            resolv_criados_hoje: n2Counts.resolv_criados_hoje,  // CloudChat filter API
          },

          // Métricas AGORA (fotografia do estoque atual)
          agora: {
            // Em aberto: soma dos tickets abertos atribuídos às atendentes monitoradas
            // (sem filtro de label — mesma base da tabela, para bater com a planilha)
            open:           openConvs.length,
            pending:        n2Counts.pending_count,  // Pendentes agora
            snoozed:        n2Counts.snoozed_count,  // Adiados agora
            nao_atribuidos: n2Counts.nao_atribuidos, // open N2 sem assignee
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
