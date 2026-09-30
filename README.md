# Painel de Gestão de Suporte — INK

Documentação técnica para reimplementação. Descreve exatamente o que está implementado no código, com fórmulas completas e queries reais. Produzida a partir da leitura integral de `server.js`, `gerencial.html` e `report.html`.

---

## 1. VISÃO GERAL

Painel interno para gestão do time de suporte da Reserva INK. Acesso restrito a e-mails `@reserva.ink` por login com senha. Composto de duas telas principais:

### Tela principal — `gerencial.html`

Dividida em quatro seções verticais, nesta ordem:

| Seção | O que mostra |
|---|---|
| **Calendário CSAT** | Grade de dias úteis com cor por satisfação %; clicável para abrir relatório do dia |
| **Rankings CSAT** | Satisfação % por agente (últimos 90 dias) e top tags negativas/positivas por semana/mês |
| **Métricas Operacionais** | Tabela por agente + KPIs globais do período selecionado (dia/semana/mês/período/acumulado) |
| **Painel Claudia — Retenção N1** | KPIs e tabela de tickets da IA Claudia no período |

### Tela de relatório diário — `report.html`

Abre ao clicar um dia no calendário. Mostra avaliações CSAT daquele dia: KPIs do dia (recebidas, positivas, negativas, indevidas), filtro por agente e tag, lista de tickets por agente com nota e feedback. Seção de avaliações indevidas com botão Desfazer.

---

## 2. ORIGEM DOS DADOS

### Fonte A — Data Warehouse via Metabase API

**Host:** `https://rsv-ink-metabase-f7ef97f28c72.herokuapp.com`  
**Database ID no Metabase:** `2`  
**Autenticação:** Login com `METABASE_EMAIL` / `METABASE_PASSWORD` (variáveis de ambiente no Heroku) via `POST /api/session`. Retorna um token de sessão usado no header `X-Metabase-Session`. O token é obtido a cada requisição — não há cache de token.

Dois modos de consulta ao Metabase:

- **`dwQuery(sql)`** — SQL nativo via `POST /api/dataset` com `type: 'native'`. Retorna `data.data.rows` (array de arrays). Usado para todas as queries em `dw.fact_cloudchat_tickets` e `dw.fact_cloudchat_ticket_labels`.
- **`queryMetabase(token, query)`** — Queries estruturadas (MBQL) via `POST /api/dataset`. Usado para buscar labels de tickets (tabela Metabase ID 7376) e para endpoints de diagnóstico histórico.

**Tabelas consultadas no DW:**

| Tabela | Uso |
|---|---|
| `dw.fact_cloudchat_tickets` | Fonte principal: tickets, status, agentes, CSAT, tempos de resposta |
| `dw.fact_cloudchat_ticket_labels` | Tags/etiquetas de cada ticket |
| `dw.fact_cloudchat_ticket_custom_fields` | Campo customizado `aguardando_confirmao_de_resoluo_lojista` (flag booleano) |

**Metabase table IDs** (usados em queries estruturadas):
- Tickets: `7375`; Labels: `7376`
- Field IDs relevantes na tabela 7375: `174172` (ticket_id interno), `174143` (display_ticket_id), `174139` (data principal), `174181` (csat_score), `174167` (agente), `174169` (feedback), `174174` (link), `174140` (campo extra)
- Field IDs na tabela 7376: `174185` (display_ticket_id), `174188` (label_name)

**Atualização:** Job agendado (cron) — não tempo real. Cache de 12 horas para Métricas Operacionais. Ver seção 7.

### Fonte B — PostgreSQL Heroku (banco operacional)

**Conexão:** variável de ambiente `DATABASE_URL` (Heroku Postgres), schema `support_bi`.  
**SSL:** `rejectUnauthorized: false`.

Tabelas:

| Tabela | Conteúdo |
|---|---|
| `support_bi.csat_reports` | Um registro por dia útil. `date VARCHAR(10) PK`, `data JSONB` (relatório completo do dia), `created_at TIMESTAMPTZ` |
| `support_bi.csat_indevidas` | Avaliações marcadas como inválidas. `ticket_id VARCHAR(50) PK`, `date VARCHAR(10)`, `motivo VARCHAR(100)`, `observacao TEXT`, `marcado_em TIMESTAMPTZ` |
| `support_bi.kpis_op_cache` | Cache das Métricas Operacionais. `period_key TEXT PK`, `data JSONB`, `fetched_at TIMESTAMPTZ` |
| `support_bi.csat_users` | Usuários com acesso ao painel. `email TEXT UNIQUE`, `password_hash TEXT` (scrypt+salt) |
| `support_bi.csat_reset_tokens` | Tokens de reset de senha. TTL 1h (reset) ou 48h (convite) |
| `support_bi.ticket_times_enriched` | Tempos enriquecidos por tag (tabela auxiliar, processada sob demanda via admin endpoint) |

### Fonte C — CloudChat API (webhooks e consultas pontuais)

