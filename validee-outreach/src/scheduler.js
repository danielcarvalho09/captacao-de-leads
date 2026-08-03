const cron = require('node-cron');
const { runSender, isWithinSendingWindow } = require('./sender');
const { maybeAutoScrape } = require('./auto-scrape');

async function runOnce() {
  try {
    await runSender();
  } catch (err) {
    console.error('Erro ao rodar o sender:', err.message);
  }
}

let started = false;

// Verifica a cada 15 minutos se esta dentro de uma janela de envio permitida
// e, se estiver, roda o sender. Usado tanto pelo CLI (`--schedule`) quanto
// pelo painel web quando ENABLE_SCHEDULER=true, para nao duplicar o processo
// de cron em cada lugar que precisa dele.
function startScheduler() {
  if (started) {
    return;
  }
  started = true;

  console.log('Scheduler iniciado: disparo a cada 15 min (dentro da janela) e captacao automatica a cada hora (se a fila zerar).');

  // Captacao automatica: de hora em hora verifica se a fila de leads zerou e,
  // se zerou, busca a proxima combinacao nicho/cidade da fila no Apify. Todos
  // os guardrails (cooldown, teto de custo, fila) ficam no auto-scrape.js.
  cron.schedule('0 * * * *', async () => {
    try {
      const r = await maybeAutoScrape();
      if (r.ran) {
        console.log(`[auto-scrape] Captacao automatica trouxe ${r.added} leads novos.`);
      }
    } catch (err) {
      console.error('[auto-scrape] Erro inesperado:', err.message);
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    const now = new Date();
    console.log(`[${now.toLocaleString('pt-BR')}] Verificando janela de envio...`);
    if (!isWithinSendingWindow(now)) {
      console.log('Fora da janela. Aguardando proxima verificacao.');
      return;
    }
    await runOnce();
  });
}

module.exports = { startScheduler };
