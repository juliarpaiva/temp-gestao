'use strict';
const express = require('express');

// ── Config — ajuste aqui ──────────────────────────────────────────────────────
const CFG = {
  POLL_TTL_S:      25,           // cache server-side (segundos)
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

  // Overview de agentes (status online/ausente). Retorna null se endpoint inexistente.
  async function _fetchOverview() {
    try {
      return await fetchCloudChat(
        `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/reports/overview`,
        process.env.CLOUDCHAT_TOKEN
      );
    } catch { return null; }
  }

  // Todos os tickets status=open, paginado — para tabela por atendente e SLA.
  async function _fetchAllOpen() {
    const token = process.env.CLOUDCHAT_TOKEN;
    const all   = [];
    let page = 1, total = null, truncated = false;
    while (true) {
      const r = await fetchCloudChat(
        `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations?status=open&page=${page}`,
        token
      );
      const payload = r?.data?.payload || [];
      if (total === null) total = r?.data?.meta?.all_count ?? payload.length;
      all.push(...payload);
      if (all.length >= total || payload.length === 0) break;
      if (page >= 20) { truncated = true; break; }
      page++;
    }
    return { convs: all, truncated };
  }

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

    // Condição base: label n2_ticket (com AND para encadear)
    const N2A = { attribute_key: 'labels', filter_operator: 'equal_to', values: ['n2_ticket'], query_operator: 'AND' };
    // Status (último elemento → query_operator: null)
    const ST  = (s)  => ({ attribute_key: 'status',      filter_operator: 'equal_to',      values: [s],              query_operator: null });
    // Data de criação >= ISO (intermediário → AND)
    const CA  = (iso) => ({ attribute_key: 'created_at', filter_operator: 'is_greater_than', values: [iso],           query_operator: 'AND' });
    // Sem assignee (intermediário → AND)
    const NA  = { attribute_key: 'assignee_id', filter_operator: 'is_not_present', values: [], query_operator: 'AND' };

    // Não atribuído: todas as conversas abertas sem assignee, sem filtro de label
    // (espelha o que CloudChat exibe na aba "Não atribuída")
    const NAL = { attribute_key: 'assignee_id', filter_operator: 'is_not_present', values: [], query_operator: 'AND' };
    const [open, pending, snoozed, novos, resolvCriados, naoAtrib] = await Promise.all([
      postFilter([N2A, ST('open')]),
      postFilter([N2A, ST('pending')]),
      postFilter([N2A, ST('snoozed')]),
      postFilter([{ ...N2A, query_operator: 'AND' }, { ...CA(todayStartISO), query_operator: null }]),
      postFilter([N2A, { ...CA(todayStartISO), query_operator: 'AND' }, ST('resolved')]),
      postFilter([{ ...NAL }, ST('open')]),  // sem n2_ticket — espelha CloudChat
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

  // Resolvidos hoje via DW (único ponto onde DW ainda é necessário).
  // Motivo: CloudChat API não tem filtro por resolved_at; DW tem latência de ~30min.
  // Fonte: dw.fact_cloudchat_tickets — campo resolved_at_local (BRT).
  async function _fetchDwResolvidos() {
    try {
      const off    = CFG.BRT_OFFSET_H * 3600000;
      const nowBRT = new Date(Date.now() + off);
      const hoje   = nowBRT.toISOString().slice(0, 10);
      const amanha = new Date(nowBRT.getTime() + 86400000).toISOString().slice(0, 10);
      const [rows, fresh] = await Promise.all([
        dwQuery(`
          SELECT COUNT(*)::int
          FROM dw.fact_cloudchat_tickets
          WHERE ticket_status = 'resolved'
            AND resolved_at_local >= '${hoje}'
            AND resolved_at_local <  '${amanha}'
        `),
        dwQuery(`
          SELECT MAX(resolved_at_local)::text
          FROM dw.fact_cloudchat_tickets
          WHERE resolved_at_local IS NOT NULL
        `),
      ]);
      return {
        resolvidos:    rows?.[0]?.[0] ?? 0,
        dw_updated_at: fresh?.[0]?.[0] || null,
      };
    } catch { return { resolvidos: null, dw_updated_at: null }; }
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

      const [overview, { convs: allOpenConvs, truncated }, n2Counts, dwResolvidos] = await Promise.all([
        _fetchOverview(),
        _fetchAllOpen(),
        _fetchN2Counts(todayStartISO),
        _fetchDwResolvidos(),
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

      // Status dos agentes via overview (pode ser null se endpoint não existir)
      const oAgents = overview?.data?.agents ||
        (Array.isArray(overview?.agents) ? overview.agents : null);

      // Tabela por atendente: Na caixa (count + tickets) + status online
      const porAgente = {};
      for (const ag of CFG.AGENTES) porAgente[ag] = { na_caixa: 0, status: null, tickets: [] };
      if (oAgents) {
        for (const a of oAgents) {
          const key = CFG.AGENTES.find(x => x === a.name);
          if (key) porAgente[key].status = a.availability_status || null;
        }
      }
      for (const conv of openConvs) {
        const key = CFG.AGENTES.find(x => x === conv.meta?.assignee?.name);
        if (!key) continue;
        porAgente[key].na_caixa++;
        porAgente[key].tickets.push({
          id:   conv.id,
          link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${conv.id}`,
        });
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
          has_overview: !!oAgents,
          truncated,

          // Métricas HOJE (acumulam ao longo do dia, desde 00:00 BRT)
          hoje: {
            novos:               n2Counts.novos_hoje,           // CloudChat — tempo real
            resolv_criados_hoje: n2Counts.resolv_criados_hoje,  // CloudChat — tempo real
            resolvidos:          dwResolvidos.resolvidos,        // DW — até ~30min de atraso
            dw_updated_at:       dwResolvidos.dw_updated_at,
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

  // ── Rota de investigação temporária — remover após decisão ────────────────
  router.get('/ao-vivo/debug-resolvidos', async (req, res) => {
    try {
      const off = CFG.BRT_OFFSET_H * 3600000;
      const _d  = new Date(Date.now() + off);
      _d.setUTCHours(0, 0, 0, 0);
      const todayStartISO = new Date(_d.getTime() - off).toISOString(); // 00:00 BRT em UTC
      const token = process.env.CLOUDCHAT_TOKEN;

      const postF = async (payload) => {
        try {
          const r = await fetchCloudChat(
            `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations/filter?page=1`,
            token, 'POST', { payload }
          );
          const meta  = r?.meta || r?.data?.meta || {};
          const items = r?.payload || r?.data?.payload || [];
          return { count: meta.all_count ?? 0, sample: items.slice(0, 2) };
        } catch (e) { return { count: null, error: e.message }; }
      };

      // 1. Amostra de tickets resolvidos para inspecionar campos de data
      const restSample = await fetchCloudChat(
        `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations?status=resolved&page=1`,
        token
      );
      const sample = (restSample?.data?.payload || []).slice(0, 3).map(c => {
        const camposData = {};
        for (const [k, v] of Object.entries(c)) {
          if (typeof v === 'number' && v > 1_000_000_000 && v < 9_999_999_999) {
            camposData[k] = { unix: v, iso: new Date(v * 1000).toISOString() };
          }
        }
        return { id: c.id, status: c.status, labels: c.labels, campos_data: camposData };
      });

      // 2. CloudChat — status=resolved AND updated_at >= hoje BRT (proxy de resolved_at)
      const ccTodos = await postF([
        { attribute_key: 'status',     filter_operator: 'equal_to',       values: ['resolved'],      query_operator: 'AND' },
        { attribute_key: 'updated_at', filter_operator: 'is_greater_than', values: [todayStartISO],  query_operator: null  },
      ]);

      // 3. CloudChat — mesmo mas só n2_ticket
      const ccN2 = await postF([
        { attribute_key: 'labels',     filter_operator: 'equal_to',       values: ['n2_ticket'],     query_operator: 'AND' },
        { attribute_key: 'status',     filter_operator: 'equal_to',       values: ['resolved'],      query_operator: 'AND' },
        { attribute_key: 'updated_at', filter_operator: 'is_greater_than', values: [todayStartISO],  query_operator: null  },
      ]);

      // 4. DW (fonte atual do painel)
      const dw = await _fetchDwResolvidos();

      res.json({
        hoje_brt_inicio: todayStartISO,
        cloudchat: {
          todos_resolved_updated_hoje: ccTodos.count,
          n2_resolved_updated_hoje:    ccN2.count,
          nota_campo: 'usa updated_at como proxy — resolved_at nao suportado no filter API',
          sample_campos_data: sample,
        },
        dw: {
          resolvidos_hoje: dw.resolvidos,
          ultima_carga:    dw.dw_updated_at,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
