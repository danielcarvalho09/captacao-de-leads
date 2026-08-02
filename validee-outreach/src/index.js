#!/usr/bin/env node
require('dotenv').config();
const { runSender } = require('./sender');
const { destroyClient } = require('./whatsapp');
const { startScheduler } = require('./scheduler');

function printUsage() {
  console.log('Uso:');
  console.log('  node src/index.js --now       Dispara a fila agora (so envia se estiver dentro da janela permitida)');
  console.log('  node src/index.js --schedule  Sobe um processo que verifica a cada 15 min e dispara dentro da janela');
}

async function runOnce() {
  try {
    await runSender();
  } catch (err) {
    console.error('Erro ao rodar o sender:', err.message);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--now')) {
    await runOnce();
    await destroyClient();
    process.exit(0);
  } else if (args.includes('--schedule')) {
    startScheduler();
    // Erros de conexao do WhatsApp (sessao caiu, QR expirou, etc.) nao devem
    // derrubar o processo do scheduler: apenas logamos e seguimos rodando.
    process.on('unhandledRejection', (err) => {
      console.error('Erro nao tratado (unhandledRejection):', err);
    });
    process.on('uncaughtException', (err) => {
      console.error('Erro nao tratado (uncaughtException):', err);
    });
  } else {
    printUsage();
    process.exit(1);
  }
}

main();