**Base:** `https://cloudchat3.cloudhumans.com`, account `73`.  
**Autenticação:** header `api_access_token` com valor da variável `CLOUDCHAT_TOKEN`.  
**Uso atual:**
- Webhook `POST /webhook/csat-invalida` — recebe do CloudChat quando uma conversa é marcada como CSAT inválida. Dispara reprocessamento do dia.
- Endpoint admin `GET /admin/puxar-indevidas-cloudchat` — importação histórica de indevidas via filtro de conversas (`/api/v1/accounts/73/conversations/filter`).
- Endpoint admin `GET /admin/process-reply-times` — busca mensagens de cada ticket (`/api/v1/accounts/73/conversations/{id}/messages`) para calcular tempo de resposta subsequente.

### Quem escreve dados manualmente

| O que | Quem | Onde | Quando |
|---|---|---|---|
| Marcar avaliação como indevida | Gestora (via painel) | `POST /indevida` ou botão em `report.html` | A qualquer momento |
| Marcar indevida via CloudChat | Automático (webhook) | `POST /webhook/csat-invalida` | Quando conversa é flagada no CloudChat |
| Desfazer indevida | Gestora (via painel) | `DELETE /indevida/:ticket_id` | A qualquer momento |
| Criar usuário | Admin técnico | `POST /admin/add-user` (requer `ADMIN_KEY`) | Sob demanda |

---

## 3. DEFINIÇÃO DE PERÍODO

**Esta é a seção mais crítica. Leia com atenção — há dois sistemas de ancoragem diferentes no mesmo painel.**

### 3.1 Painel CSAT (report.html + rankings em gerencial.html)

**Campo de ancoragem:** `resolved_at_local` (data de resolução do ticket no fuso horário local, campo do DW).

Query exata usada em `runDailyReport()`:
```sql
SELECT display_ticket_id, agent_on_resolution_name, csat_score,
       csat_feedback, contact_name, ticket_link
FROM dw.fact_cloudchat_tickets
WHERE csat_score IS NOT NULL
  AND ticket_status = 'resolved'
  AND resolved_at_local >= 'YYYY-MM-DD'
  AND resolved_at_local < 'YYYY-MM-DD+1'
LIMIT 2000
```

Um ticket entra no relatório do dia D se e somente se foi **resolvido** naquele dia (status `resolved`) e possui avaliação CSAT.

**Fuso horário:** O campo `resolved_at_local` já vem convertido para o fuso local pelo DW. A função `yesterdayDate()` aplica UTC-3 para determinar "ontem" em Brasília:
```javascript
function yesterdayDate() {
  const date = new Date();
  date.setUTCHours(date.getUTCHours() - 3); // ajuste BRT
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
```

**Período:** Intervalo fechado à esquerda, aberto à direita: `>= date AND < date+1`. O dia começa e termina à meia-noite (00:00:00) conforme o campo `resolved_at_local`.

**Período anterior (comparação):** Não há comparação de dia anterior no Painel CSAT. A comparação é de semana anterior nas Métricas Operacionais (ver 3.2).

**Divergência em relação ao CloudChat nativo:** O CloudChat agrupa tickets por data de criação. Este painel agrupa por **data de resolução**, porque é quando a agente "finalizou o atendimento" e quando a avaliação é registrada. Isso significa que um ticket criado na segunda e resolvido na terça aparece no relatório de terça, não de segunda.

### 3.2 Métricas Operacionais (`/kpis-semanais`)

**Campo de ancoragem principal:** `created_at_local` (data de criação do ticket) para a maioria dos KPIs globais.

**Exceção crítica — tabela por agente:** Os tickets que entram na tabela por agente usam critério misto:
- Tickets resolvidos: `ticket_status = 'resolved' AND resolved_at_local >= d0 AND resolved_at_local < d1`
- Tickets snoozed com flag de seller: `aguardando_confirmao_de_resoluo_lojista = true AND created_at_local >= d0 AND created_at_local < d1`

Portanto, o **volume** de um agente no período é: tickets resolvidos por ela no período (data de resolução) + tickets em snoozed com flag seller, criados no período.

**Modos de período disponíveis:**

| Modo | Como calcula d0 e d1 | Período anterior (pd0, pd1) |
|---|---|---|
| `dia` | `d0 = ?dia`, `d1 = dia + 1 dia` | `pd0 = dia - 1 dia`, `pd1 = dia` |
| `semana` | `d0 = domingo da semana atual (UTC)`, `d1 = d0 + 7 dias` | `pd0 = d0 - 7 dias`, `pd1 = d0` |
| `mes` | `d0 = primeiro dia do mês`, `d1 = primeiro dia do próximo mês` | `pd0 = primeiro dia do mês anterior`, `pd1 = d0` |
| `periodo` | `d0 = ?inicio`, `d1 = ?fim + 1 dia` | `pd0 = d0 - duração do período`, `pd1 = d0` |
| `acumulado` | `d0 = 2026-02-01`, `d1 = hoje + 1 dia` | sem período anterior |

**Semana:** Ancora no domingo (Dom a Sáb). O domingo da semana é calculado como `hoje - hoje.getUTCDay()` (getUTCDay retorna 0 para domingo). O label exibido na UI mostra o intervalo completo Dom–Sáb, mas o label de semana no contexto do Painel CSAT (gerencial.html) exibe Seg–Sex do mesmo intervalo (dias úteis).

