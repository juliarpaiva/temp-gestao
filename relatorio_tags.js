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

// avg / med em célula única, ex: "2h44 / 2h10"
function cell(avg, med, w) {
  const a = fmt(avg), m = fmt(med);
  const s = a === m ? a : `${a} / ${m}`;
  return s.padStart(w);
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

  // larguras
  const W = { grupo: 22, tkt: 9, resp: 20, subseq: 12, enc: 20, csub: 14 };
  const sep = '-'.repeat(W.grupo + W.tkt + W.resp + W.subseq + W.enc + W.csub);

  console.log('PERIODO: Abr-Jun 2026\n');
  console.log(
    'GRUPO'.padEnd(W.grupo) +
    'TICKETS'.padStart(W.tkt) +
    '1a RESP (avg/med)'.padStart(W.resp) +
    'SUBSEQ'.padStart(W.subseq) +
    'FECHAMENTO (avg/med)'.padStart(W.enc) +
    '(c/ subseq)'.padStart(W.csub)
  );
  console.log(sep);

  rows.forEach(r => {
    console.log(
      r.grupo.padEnd(W.grupo) +
      String(r.tickets).padStart(W.tkt) +
      cell(r.media_1a_resp_h, r.med_1a_resp_h, W.resp) +
      fmtMin(r.media_subseq_min).padStart(W.subseq) +
      cell(r.media_fechamento_h, r.med_fechamento_h, W.enc) +
      `(${r.tickets_com_subseq || 0}/${r.tickets})`.padStart(W.csub)
    );
  });

  console.log('\n* 1a RESP e FECHAMENTO: media / mediana (quando diferentes)');
  console.log('* SUBSEQ = tempo entre msg do seller e resposta da agente (apos 1a resposta)');
  console.log('* Grupos com menos de 30 tickets omitidos\n');
}

main().catch(console.error);
