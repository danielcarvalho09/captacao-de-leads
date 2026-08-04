const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
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

// O Chrome grava SingletonLock/SingletonCookie/SingletonSocket no perfil com
// o hostname da maquina. Num container isso vira armadilha: se o container e
// morto sem shutdown limpo (deploy, restart, OOM), o lock fica no volume
// persistente e o container seguinte — que tem outro hostname — se recusa a
// abrir com "The profile appears to be in use by another Chromium process ...
// on another computer".
// Como no nosso caso so existe um processo usando este perfil, um lock
// encontrado no boot e sempre orfao e pode ser removido com seguranca.
function limparLockOrfaoDoChrome() {
  const base = path.resolve(process.cwd(), '.wwebjs_auth');
  if (!fs.existsSync(base)) {
    return;
  }

  const arquivosDeLock = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  let removidos = 0;

  const varrer = (dir) => {
    for (const nome of arquivosDeLock) {
      const alvo = path.join(dir, nome);
      try {
        // lstat, nao existsSync: SingletonLock e um symlink que aponta para um
        // host/PID que nao existe mais, entao existsSync devolveria false.
        fs.lstatSync(alvo);
        fs.unlinkSync(alvo);
        removidos += 1;
      } catch (err) {
        // nao existe (ou ja foi removido): nada a fazer
      }
    }
  };

  varrer(base);
  for (const entrada of fs.readdirSync(base)) {
    const sub = path.join(base, entrada);
    try {
      if (fs.statSync(sub).isDirectory()) {
        varrer(sub);
      }
    } catch (err) {
      // ignora entradas ilegiveis
    }
  }

  if (removidos) {
    console.log(`Removido(s) ${removidos} lock(s) orfao(s) do Chrome deixado(s) por um container anterior.`);
  }
}

function buildClient() {
  limparLockOrfaoDoChrome();

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

    // Mensagem mais clara para o erro classico de lock preso apos um deploy
    // que matou o container sem o Chrome ter fechado direito.
    const mensagem = /profile appears to be in use/i.test(err.message)
      ? 'O perfil do Chrome ficou marcado como em uso por outro processo (sobra de um deploy anterior). Clique em Conectar de novo — a proxima tentativa remove o trava automaticamente.'
      : err.message;

    setState({ status: 'error', qr: null, message: mensagem, info: null });
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

// Numa VPS o processo reinicia a cada deploy/restart e o estado volta para
// "disconnected" ate alguem clicar em "Conectar" no painel — o que na pratica
// deixava o disparo automatico parado sem ninguem perceber. Se a sessao salva
// existe em disco (volume .wwebjs_auth), reconectamos sozinhos no boot, sem
// pedir QR. Se nao existe, nao fazemos nada: abrir o Chrome so para gerar um
// QR que ninguem esta olhando seria desperdicio de RAM.
function hasSavedSession() {
  const dataPath = path.resolve(process.cwd(), '.wwebjs_auth');
  try {
    return fs.readdirSync(dataPath).some((entry) => entry.startsWith('session'));
  } catch (err) {
    return false;
  }
}

function autoConnectIfSessionExists() {
  if (!hasSavedSession()) {
    console.log('Nenhuma sessao do WhatsApp salva. Abra /whatsapp.html e clique em Conectar para escanear o QR.');
    return false;
  }
  console.log('Sessao do WhatsApp encontrada em disco. Reconectando automaticamente...');
  connect();
  return true;
}

// O estado interno pode dizer "ready" enquanto a sessao ja morreu por baixo
// (Chrome derrubado, celular deslogado, rede caida) — o painel mostraria
// "conectado" e o disparo falharia so na hora do envio. Estas duas funcoes
// perguntam ao cliente de verdade, em vez de confiar no estado guardado.

function comTimeout(promise, ms, mensagem) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(mensagem)), ms)),
  ]);
}

// Verificacao leve: NAO envia mensagem nenhuma. Pergunta o estado real da
// conexao ao whatsapp-web.js.
async function healthCheck() {
  if (!clientInstance) {
    return { ok: false, motivo: 'sem-cliente', detalhe: 'Nenhuma sessao iniciada. Clique em Conectar.' };
  }
  if (state.status !== 'ready') {
    return { ok: false, motivo: 'nao-pronto', detalhe: `Sessao em estado "${state.status}".` };
  }

  try {
    const estadoReal = await comTimeout(
      clientInstance.getState(),
      15000,
      'O WhatsApp nao respondeu em 15s (sessao provavelmente travada).'
    );
    const ok = estadoReal === 'CONNECTED';
    return {
      ok,
      estadoReal,
      info: state.info,
      detalhe: ok
        ? 'Sessao ativa e respondendo.'
        : `O WhatsApp respondeu "${estadoReal}" em vez de CONNECTED.`,
    };
  } catch (err) {
    return { ok: false, motivo: 'sem-resposta', detalhe: err.message };
  }
}

// Teste de ponta a ponta: envia uma mensagem real para o numero informado.
// Nao passa pelo sender — nao mexe no leads.csv, no log de envios nem na
// cota diaria. E so um teste de conexao.
async function sendTestMessage(numeroDigits, texto) {
  if (!clientInstance || state.status !== 'ready') {
    throw new Error('WhatsApp nao esta conectado. Conecte antes de testar.');
  }

  const numberId = await comTimeout(
    clientInstance.getNumberId(numeroDigits),
    20000,
    'O WhatsApp nao respondeu ao verificar o numero (20s).'
  );
  if (!numberId) {
    throw new Error(`O numero ${numeroDigits} nao tem WhatsApp (ou esta em formato invalido).`);
  }

  await comTimeout(
    clientInstance.sendMessage(numberId._serialized, texto),
    30000,
    'O envio da mensagem de teste passou de 30s sem confirmar.'
  );

  return { enviadoPara: numeroDigits };
}

module.exports = {
  getClient,
  destroyClient,
  connect,
  logout,
  getState,
  onStateChange,
  hasSavedSession,
  autoConnectIfSessionExists,
  healthCheck,
  sendTestMessage,
};