**Dias úteis:** `countBusinessDays(d0, d1)` conta dias de segunda a sexta dentro do intervalo `[d0, d1)`. Não considera feriados — apenas finais de semana.

**Meta de volume por agente:** `45 × diasUteis` tickets no período. Ex: semana com 5 dias úteis → meta = 225 tickets por agente.

**Cache:** Resultado de `/kpis-semanais` é cacheado em `kpis_op_cache` com TTL de 12 horas. Chave de cache: `dia:YYYY-MM-DD`, `semana:YYYY-MM-DD`, `mes:YYYY-MM`, `periodo:YYYY-MM-DD:YYYY-MM-DD`. O cache é invalidado integralmente (DELETE) a cada execução dos crons diários.

### 3.3 Painel Claudia

**Campo de ancoragem:** `created_at_local` para todos os KPIs e listagem de tickets.

### 3.4 Rankings CSAT (seção gerencial.html — semanas e meses)

**Fonte:** `/gestao` endpoint — lê os últimos 90 dias de `csat_reports` e agrega.

**Semana:** Domingo-âncora. Cada data de `csat_reports` é mapeada para seu domingo com `date.getUTCDay()`, depois `setUTCDate(d - dow)`.

**Mês:** Primeiros 7 caracteres da date string (`date.slice(0, 7)` = `YYYY-MM`).

---

## 4. CADA MÉTRICA

### 4.1 Painel CSAT — KPIs do dia (`report.html`)

#### Recebidas

- **O que é:** Total de tickets com avaliação CSAT, de todas as agentes, que foram resolvidos naquele dia.
- **Fórmula:** `comNota.length` = todos os registros do DW com `csat_score IS NOT NULL AND ticket_status = 'resolved' AND resolved_at_local` no dia, sem filtro de agente.
- **Inclui:** Qualquer agente, incluindo bot, gestão, outros times.
- **Exclui:** Tickets sem avaliação (`csat_score IS NULL`). Indevidas NÃO são excluídas deste total.
- **Campo de data:** `resolved_at_local`.
- **Arredondamento:** Contagem inteira.

#### Positivas

- **O que é:** Avaliações com nota ≥ 4 de agentes monitoradas.
- **Fórmula:** `positivosMonitorados.length` = tickets do DW com `csat_score >= 4` E `agent_on_resolution_name` contém alguma das strings em `AGENTES`.
- **Inclui:** Apenas as 5 agentes monitoradas (ver seção 6.1). Não inclui avaliações de outras agentes nem da Claudia.
- **Campo de data:** `resolved_at_local`.

#### Negativas

- **O que é:** Avaliações com nota ≤ 3 de agentes monitoradas, excluindo indevidas.
- **Fórmula:** `tickets.length` = tickets com `csat_score <= 3` E agente monitorada E `ticket_id NOT IN csat_indevidas`.
- **Indevidas:** Excluídas do numerador. Permanecem no total `Recebidas`.
- **Campo de data:** `resolved_at_local`.

#### Indevidas

- **O que é:** Avaliações marcadas como inválidas naquele dia.
- **Fórmula:** `indevidasSet.size` — tamanho do conjunto de todos os ticket_ids em `csat_indevidas` (sem filtro de data na busca — a exclusão é feita cruzando com o conjunto global).
- **Atenção:** A query de indevidas busca TODOS os ticket_ids sem filtro de data: `SELECT ticket_id FROM support_bi.csat_indevidas`. O cruzamento com os tickets do dia é feito em memória. Isso significa que um ticket marcado como indevida em qualquer data é excluído de qualquer dia onde ele aparecer.

#### Satisfação % (por agente e no ranking)

- **Fórmula:** `Math.round(pos / tot * 100)` onde `pos = total_positivos`, `tot = total_avaliados = total_positivos + total_negativos`.
- **Denominador:** Apenas avaliados das agentes monitoradas (positivos + negativos). Não inclui "Recebidas" (que conta agentes não monitoradas).
- **Valores ausentes:** Se `tot = 0`, não é calculado (aparece `—`).
- **Arredondamento:** `Math.round()` (sem casas decimais).
- **Cor no ranking:** ≥ 75% verde, ≥ 50% amarelo, < 50% vermelho.
- **Badges:** ≥ 85% ouro, ≥ 75% prata.

#### Cor do dia no calendário

Se `total_avaliados > 0`:
- Verde (`vol-baixo`): satisfação ≥ 75%
- Amarelo (`vol-medio`): satisfação ≥ 55% e < 75%
- Vermelho (`vol-alto`): satisfação < 55%

Se `total_avaliados = 0` (sem avaliações no dia), usa volume de negativos absoluto:
- Verde: negativos < 4
- Amarelo: negativos ≥ 4 e < 8
- Vermelho: negativos ≥ 8

---

### 4.2 Métricas Operacionais Globais (`/kpis-semanais`)

#### Volume de Tickets Recebidos

