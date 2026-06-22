# CSAT Dashboard — INK

## Objetivo
Painel histórico de CSATs negativos, atualizado automaticamente todo dia
útil às 7h da manhã. Os dados ficam salvos permanentemente e podem ser
consultados por data no site.

## Fonte de dados
CloudChat / Explo API (conta 73) — mesmo fluxo de autenticação e consulta
do projeto cloudchat-discord-report.

## Arquitetura
CloudChat/Explo API → Cloudflare Worker (cron diário) → KV → Site Netlify

1. Worker roda às 7h todo dia útil (seg–sex)
2. Autentica no CloudChat e obtém token Explo
3. Consulta o relatório de CSATs negativos do dia útil anterior
4. Calcula métricas (total, por agente, por tag)
5. Salva no KV com chave  csat:YYYY-MM-DD  (nunca sobrescreve)
6. Expõe endpoints GET para o site consumir

## Como executar localmente
  cd worker
  npx wrangler dev

## Como publicar
  cd worker
  npx wrangler deploy

## Estrutura dos arquivos
  CLAUDE.md
  worker/
    wrangler.toml      <- configuração do Worker e KV
    package.json
    src/
      index.js         <- código principal
  site/
    index.html         <- calendário e navegação por mês
    report.html        <- visualização do relatório de um dia
    js/
      app.js           <- busca dados do Worker e monta a tela

## Regras importantes
- Nunca sobrescrever uma chave KV já existente (dados históricos são permanentes)
- Credenciais apenas nos Secrets da Cloudflare — nunca no código
- Usar previousBusinessDate() igual ao projeto de referência
- O Worker busca o dia útil anterior, não o dia atual
- Sem dependência de banco externo — tudo no Worker + KV
- Descoberta do relatório CSAT correto acontece durante implementação do Worker

## Checklist de desenvolvimento
- [ ] Criar Worker base com cron
- [ ] Implementar autenticação CloudChat (igual ao projeto de referência)
- [ ] Identificar e testar o relatório Explo correto para CSAT
- [ ] Salvar JSON no KV por data
- [ ] Endpoint GET /data/:date  (retorna dados de um dia)
- [ ] Endpoint GET /index  (retorna lista de datas disponíveis)
- [ ] Construir site (calendário por mês)
- [ ] Conectar site ao Worker
- [ ] Deploy e teste end-to-end
