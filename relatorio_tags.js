// Relatório de tempos por grupo de tag — Abr/Jun 2026
// Uso: node relatorio_tags.js

const BASE = 'https://gestao-sup-ink-709a6d9e0c6b.herokuapp.com';
const KEY  = 'ink-admin-2026';

function fmt(h) {
  if (h === null || h === undefined || isNaN(h) || Number(h) < 0) return '—';
  const totalMin = Math.round(Number(h) * 60);
  if (totalMin < 60) return totalMin + 'min';
  const hrs = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? hrs + 'h' : hrs + 'h' + min + 'min';
}

function fmtMin(m) {
  if (m === null || m === undefined || isNaN(m) || Number(m) < 0) return '—';
  const totalMin = Math.round(Number(m));
  if (totalMin < 60) return totalMin + 'min';
  const hrs = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? hrs + 'h' : hrs + 'h' + min + 'min';
}

async function main() {
  const statusR = await fetch(`${BASE}/admin/reply-times-status?key=${KEY}`);
  const status  = await statusR.json();
  const job = status.job || {};

  if (job.running) {
    const pct = job.total > 0 ? Math.round(job.processed / job.total * 100) : 0;
    console.log(`\nJob em andamento: ${job.processed}/${job.total} (${pct}%) — ${job.errors} erros`);
    console.log('Aguarde e rode novamente.\n');
    return;
  }

  console.log(`\nBanco: ${status.db_count} tickets\n`);

  const repR = await fetch(`${BASE}/admin/report-tag-times?key=${KEY}&from=2026-04-01&to=2026-07-01`);
  const rep  = await repR.json();

  if (!rep.rows || !rep.rows.length) {
    console.log('Sem dados. Inicie o job primeiro.\n');
    return;
  }

  const rows = rep.rows.filter(r => Number(r.tickets) >= 30);

  // ── Tabela principal: mediana vs media ────────────────────────────────────
  console.log('PERIODO: Abr-Jun 2026\n');

  const W1 = { g: 22, t: 9, r: 22, s: 12, e: 22, c: 14 };
  console.log(
    'GRUPO'.padEnd(W1.g) +
    'TICKETS'.padStart(W1.t) +
    '1a RESP (med/avg)'.padStart(W1.r) +
    'SUBSEQ'.padStart(W1.s) +
    'FECHAMENTO (med/avg)'.padStart(W1.e) +
    '(c/ subseq)'.padStart(W1.c)
  );
  console.log('-'.repeat(W1.g + W1.t + W1.r + W1.s + W1.e + W1.c));

  rows.forEach(r => {
    const respCell = fmt(r.med_1a_resp_h) === fmt(r.media_1a_resp_h)
      ? fmt(r.med_1a_resp_h)
      : `${fmt(r.med_1a_resp_h)} / ${fmt(r.media_1a_resp_h)}`;
    const encCell = fmt(r.med_fechamento_h) === fmt(r.media_fechamento_h)
      ? fmt(r.med_fechamento_h)
      : `${fmt(r.med_fechamento_h)} / ${fmt(r.media_fechamento_h)}`;
    console.log(
      r.grupo.padEnd(W1.g) +
      String(r.tickets).padStart(W1.t) +
      respCell.padStart(W1.r) +
      fmtMin(r.media_subseq_min).padStart(W1.s) +
      encCell.padStart(W1.e) +
      `(${r.tickets_com_subseq || 0}/${r.tickets})`.padStart(W1.c)
    );
  });

  console.log('\n* 1a RESP / FECHAMENTO: mediana / media (exibido apenas quando diferentes)');
  console.log('* SUBSEQ = tempo entre msg do seller e resposta da agente (apos 1a resposta)');

  // ── Sugestão de SLA (P75) ─────────────────────────────────────────────────
  console.log('\n\n=== SUGESTAO DE SLA (P75) ===');
  console.log('75% dos tickets ficam abaixo desses tempos.\n');

  const W2 = { g: 22, t: 9, r: 14, e: 16 };
  console.log(
    'GRUPO'.padEnd(W2.g) +
    'TICKETS'.padStart(W2.t) +
    'SLA 1a RESP'.padStart(W2.r) +
    'SLA FECHAMENTO'.padStart(W2.e)
  );
  console.log('-'.repeat(W2.g + W2.t + W2.r + W2.e));

  rows
    .filter(r => r.p75_1a_resp_h !== null || r.p75_fechamento_h !== null)
    .sort((a, b) => Number(a.p75_1a_resp_h) - Number(b.p75_1a_resp_h))
    .forEach(r => {
      console.log(
        r.grupo.padEnd(W2.g) +
        String(r.tickets).padStart(W2.t) +
        fmt(r.p75_1a_resp_h).padStart(W2.r) +
        fmt(r.p75_fechamento_h).padStart(W2.e)
      );
    });

  console.log('\n* Grupos com menos de 30 tickets omitidos');
  console.log('* zoop e integracoes podem ter SLA proprio por serem tickets tecnicos\n');
}

main().catch(console.error);