- **Fórmula:** `COUNT(ticket_id) FROM dw.fact_cloudchat_tickets WHERE created_at_local >= d0 AND created_at_local < d1`
- **Inclui:** Todos os tickets criados no período, qualquer agente, qualquer status.
- **Campo de data:** `created_at_local`.

#### Respondidos (por agentes monitoradas)

- **Fórmula:** `COUNT(*) WHERE ticket_status = 'resolved' AND agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa') AND resolved_at_local >= d0 AND resolved_at_local < d1`
- **Campo de data:** `resolved_at_local`.
- **Nota:** Este é um subconjunto do volume; não abrange todas as resoluções (exclui Claudia, outros agentes, tickets abertos/pendentes).

#### Média Diária

- **Fórmula:** `ROUND(COUNT(*) / NULLIF(COUNT(DISTINCT DATE(created_at_local)), 0), 1)` — total de tickets criados no período dividido pelo número de dias distintos que tiveram pelo menos um ticket.
- **Unidade:** Tickets/dia, 1 casa decimal.
- **Inclui:** Todos os tickets, qualquer agente.

#### CSAT Geral

- **Fórmula:** `ROUND(COUNT(CASE WHEN csat_score >= 4 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 1)` onde `COUNT(*)` conta tickets com `csat_score IS NOT NULL`.
- **Inclui:** Todos os tickets com avaliação criados no período, qualquer agente.
- **Exclui:** Tickets indevidos (identificados por ticket_id em `csat_indevidas`). Tickets sem avaliação (fora do denominador).
- **Campo de data:** `created_at_local`.
- **Divergência em relação ao Painel CSAT:** O Painel CSAT usa `resolved_at_local` e filtra por agentes monitoradas. O CSAT Geral das Métricas Operacionais usa `created_at_local` e inclui todos os agentes. Os números **não batem** — é esperado.
- **Meta:** 75%. Cor: ≥ 75% verde, ≥ 55% amarelo, < 55% vermelho.

#### CSAT Claudia (IA)

- **Fórmula:** `ROUND(((AVG(csat_score) - 1) / 4.0 * 100)::numeric, 1)` — converte a média da escala 1-5 para 0-100%.
- **Inclui:** Tickets com `agent_on_resolution_name ILIKE '%claudia%' AND NOT ILIKE '%projetos%'`, `csat_score IS NOT NULL`.
- **Campo de data:** `created_at_local`.
- **Atenção:** Fórmula diferente do CSAT das agentes humanas. O CSAT humano é `positivos/total`. O CSAT da Claudia é `(média - 1) / 4 * 100`. Não são comparáveis diretamente.
- **Cor:** ≥ 75% verde, ≥ 55% amarelo, < 55% vermelho.

#### Tempo de 1ª Resposta — Média (TPR)

- **Fórmula:** `ROUND(AVG(first_agent_reply_time_min) / 60.0, 1)` em horas.
- **Filtro:** `first_agent_first_reply_at_local IS NOT NULL AND first_agent_reply_time_min IS NOT NULL AND first_agent_reply_time_min >= 0`.
- **Campo de data:** `created_at_local`.
- **Inclui:** Todos os tickets criados no período com valor de TPR válido, qualquer agente.
- **Como o campo é calculado:** `first_agent_reply_time_min` é calculado e armazenado pelo CloudChat internamente, já descontando o horário comercial configurado na conta. O servidor não aplica nenhum desconto adicional.
- **Limitação conhecida:** Se um ticket é transferido entre agentes, `first_agent_reply_time_min` registra o tempo da primeira resposta da primeira agente, mas o ticket aparece na métrica da agente que o resolveu. Isso distorce a média da agente de resolução.
- **Meta:** ≤ 1h verde, ≤ 2h amarelo, > 2h vermelho.

#### Tempo de 1ª Resposta — Mediana (P50)

- **Fórmula:** `ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_agent_reply_time_min))::numeric / 60.0, 1)` em horas.
- **Mesmo filtro** que a média. Mesmos inclusões/exclusões.
- **Uso:** A mediana é mais robusta a outliers do que a média. Se média >> mediana, há tickets com tempo muito alto distorcendo.

#### Tempo de Encerramento — Média (TER)

- **Fórmula:** `ROUND(AVG(first_agent_resolution_time_min) / 60.0, 1)` em horas.
- **Filtro:** `resolved_at_local IS NOT NULL AND first_agent_resolution_time_min IS NOT NULL AND first_agent_resolution_time_min > 0 AND first_agent_resolution_time_min < 2880`.
- **Limite superior:** 2880 minutos = 48 horas. Tickets acima desse valor são excluídos como outliers.
- **Campo de data:** `created_at_local`.

#### Tempo de Encerramento — Mediana (P50)

- **Fórmula:** `PERCENTILE_CONT(0.5)` com os mesmos filtros do TER médio.

---

### 4.3 Métricas Operacionais — Tabela por Agente

Agentes exibidas: `'Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa'` (exato, case-sensitive no IN).

#### Volume por Agente

- **Fórmula:** `COUNT(*)` sobre o conjunto:
  - `(ticket_status = 'resolved' AND resolved_at_local >= d0 AND resolved_at_local < d1)` **OU**
  - `(cf.field_value_bool = true AND created_at_local >= d0 AND created_at_local < d1)` [snoozed com flag seller]
