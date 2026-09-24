# CSAT Dashboard — INK

## Objetivo
Painel histórico de todas as avaliações CSAT (positivas e negativas),
atualizado automaticamente todo dia útil às 7h da manhã. Os dados ficam
salvos permanentemente e podem ser consultados por data no site.

## Fonte de dados
Metabase HTTP API (DB 2, tabelas tickets 7375 e labels 7376) —
autenticação via SESSION_TOKEN em variável de ambiente no Heroku.

## Arquitetura
Metabase API → Node/Express no Heroku (cron diário) → PostgreSQL (support_bi.csat_reports) → Site estático (Netlify)

1. Cron roda às 7h todo dia útil (seg–sex) via `node-cron`
2. Autentica no Metabase e busca TODAS as avaliações CSAT do dia útil anterior (sem filtro de nota)
3. Separa: avaliados negativos (nota ≤ 3) e positivos (nota ≥ 4)
4. Filtra para agentes monitoradas: Mari, Fernanda (Fer), Paty, Lu Almeida, Rafa, Natchely
5. Busca tags de todos os tickets (negativos + positivos das monitoradas)
6. Calcula métricas e salva no PostgreSQL com chave `date` (nunca sobrescreve)
7. Expõe endpoints GET para o site consumir

## Agentes monitoradas
Mari, Fernanda (Fer), Paty, Lu Almeida, Rafa, Natchely — todas as demais agentes
são excluídas dos dados por agente (mas contam nos totais globais).

## Dados salvos por dia (JSONB na coluna `data`)
- `total` — negativos das monitoradas
- `total_recebidos` — total de tickets com nota, todas as agentes
- `total_avaliados` — avaliações das monitoradas (pos + neg)
- `total_positivos` — positivos das monitoradas
- `por_agente` — negativos por agente monitorada
- `por_agente_positivos` — positivos por agente monitorada
- `tickets` — array de tickets negativos com tags
- `tickets_positivos` — array de tickets positivos com tags

## Como executar localmente
  node server.js

## Como publicar
  $env:PATH += ";C:\Program Files\Git\cmd"
  git add -A
  git commit -m "mensagem"
  git push heroku master

## Reprocessar data histórica
  Acesse: https://gestao-sup-ink-709a6d9e0c6b.herokuapp.com/run?date=YYYY-MM-DD&force=true

## Estrutura dos arquivos
  CLAUDE.md
  server.js           <- API Node/Express + cron
  Procfile            <- web: node server.js
  package.json
  site/
    index.html        <- calendário + filtro por período
    report.html       <- relatório de um dia (tabs Positivas/Negativas por agente)
    gerencial.html    <- painel de gestão (ranking satisfação + monitoramento negativos + notas de reunião)

## Regras importantes
- Nunca sobrescrever uma data já existente no PostgreSQL sem `force=true`
- Credenciais apenas nos Config Vars do Heroku — nunca no código
- Usar `previousBusinessDate()` para buscar o dia útil anterior
- `getAllCsats()` busca sem filtro de nota (limit 2000) — separação pos/neg é feita no servidor
- "Recebidas" no report.html = apenas tickets das agentes monitoradas (neg + pos das monitoradas)
- Tabs em report.html: Positivas primeiro (padrão), Negativas segundo
- Satisfação % = positivos / (positivos + negativos) por agente

## Checklist de desenvolvimento
- [x] Cron diário no Heroku
- [x] Autenticação Metabase
- [x] Busca de todas as avaliações (pos + neg)
- [x] Filtro por agentes monitoradas
- [x] Tags para tickets negativos e positivos
- [x] Salvar JSON no PostgreSQL por data
- [x] Endpoint GET /data/:date
- [x] Endpoint GET /summary (lista de datas + métricas)
- [x] Endpoint GET /gestao (dados agregados por semana e mês)
- [x] Calendário com satisfação % por cor
- [x] Filtro de período em index.html
- [x] report.html com tabs por agente (Positivas/Negativas)
- [x] gerencial.html com ranking de satisfação + monitoramento de negativos + notas de reunião
- [x] Deploy e teste end-to-end
