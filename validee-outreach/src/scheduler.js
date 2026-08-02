const cron = require('node-cron');
const { runSender, isWithinSendingWindow } = require('./sender');

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

  console.log('Scheduler iniciado. Verificando a cada 15 minutos se estamos dentro de uma janela de envio permitida.');

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