- **Inclui:** Tickets encerrados pela agente no período (por data de resolução) + tickets em snoozed com flag "aguardando lojista" criados no período.
- **Exclui:** Tickets apenas pendentes ou em aberto sem flag seller, tickets de outras agentes.

#### TPR por Agente (média e mediana)

- **Fórmula média:** `ROUND(AVG(CASE WHEN first_agent_reply_time_min IS NOT NULL AND first_agent_first_reply_at_local IS NOT NULL AND first_agent_reply_time_min >= 0 THEN first_agent_reply_time_min END) / 60.0, 1)`
- **Fórmula mediana:** `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_agent_reply_time_min) FILTER (WHERE ...)`
- **Calculado sobre todos os tickets do conjunto acima** (resolvidos + snoozed com flag).
- **Mesmo aviso de outliers** por transferência de tickets aplica-se aqui.

#### TER por Agente (média e mediana)

- **Fórmula média:** `ROUND(AVG(CASE WHEN first_agent_resolution_time_min IS NOT NULL AND first_agent_resolution_time_min > 0 AND first_agent_resolution_time_min < 2880 AND resolved_at_local IS NOT NULL THEN first_agent_resolution_time_min END) / 60.0, 1)`
- **Corte de outliers:** < 2880 min (48h).

#### CSAT por Agente

- **Fonte primária:** `support_bi.csat_reports` — agrega `por_agente` (negativos) e `por_agente_positivos` (positivos) de todos os dias no período.
- **Fórmula:** `Math.round(pos / (pos + neg) * 1000) / 10` (1 casa decimal).
- **Fonte secundária (fallback):** DW — `COUNT(csat_score >= 4) / COUNT(csat_score IS NOT NULL)`, usado quando `csat_reports` ainda não tem dados para o período (ex: dados do dia atual antes do cron rodar).
- **Indevidas:** Excluídas via `AND t.ticket_id NOT IN (lista de indevidas)` na query DW. No fallback via csat_reports, já estão excluídas pois o relatório diário já as filtra.
- **Atenção:** O CSAT por agente em Métricas Operacionais e o CSAT no Painel CSAT diário usam a mesma base (`csat_reports`), mas a ancoragem de data é diferente:
  - `csat_reports` grava por data de resolução.
  - O período de Métricas Operacionais filtra `csat_reports WHERE date >= d0 AND date < d1`.
  - Portanto: um ticket criado na semana passada mas resolvido esta semana aparece no CSAT desta semana.

#### Encerrados (Resolvidos por Agente — coluna separada)

- **Fórmula:** `COUNT(*)::int WHERE ticket_status = 'resolved' AND agent_on_resolution_name IN (...) AND resolved_at_local >= d0 AND resolved_at_local < d1`
- **Nota:** Diferente do "Volume por Agente" — este conta apenas resolvidos (sem snoozed com flag). Permite ver quantos tickets foram de fato encerrados.

#### Snoozed por Agente

- **Fórmula:** `COUNT(*) FILTER (WHERE cf.field_value_bool = true)` = com flag seller; `COUNT(*) FILTER (WHERE cf.field_value_bool IS NOT TRUE)` = sem flag.
- **Filtro de período:** `ticket_status = 'snoozed' AND created_at_local >= d0 AND created_at_local < d1`.
- **Exibe:** Lista de IDs de cada grupo (com/sem flag) para permitir drill-down.

---

### 4.4 Métricas de Backlog (snapshot ao vivo, sem filtro de período)

#### Backlog Global — Em Aberto / Pendentes / Sem Atribuição

Queries sem filtro de data (refletem o estado atual do DW):

- **Em Aberto:** `COUNT(*) WHERE ticket_status = 'open' AND (agent IS NULL OR agent NOT ILIKE '%projetos%')`
- **Pendentes:** `COUNT(*) WHERE ticket_status = 'pending' AND (agent IS NULL OR agent NOT ILIKE '%projetos%')`
- **Sem Atribuição:** `COUNT(*) WHERE ticket_status IN ('open','pending') AND agent_on_resolution_name IS NULL`

---

### 4.5 Painel Claudia — Retenção N1

#### Atendidos (Retenção N1)

- **O que é:** Tickets resolvidos pela IA Claudia no período.
- **Fórmula:** `COUNT(*) WHERE ticket_status = 'resolved' AND agent_on_resolution_name ILIKE '%claudia%' AND NOT ILIKE '%projetos%' AND created_at_local >= d0 AND created_at_local < d1`
- **Campo de data:** `created_at_local` (data de criação do ticket, não de resolução).
- **Como Claudia é identificada:** Qualquer nome que contenha "claudia" (case-insensitive), excluindo os que contêm "projetos".

#### Taxa de Retenção

- **Fórmula:** `Math.round(retencao_n1 / volume * 100)` onde `volume` = total de tickets recebidos no período (todos os agentes, `created_at_local`).
- **Unidade:** %.
- **Cor:** ≥ 30% verde, ≥ 20% amarelo, < 20% vermelho.

