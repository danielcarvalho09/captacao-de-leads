const EventEmitter = require('events');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

let clientInstance = null;
let readyPromise = null;

const emitter = new EventEmitter();
let state = { status: 'disconnected', qr: null, message: null, info: null };

function setState(partial) {
  state = { ...state, ...partial };
  emitter.emit('change', state);
}

function getState() {
  return state;
}

// callback(state) chamado a cada mudanca. Retorna funcao para cancelar a inscricao.
function onStateChange(callback) {
  emitter.on('change', callback);
  return () => emitter.off('change', callback);
}

function buildClient() {
  const client = new Client({
    authStrategy: new LocalAuth(),
    // --disable-dev-shm-usage evita crash do Chrome em containers Docker,
    // onde o /dev/shm padrao (64MB) e pequeno demais.
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
  });

  client.on('qr', (qr) => {
    console.log('\nEscaneie o QR code abaixo no WhatsApp (Aparelhos conectados > Conectar aparelho):\n');
    qrcodeTerminal.generate(qr, { small: true });
    setState({ status: 'qr', qr, message: null, info: null });
  });

  client.on('authenticated', () => {
    console.log('Sessao do WhatsApp autenticada.');
    setState({ status: 'authenticated', qr: null, message: null, info: null });
  });

  client.on('ready', () => {
    console.log('Cliente do WhatsApp pronto para enviar mensagens.');
    const info = client.info
      ? { name: client.info.pushname || null, number: client.info.wid?.user || null }
      : null;
    setState({ status: 'ready', qr: null, message: null, info });
  });

  client.on('auth_failure', (msg) => {
    console.error('Falha de autenticacao do WhatsApp:', msg);
    setState({ status: 'auth_failure', qr: null, message: msg, info: null });
  });

  // Nao derrubamos o processo aqui: apenas limpamos o singleton para que a
  // proxima chamada a getClient()/connect() recrie a sessao (o node-cron
  // e o painel web continuam rodando normalmente).
  client.on('disconnected', (reason) => {
    console.warn(`WhatsApp desconectado (${reason}). Sera necessario reconectar na proxima tentativa de envio.`);
    clientInstance = null;
    readyPromise = null;
    setState({ status: 'disconnected', qr: null, message: reason, info: null });
  });

  return client;
}

function startClient() {
  clientInstance = buildClient();

  readyPromise = new Promise((resolve, reject) => {
    clientInstance.once('ready', () => resolve(clientInstance));
    clientInstance.once('auth_failure', (msg) => {
      reject(new Error(`Falha de autenticacao do WhatsApp: ${msg}`));
    });
  });

  setState({ status: 'starting', qr: null, message: null, info: null });

  clientInstance.initialize().catch((err) => {
    console.error('Erro ao inicializar cliente do WhatsApp:', err.message);
    clientInstance = null;
    readyPromise = null;
    setState({ status: 'error', qr: null, message: err.message, info: null });
  });
}

// Inicia a conexao se ainda nao houver uma em andamento. Idempotente: pode
// ser chamada a qualquer momento (ex: botao "Conectar" do painel web) sem
// medo de abrir duas sessoes.
function connect() {
  if (!clientInstance) {
    startClient();
  }
  return getState();
}

// Retorna uma Promise que resolve com o client ja pronto (sessao autenticada).
// Reutiliza a mesma sessao/instancia entre chamadas de outros modulos.
function getClient() {
  if (!clientInstance) {
    startClient();
  }
  return readyPromise;
}

// Encerra a sessao do puppeteer se um client tiver sido criado, sem apagar a
// sessao salva localmente. Usado pelo CLI no modo --now para nao deixar um
// processo do Chromium orfao depois do disparo (o proximo connect() reusa a
// sessao salva, sem pedir QR de novo).
async function destroyClient() {
  if (clientInstance) {
    try {
      await clientInstance.destroy();
    } catch (err) {
      console.warn('Erro ao encerrar client do WhatsApp:', err.message);
    }
    clientInstance = null;
    readyPromise = null;
  }
}

// Desconecta de verdade (logout) e apaga a sessao salva, para o usuario poder
// conectar outro numero. Usado pelo botao "Desconectar" do painel web.
async function logout() {
  if (clientInstance) {
    try {
      await clientInstance.logout();
    } catch (err) {
      console.warn('Erro ao fazer logout do WhatsApp:', err.message);
    }
    try {
      await clientInstance.destroy();
    } catch (err) {
      // client.logout() ja pode ter destruido o browser; ignoramos erro aqui.
    }
  }
  clientInstance = null;
  readyPromise = null;
  setState({ status: 'disconnected', qr: null, message: null, info: null });
}

module.exports = {
  getClient,
  destroyClient,
  connect,
  logout,
  getState,
  onStateChange,
};
