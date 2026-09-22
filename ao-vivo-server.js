'use strict';
const express = require('express');

// ── Config — ajuste aqui ──────────────────────────────────────────────────────
const CFG = {
  POLL_TTL_S:      25,          // cache server-side (segundos); deve ser < POLL_MS do frontend
  SLA_ATENCAO_MIN: 45,          // minutos sem 1ª resposta → atenção (amarelo)
  SLA_CRITICO_MIN: 60,          // minutos sem 1ª resposta → crítico (vermelho)
  BRT_OFFSET_H:   -3,           // fuso Brasília = UTC-3
  HORARIO: {
    inicio_min: 9 * 60,         // 9h00 BRT (minutos desde meia-noite)
    fim_min:    18 * 60 + 30,   // 18h30 BRT
    dias:       [1, 2, 3, 4, 5], // 1 = segunda … 5 = sexta
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

// Minutos dentro do horário comercial entre dois Unix timestamps (segundos).
// Técnica: desloca ms pelo offset BRT para operar com getUTCDay/setUTCDate
// sem depender do fuso do servidor (Heroku corre em UTC).
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

  // Tenta /reports/overview; retorna null se 404 / 401 / erro de rede
  async function _fetchOverview() {
    try {
      return await fetchCloudChat(
        `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/reports/overview`,
        process.env.CLOUDCHAT_TOKEN
      );
    } catch { return null; }
  }

  // Todos os tickets abertos (status=open), paginado — limite de 20 páginas por segurança.
  // Retorna { convs, truncated } — convs filtrado por n2_ticket; truncated=true = teto atingido.
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
    // Sem filtro: o handler deriva dois subconjuntos em memória
    // (specialist-assigned para tabela; n2_ticket para backlog).
    return { convs: all, total: total ?? all.length, truncated };
  }

  // Busca N2 em status pending e snoozed para compor o backlog total.
  // Retorna array concatenado filtrado por n2_ticket.
  async function _fetchN2ExtraStatuses() {
    const token = process.env.CLOUDCHAT_TOKEN;
    async function paginateN2(status) {
      const acc = [];
      let page = 1, total = null;
      while (true) {
        const r = await fetchCloudChat(
          `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations?status=${status}&page=${page}`,
          token
        );
        const payload = r?.data?.payload || [];
        if (total === null) total = r?.data?.meta?.all_count ?? payload.length;
        acc.push(...payload.filter(c => c.labels?.includes('n2_ticket')));
        if (payload.length < 25 || page * 25 >= total || page >= 20) break;
        page++;
      }
      return acc;
    }
    const [pending, snoozed] = await Promise.all([
      paginateN2('pending'),
      paginateN2('snoozed'),
    ]);
    return [...pending, ...snoozed];
  }

  // Total pendente N2 + ticket mais antigo.
  // sort=created_at pede ordenação ASC explícita → página 1 contém os mais antigos.
  // Filtra por n2_ticket: tickets da Claudia sem escalonamento ficam de fora.
  async function _fetchPendingInfo() {
    const token = process.env.CLOUDCHAT_TOKEN;
    const r1    = await fetchCloudChat(
      `/api/v1/accounts/${CLOUDCHAT_ACCOUNT}/conversations?status=pending&sort=created_at&page=1`,
      token
    );
    const p1   = r1?.data?.payload || [];
    const n2p1 = p1.filter(c => c.labels?.includes('n2_ticket'));
    // "mais antigo" = ticket sem primeira resposta ainda (verdadeiramente aguardando)
    const waiting = n2p1.filter(c => !c.first_reply_created_at);
    const oldest = waiting.length > 0
      ? waiting.reduce((acc, c) => c.created_at < acc.created_at ? c : acc)
      : null;
    return {
      total:   n2p1.length,
      oldest,
      tickets: n2p1.map(c => ({
        id:   c.id,
        link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${c.id}`,
      })),
    };
  }

  // Dados DW: encerrados/TMA/1ª resposta de hoje por agente + timestamp de frescor real
  async function _fetchDwHoje() {
    const off    = CFG.BRT_OFFSET_H * 3600000;
    const nowBRT = new Date(Date.now() + off);
    const hoje   = nowBRT.toISOString().slice(0, 10);
    const amanha = new Date(nowBRT.getTime() + 86400000).toISOString().slice(0, 10);
    const lista  = CFG.AGENTES.map(a => `'${a}'`).join(',');

    const [rows, fresh] = await Promise.all([
      dwQuery(`
        SELECT
          agent_on_resolution_name,
          COUNT(*)::int                                                             AS resolvidos,
          ROUND(AVG(CASE WHEN first_agent_resolution_time_min >  0
                          AND first_agent_resolution_time_min < 2880
                         THEN first_agent_resolution_time_min END))::int           AS tma_min,
          ROUND(AVG(CASE WHEN first_agent_reply_time_min >= 0
                          AND first_agent_reply_time_min <= 480
                         THEN first_agent_reply_time_min END))::int                AS resp_min
        FROM dw.fact_cloudchat_tickets
        WHERE agent_on_resolution_name IN (${lista})
          AND ticket_status = 'resolved'
          AND resolved_at_local >= '${hoje}'
          AND resolved_at_local <  '${amanha}'
        GROUP BY 1
      `),
      // Frescor real do DW: MAX(resolved_at_local) como proxy do último registro carregado.
      // CADÊNCIA DO ETL: a confirmar com a equipe de dados — nada muda aqui quando confirmado.
      dwQuery(`
        SELECT MAX(resolved_at_local)::text
        FROM dw.fact_cloudchat_tickets
        WHERE resolved_at_local IS NOT NULL
      `),
    ]);

    const porAgente = {};
    let totResolvidos = 0;
    const tmaSamples = [], respSamples = [];
    for (const [agente, resolvidos, tma_min, resp_min] of rows) {
      porAgente[agente] = { resolvidos: resolvidos || 0, tma_min, resp_min };
      totResolvidos += resolvidos || 0;
      if (tma_min  != null) tmaSamples.push(tma_min);
      if (resp_min != null) respSamples.push(resp_min);
    }
    const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

    return {
      dw_updated_at: fresh?.[0]?.[0] || null,
      por_agente:    porAgente,
      totais: { resolvidos: totResolvidos, tma_min: avg(tmaSamples), resp_min: avg(respSamples) },
    };
  }

  router.get('/ao-vivo/status', async (req, res) => {
    const nowS = Date.now() / 1000;
    if (_cache && (nowS - _cacheTs) < CFG.POLL_TTL_S) return res.json(_cache);

    try {
      const [overview, { convs: allOpenConvs, truncated }, pendingInfo, dwHoje, n2Extra] = await Promise.all([
        _fetchOverview(),
        _fetchAllOpen(),        // TODOS os abertos (sem filtro) — handler separa os dois subconjuntos
        _fetchPendingInfo(),
        _fetchDwHoje(),
        _fetchN2ExtraStatuses(), // pending + snoozed N2 → compõe backlog total
      ]);
      const now_s = Math.floor(Date.now() / 1000);

      // Início do dia em BRT como Unix segundos (para "entraram hoje")
      const _off = CFG.BRT_OFFSET_H * 3600000;
      const _d   = new Date(Date.now() + _off);
      _d.setUTCHours(0, 0, 0, 0);
      const todayStartS = (_d.getTime() - _off) / 1000;

      // "Na caixa das atendentes": N2 aberto COM especialista responsável
      // (intersecção n2_ticket + specialist → deve bater com soma da tabela por agente)
      const openConvs = allOpenConvs.filter(c =>
        c.labels?.includes('n2_ticket') && CFG.AGENTES.includes(c.meta?.assignee?.name)
      );
      // Pool N2 open: apenas status=open
      const openN2All = allOpenConvs.filter(c => c.labels?.includes('n2_ticket'));
      // Backlog real: open + pending + snoozed (todos os N2 ainda não resolvidos)
      const allActiveN2 = [...openN2All, ...n2Extra];
      // Não atribuídos: sem qualquer assignee across todos os status
      const naoAtribConvs = allActiveN2.filter(c => !c.meta?.assignee);

      // Inicializa todos os agentes monitorados
      const porAgente = {};
      for (const ag of CFG.AGENTES) porAgente[ag] = { em_andamento: 0, status: null, tickets: [] };

      // Chatwoot v2: overview.data.agents / v3: overview.agents (tenta os dois)
      const oAgents = overview?.data?.agents ||
        (Array.isArray(overview?.agents) ? overview.agents : null);

      // Status via overview (se disponível)
      if (oAgents) {
        for (const a of oAgents) {
          const key = CFG.AGENTES.find(x => x === a.name);
          if (!key) continue;
          porAgente[key].status = a.availability_status || null;
        }
      }

      // Contagem e lista de tickets sempre via openConvs (count == lista de tickets garantido)
      for (const conv of openConvs) {
        const name = conv.meta?.assignee?.name;
        const key  = name && CFG.AGENTES.find(x => x === name);
        if (!key) continue;
        porAgente[key].em_andamento++;
        porAgente[key].tickets.push({
          id:   conv.id,
          link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${conv.id}`,
        });
      }

      // SLA em risco — apenas 1ª resposta (v1).
      // Risco de resolução (ticket parado após resposta): a implementar depois.
      const slaRisco = [];
      for (const conv of openConvs) {
        if (conv.first_reply_created_at) continue; // já respondeu
        const mins = _bhMins(conv.created_at, now_s);
        if (mins < CFG.SLA_ATENCAO_MIN) continue;
        const agentName = conv.meta?.assignee?.name || '(sem agente)';
        slaRisco.push({
          id:      conv.id,
          agente:  CFG.DISPLAY[agentName] || agentName,
          minutos: Math.round(mins),
          nivel:   mins >= CFG.SLA_CRITICO_MIN ? 'critico' : 'atencao',
          link:    `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${conv.id}`,
        });
      }
      slaRisco.sort((a, b) => b.minutos - a.minutos);

      // Vazão do dia
      const entramHoje     = allActiveN2.filter(c => c.created_at >= todayStartS).length;
      const resolvidosHoje = dwHoje.totais.resolvidos ?? 0;
      const backlogSemRes  = naoAtribConvs.length;                   // N2 sem responsável (qualquer status)
      const backlogAtrib   = allActiveN2.length - backlogSemRes;     // N2 com qualquer assignee

      const maisAntigoMin = pendingInfo.oldest
        ? Math.round(_bhMins(pendingInfo.oldest.created_at, now_s))
        : null;

      const result = {
        ao_vivo: {
          updated_at:      new Date().toISOString(),
          has_overview:    !!oAgents,
          em_andamento_truncated: truncated,
          vazao: {
            entram_hoje:     entramHoje,
            resolvidos_hoje: resolvidosHoje,    // DW — bate com "encerrados hoje" da tabela
            backlog:         allActiveN2.length, // total N2 (open + pending + snoozed)
            atribuidos:      backlogAtrib,       // N2 com qualquer assignee
            sem_responsavel: backlogSemRes,      // N2 sem responsável (= nao_atribuidos.total)
          },
          nao_atribuidos: {
            total:   naoAtribConvs.length,
            tickets: naoAtribConvs.map(c => ({
              id:   c.id,
              link: `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${c.id}`,
            })),
          },
          fila: {
            total:            pendingInfo.total,
            mais_antigo_min:  maisAntigoMin,
            mais_antigo_link: pendingInfo.oldest
              ? `${CLOUDCHAT_BASE}/app/accounts/${CLOUDCHAT_ACCOUNT}/conversations/${pendingInfo.oldest.id}`
              : null,
            tickets:          pendingInfo.tickets,
          },
          em_andamento:    openConvs.length, // N2 com especialista = "Na caixa das atendentes"
          por_agente:      porAgente,
          sla_risco:       slaRisco,
        },
        acumulados: dwHoje,
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