#### CSAT Claudia (Painel Claudia)

- **Fórmula:** `ROUND(((AVG(csat_score) - 1) / 4.0 * 100)::numeric, 1)` — mesma fórmula da seção 4.2.
- **Campo de data:** `created_at_local`.
- **Cor:** ≥ 75% verde, ≥ 55% amarelo, < 55% vermelho.

#### Avaliados (Painel Claudia)

- **Fórmula:** `tickets.filter(t => t.nota !== null).length` — contagem de tickets da Claudia (da listagem) com avaliação.
- **Positivos:** `nota >= 4`; **Negativos:** `nota <= 3`.
- **Base:** A listagem de tickets (`claudia_tickets`) busca todos os tickets com `agent_on_resolution_name ILIKE '%claudia%'`, qualquer status, por `created_at_local`.

---

## 5. FILTROS

### 5.1 Métricas Operacionais

| Filtro | Valores | Padrão |
|---|---|---|
| **Dia** | Data específica (YYYY-MM-DD) | — |
| **Semana** | domingo-âncora (YYYY-MM-DD) | semana atual |
| **Mês** | YYYY-MM | — |
| **Período** | data início + data fim | — |
| **Acumulado** | fixo: 2026-02-01 até hoje | — |

Ao abrir o painel, o modo padrão é **Semana** com a semana atual.

Todos os filtros alteram `d0` e `d1` e recarregam via `GET /kpis-semanais` com os parâmetros correspondentes: `?dia=`, `?semana=`, `?mes=`, `?inicio=&fim=`. O modo acumulado envia `inicio=2026-02-01&fim=hoje`.

Filtros se **substituem mutuamente** (não se combinam).

**Filtros implícitos permanentes (não aparecem na UI):**
- Tabela por agente: apenas `'Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa'`
- Claudia: `ILIKE '%claudia%' AND NOT ILIKE '%projetos%'`
- TER: exclui tickets com `first_agent_resolution_time_min >= 2880` (48h)
- Indevidas: excluídas do CSAT usando `NOT IN (lista de ids)`

### 5.2 Painel Claudia

Mesmos modos que Métricas Operacionais (Dia/Semana/Mês/Período/Acumulado), independentes — o filtro de Claudia não afeta as Métricas Operacionais.

### 5.3 Pílulas de status (Painel Claudia)

Abaixo da tabela de tickets: clicar em uma pílula de status (`resolvido`, `aberto`, `pendente`, `snoozed`) filtra as linhas da tabela localmente (sem nova requisição). Clicar novamente desfaz o filtro.

### 5.4 report.html (relatório diário)

| Filtro | Como funciona |
|---|---|
| Por agente | Exibe apenas tickets daquela agente (filtro local em JS) |
| Por tag | Exibe apenas tickets com aquela tag |
| Tipo (Positivos / Negativos) | Alterna entre arrays `tickets_positivos` e `tickets` do JSON |

Filtros combinam com **E** (agente E tag).

**Filtro implícito permanente em report.html:** Apenas agentes monitoradas aparecem nas tabs. Outros agentes aparecem em seção separada "Outros agentes" (a partir de `por_agente_outros` e `tickets_outros`).

---

## 6. CLASSIFICAÇÕES E REGRAS DE NEGÓCIO

### 6.1 Agentes Monitoradas

Definidas em duas listas com nomes diferentes, usadas em contextos diferentes:

**Lista 1 — detecção em `runDailyReport()` (Painel CSAT diário):**
```javascript
const AGENTES = ['Mari', 'Fernanda', 'Fer', 'Paty', 'Lu Almeida', 'Rafa'];
```
A detecção usa `nome.includes(a)` — substring, não igualdade exata. Exemplo: `"Fernanda Cavalcante"` passa porque contém `"Fernanda"`.

**Lista 2 — queries DW em Métricas Operacionais:**
```sql
agent_on_resolution_name IN ('Mari','Fernanda Cavalcante','Paty','Lu Almeida','Rafa')
```
Igualdade exata. `'Fernanda'` sem sobrenome **não bate** nesta lista.

**Consequência:** Há uma potencial divergência se o nome exato no DW mudar. O Painel CSAT detecta "Fernanda" em qualquer variação; as Métricas Operacionais só detectam `'Fernanda Cavalcante'` exato.

### 6.2 Claudia (IA)

Detectada por: `agent_on_resolution_name ILIKE '%claudia%' AND NOT ILIKE '%projetos%'`.

Não aparece na tabela de agentes monitoradas das Métricas Operacionais. Tem seção própria ("Painel Claudia"). Seu volume de retenção N1 aparece também como uma linha especial na tabela de Métricas Operacionais (coluna separada no rodapé).

### 6.3 N1 vs N2

"N1" = atendimento resolvido pela Claudia (IA). "Retenção N1" = % dos tickets que a Claudia conseguiu resolver sem escalar para humano. Não há definição de N2 separada no código — qualquer ticket não resolvido pela Claudia que chegue às agentes humanas é implicitamente N2, mas não é rastreado com esse label.

### 6.4 Classificação de tickets na tabela por agente

