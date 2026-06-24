# Painel de Gestão — INK

Painel interno de métricas de suporte: CSAT, KPIs operacionais e monitoramento da IA Claudia.

## Stack

- **Backend:** Node.js / Express no Heroku
- **Banco:** PostgreSQL (Heroku Postgres)
- **Frontend:** HTML/CSS/JS estático servido pelo próprio Express
- **Dados:** Metabase API (DW) + `support_bi` schema no PostgreSQL

## Arquitetura

```
Metabase API (DW) ──► server.js (Heroku) ──► PostgreSQL ──► site estático
                           │
                      cron 7h seg–sex
```

O cron roda todo dia útil às 7h, busca as avaliações do dia anterior no DW via Metabase API, processa e salva em `support_bi.csat_reports`.

## Páginas

| Arquivo | URL | Descrição |
|---|---|---|
| `site/gerencial.html` | `/gerencial` | Painel principal (3 abas) |
| `site/report.html` | `/report?date=YYYY-MM-DD` | Relatório de um dia |
| `site/index.html` | `/` | Redireciona para `/gerencial` |
| `site/login.html` | `/login` | Login |
| `site/forgot-password.html` | `/forgot-password` | Esqueci minha senha |
| `site/reset-password.html` | `/reset-password` | Criar nova senha |
| `site/register.html` | `/register` | Criar conta |

## Abas do painel principal

**Métricas Operacionais** — backlog, encerrados, adiados, CSAT, retenção N1, tempo de resposta por agente. Filtros: Dia / Semana / Mês / Período.

**Painel CSAT** — calendário com satisfação % por dia, ranking por agente, negativos e positivos, avaliações indevidas.

**Painel Claudia** — KPIs da IA Claudia (tickets, CSAT, retenção N1), lista de tickets com notas e feedbacks. Filtros independentes: Dia / Semana / Mês / Período.

## Agentes monitoradas (CSAT)

Mari, Fernanda (Fer), Paty, Lu Almeida, Rafa

Claudia - Projetos Especiais é excluída de todos os cálculos.

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/summary` | Lista de datas com totais |
| GET | `/data/:date` | JSON completo de um dia |
| GET | `/gestao` | Agregados por semana e mês (90 dias) |
| GET | `/last-update` | Data e hora da última atualização |
| GET | `/kpis-op` | Métricas operacionais (cache 12h) |
| GET | `/backlog-tickets` | Tickets em aberto/pendente |
| GET | `/indevidas-resumo` | Todas as avaliações indevidas |
| POST | `/webhook/csat-invalida` | Webhook CloudChat para indevidas |
| GET | `/run?date=&force=` | Reprocessar um dia manualmente |
| GET | `/admin/clear-ops-cache?key=` | Limpar cache de métricas operacionais |

## Executar localmente

```bash
node server.js
```

Requer variáveis de ambiente (Config Vars no Heroku):
- `DATABASE_URL` — PostgreSQL
- `SESSION_TOKEN` — Metabase
- `ADMIN_KEY` — chave para endpoints admin

## Deploy

```powershell
$env:PATH += ";C:\Program Files\Git\cmd"
git add -A
git commit -m "mensagem"
git push heroku master
```

## Reprocessar data histórica

```
https://gestao-sup-ink-709a6d9e0c6b.herokuapp.com/run?date=YYYY-MM-DD&force=true
```

## Limpar cache de métricas operacionais

```
https://gestao-sup-ink-709a6d9e0c6b.herokuapp.com/admin/clear-ops-cache?key=ink-admin-2026
```

## Banco de dados

| Tabela | Uso |
|---|---|
| `support_bi.csat_reports` | Avaliações CSAT por dia (JSONB) |
| `support_bi.csat_indevidas` | Avaliações marcadas como indevidas |
| `support_bi.kpis_op_cache` | Cache das métricas operacionais (TTL 12h) |
| `dw.fact_cloudchat_tickets` | Tickets do DW (somente leitura via Metabase API) |