- **`encerrado`:** `ticket_status = 'resolved'`
- **`seller` (snoozed com flag):** `ticket_status = 'snoozed' AND aguardando_confirmao_de_resoluo_lojista = true`
- **`sem_flag` (snoozed sem flag):** `ticket_status = 'snoozed' AND aguardando_confirmao_de_resoluo_lojista IS NOT TRUE`

### 6.5 Avaliações Indevidas

Avaliação indevida = CSAT recebido mas considerado inválido para efeito de métricas. Causas comuns:
- Ticket reaberto após avaliação (motivo `avaliacao_reaberto`)
- Marcação via webhook CloudChat (motivo `cloudchat_webhook`)
- Importação histórica (motivo `cloudchat_historico_junho`, `importacao_historica`)

**Efeito:**
- Excluída de `total_negativos` (e do array `tickets`) no Painel CSAT.
- NÃO excluída de `total_recebidos`.
- Excluída do CSAT nas Métricas Operacionais via `ticket_id NOT IN (lista)`.

**Chave primária:** `ticket_id` (único por ticket). Marcar o mesmo ticket duas vezes faz upsert.

### 6.6 Limiares de cor

| Indicador | Verde | Amarelo | Vermelho |
|---|---|---|---|
| Satisfação % por agente | ≥ 75% | ≥ 50% | < 50% |
| CSAT Geral (ops) | ≥ 75% | ≥ 55% | < 55% |
| CSAT Claudia | ≥ 75% | ≥ 55% | < 55% |
| Taxa de Retenção N1 | ≥ 30% | ≥ 20% | < 20% |
| Tempo 1ª Resposta | ≤ 1h | ≤ 2h | > 2h |
| Cal. dia (com avaliações) | satisf ≥ 75% | satisf ≥ 55% | satisf < 55% |
| Cal. dia (sem avaliações) | negativos < 4 | negativos < 8 | negativos ≥ 8 |

---

## 7. GATILHOS E AUTOMAÇÕES

### Cron 1 — Coleta diária (7h Brasília / 10h UTC)

```javascript
cron.schedule('0 10 * * *', () => { runDailyReport(null, false); /* + invalida cache */ });
```
Roda todos os dias (incluindo fins de semana, mas `yesterdayDate()` pode resultar em sábado/domingo). Salva apenas se ainda não existe registro para a data (`force = false`). Invalida todo o `kpis_op_cache`.

### Cron 2 — Reprocessamento (12h Brasília / 15h UTC)

```javascript
cron.schedule('0 15 * * *', () => { runDailyReport(null, true); /* + invalida cache */ });
```
Força reprocessamento de ontem (`force = true`) para capturar avaliações que chegaram tarde. Invalida todo o `kpis_op_cache`.

### Webhook — Indevida em tempo real

`POST /webhook/csat-invalida` — recebido do CloudChat quando uma conversa é marcada como "Avaliação de CSAT é inválida?".

Payload esperado: `{ conversation_url, created_at (Unix timestamp), agent_display_name }`.

Ação: salva em `csat_indevidas`, invalida `kpis_op_cache`, e reprocessa o dia de resolução do ticket (buscado no DW) com `force = true`.

### Reprocessamento manual

`GET /run?date=YYYY-MM-DD&force=true` — disponível sem autenticação de sessão. Processa qualquer data passada.

---

## 8. CASOS DE BORDA E LIMITAÇÕES CONHECIDAS

### 8.1 Sem dados no período

Métricas Operacionais retornam `null` para KPIs numéricos quando não há tickets. A UI exibe `—`. Não há distinção visual entre "zero tickets" e "dado indisponível" — ambos aparecem como `—` quando o valor é `null`.

### 8.2 CSAT não fecha entre Painel CSAT e Métricas Operacionais

Intencionalmente. O Painel CSAT usa `resolved_at_local` e filtra por agentes monitoradas. O CSAT Geral das Métricas usa `created_at_local` e inclui todos os agentes. São indicadores diferentes e os números não devem ser comparados diretamente.

### 8.3 CSAT do Painel vs Métricas Operacionais por agente

O CSAT por agente nas Métricas Operacionais usa `csat_reports` (fonte: `resolved_at_local`), mas o filtro de período das Métricas é sobre `date` do csat_reports, que é a data de resolução. Portanto o CSAT semanal considera tickets resolvidos na semana, mesmo que criados antes. Isso é o comportamento correto, mas pode causar confusão se o usuário esperar que "semana" signifique a mesma coisa para todos os números.

### 8.4 TPR distorcido por transferências

`first_agent_reply_time_min` registra o tempo até a primeira resposta no ticket, atribuído ao agente que o resolveu. Se um ticket foi iniciado por outro agente (ou pela Claudia) e depois transferido, o tempo registrado é o do primeiro respondente, não da agente final. Isso pode inflar significativamente a média de TPR de agentes que recebem tickets transferidos.

**Diagnóstico:** `GET /admin/first-reply-outliers` — lista tickets de um agente ordenados por `first_agent_reply_time_min DESC`. Tickets onde `primeira_resposta_em < criado_em` (data da primeira resposta anterior à criação registrada) são sintomas de reprocessamento/reabertura.

### 8.5 Volume por agente vs respondidos

"Volume" na tabela por agente inclui snoozed com flag seller. "Respondidos" no KPI global conta apenas resolvidos. Os dois números não são o mesmo e não devem ser somados.

### 8.6 Fim de semana e dados ausentes

O cron roda diariamente (incluindo fins de semana), mas as agentes não trabalham nesses dias. Os dias sem dados não aparecem no calendário. A UI da Painel Claudia e de Avaliações por tag usa `_ultimaColetaUtil()` — função JS que retorna a data útil mais recente (exclui sábado e domingo) da lista de datas disponíveis no `summaryMap`.

### 8.7 Cache com TTL de 12h pode servir dados defasados

Se um webhook de indevida chegar e o cache não for invalidado por alguma falha, os dados exibidos podem não refletir a exclusão. O cache é invalidado após qualquer reprocessamento bem-sucedido.

### 8.8 Limite de 2000 tickets por dia no Painel CSAT

`dwQuery` para o Painel CSAT tem `LIMIT 2000`. Dias com mais de 2000 avaliações CSAT terão dados truncados. Em operação normal da INK isso não é atingido.

### 8.9 Labels de tickets limitadas a 1000 por chamada

`getTicketLabels()` usa `limit: 1000` na query Metabase estruturada. Se um conjunto de tickets do dia tiver mais de 1000 labels totais (somando todas as tags de todos os tickets), algumas serão perdidas.

---

## 9. GLOSSÁRIO

| Termo | Significado |
|---|---|
| **TPR** | Tempo de Primeira Resposta (`first_agent_reply_time_min`). Tempo em minutos do horário comercial entre abertura do ticket e primeira mensagem de agente. Calculado e armazenado pelo CloudChat. |
| **TER** | Tempo de Encerramento / Resolução (`first_agent_resolution_time_min`). Tempo em minutos entre abertura e resolução do ticket. |
| **CSAT** | Customer Satisfaction. Avaliação deixada pelo cliente ao final do atendimento, em escala 1-5 (onde 1 = muito insatisfeito, 5 = muito satisfeito). |
| **Positivo** | Avaliação CSAT com nota ≥ 4. |
| **Negativo** | Avaliação CSAT com nota ≤ 3. |
| **Indevida** | Avaliação considerada inválida para fins de métricas (ex: ticket reaberto). Registrada em `csat_indevidas`. |
| **Retenção N1** | Tickets resolvidos pela Claudia (IA) sem escalar para humano. |
| **N1 / N2** | N1 = Claudia resolve. N2 = humano resolve. Não é um campo no banco; é inferido pelo nome do agente de resolução. |
| **Semana** | Dom a Sáb. Âncora = domingo. |
| **Acumulado** | Período fixo de 2026-02-01 até hoje. |
| **Agentes monitoradas** | Mari, Fernanda Cavalcante, Paty, Lu Almeida, Rafa. Exato no DW. |
| **Claudia** | IA de atendimento. Detectada por `agent_on_resolution_name ILIKE '%claudia%' AND NOT ILIKE '%projetos%'`. |
| **`resolved_at_local`** | Timestamp de resolução do ticket, no fuso horário local, campo do DW. |
| **`created_at_local`** | Timestamp de criação do ticket, no fuso horário local, campo do DW. |
| **`first_agent_reply_time_min`** | Minutos de horário comercial até a primeira resposta do agente. Calculado pelo CloudChat. |
| **`first_agent_resolution_time_min`** | Minutos totais entre criação e resolução do ticket. |
| **`aguardando_confirmao_de_resoluo_lojista`** | Campo customizado booleano. `true` = ticket snoozed aguardando seller confirmar resolução. |
| **`display_ticket_id`** | ID visível do ticket (número mostrado na interface do CloudChat). Chave usada para cruzamentos entre tabelas. |
| **`ticket_id`** | ID interno do ticket no banco de dados (diferente do display_ticket_id). |
| **`vol-baixo`** | Classe CSS verde. Boa performance. |
| **`vol-medio`** | Classe CSS amarela. Performance intermediária. |
| **`vol-alto`** | Classe CSS vermelha. Performance ruim. |
| **`support_bi`** | Schema PostgreSQL que contém todas as tabelas do painel. |
| **`dw`** | Schema do Data Warehouse, acessado via Metabase. Tabelas `fact_cloudchat_tickets`, `fact_cloudchat_ticket_labels`, `fact_cloudchat_ticket_custom_fields`. |
| **Metabase** | Ferramenta BI usada como proxy para o DW. Host: `rsv-ink-metabase-f7ef97f28c72.herokuapp.com`. Database ID 2. |
| **`kpis_op_cache`** | Tabela de cache das Métricas Operacionais. TTL 12h. Invalidada a cada cron e reprocessamento. |
| **`csat_reports`** | Tabela principal de dados diários do Painel CSAT. Um registro por dia, conteúdo JSONB. |
| **BRT** | Brasília Time = UTC-3 (sem horário de verão — Brasil aboliu o horário de verão em 2019). |
