require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

const whatsapp = require('../whatsapp');
const settings = require('../settings');
const apifyConfig = require('../apify-config');
const { fetchApifyUsage } = require('../apify-usage');
const { computeReport } = require('../reports');
const { scrapeLeads } = require('../scraper');
const { startScheduler } = require('../scheduler');
const { runSender, isWithinSendingWindow } = require('../sender');
const { seedConfigDir } = require('../bootstrap');
const { normalizePhone } = require('../phone');
const autoScrape = require('../auto-scrape');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const {
  MESSAGE_TEMPLATE_PATH = 'config/message-template.txt',
  PORT = '3000',
  DASHBOARD_USER,
  DASHBOARD_PASSWORD,
  ENABLE_SCHEDULER,
} = process.env;
const TEMPLATE_PATH = path.resolve(process.cwd(), MESSAGE_TEMPLATE_PATH);

function safeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual exige buffers do mesmo tamanho; sem isso um usuario nao
  // autorizado poderia inferir o tamanho da senha certa pelo tempo de resposta.
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// So exige login se DASHBOARD_USER/DASHBOARD_PASSWORD estiverem definidos no
// .env. Sem isso o painel fica aberto (uso local, ex: seu Mac). Em qualquer
// VPS/servidor exposto a internet, esses dois valores sao obrigatorios.
function requireAuth(req, res, next) {
  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
    next();
    return;
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const user = decoded.slice(0, separatorIndex);
    const pass = decoded.slice(separatorIndex + 1);
    if (safeCompare(user, DASHBOARD_USER) && safeCompare(pass, DASHBOARD_PASSWORD)) {
      next();
      return;
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Validee Outreach"');
  res.status(401).send('Autenticacao necessaria.');
}

// Precisa rodar antes de servir qualquer request: garante que o volume
// persistente tenha os arquivos-semente (template da mensagem etc).
seedConfigDir();

const app = express();
app.use(requireAuth);
// 10mb: o corpo do restore leva o leads.csv e o log de envios inteiros,
// que passam facil dos 100kb padrao do express.
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- WhatsApp ---

app.get('/api/whatsapp/state', async (req, res) => {
  const state = whatsapp.getState();
  const qrDataUrl = state.qr ? await QRCode.toDataURL(state.qr) : null;
  res.json({ ...state, qrDataUrl });
});

app.post('/api/whatsapp/connect', (req, res) => {
  const state = whatsapp.connect();
  res.json(state);
});

app.post('/api/whatsapp/logout', async (req, res) => {
  await whatsapp.logout();
  res.json(whatsapp.getState());
});

// --- Teste da conexao do WhatsApp ---

app.post('/api/whatsapp/health', async (req, res) => {
  try {
    res.json(await whatsapp.healthCheck());
  } catch (err) {
    res.status(500).json({ ok: false, detalhe: err.message });
  }
});

app.post('/api/whatsapp/test-message', async (req, res) => {
  try {
    const { numero } = req.body || {};
    const estado = whatsapp.getState();

    // Checa a conexao ANTES do numero: se o WhatsApp esta fora do ar, dizer
    // "informe um numero" mandaria o usuario resolver o problema errado.
    if (estado.status !== 'ready') {
      res.status(409).json({
        error: `WhatsApp nao esta conectado (estado atual: "${estado.status}"). Conecte antes de testar.`,
      });
      return;
    }

    // Sem numero informado, manda para o proprio numero conectado: e o teste
    // mais seguro possivel, nao incomoda ninguem.
    const alvo = normalizePhone(numero || (estado.info && estado.info.number) || '');
    if (!alvo) {
      res.status(400).json({ error: 'Informe um numero para o teste.' });
      return;
    }

    const agora = new Date().toLocaleString('pt-BR');
    const texto = `[Validee] Teste de conexao do sistema de prospeccao — ${agora}. Se voce recebeu isto, o disparo esta funcionando.`;

    const r = await whatsapp.sendTestMessage(alvo, texto);
    res.json({ ok: true, ...r, texto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Copy (template da mensagem) ---

app.get('/api/template', (req, res) => {
  const content = fs.existsSync(TEMPLATE_PATH) ? fs.readFileSync(TEMPLATE_PATH, 'utf8') : '';
  res.json({ content });
});

app.post('/api/template', (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    res.status(400).json({ error: 'A mensagem nao pode ficar vazia.' });
    return;
  }
  fs.mkdirSync(path.dirname(TEMPLATE_PATH), { recursive: true });
  fs.writeFileSync(TEMPLATE_PATH, `${content.trim()}\n`, 'utf8');
  res.json({ ok: true });
});

// --- Configuracoes de disparo (limite diario, delay, janelas) ---

app.get('/api/settings', (req, res) => {
  res.json({ settings: settings.loadSettings(), guardrails: settings.GUARDRAILS });
});

app.post('/api/settings', (req, res) => {
  try {
    const updated = settings.saveSettings(req.body || {});
    res.json({ settings: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Configuracao da conta Apify (token, actor, parametros de busca) ---

app.get('/api/apify/config', (req, res) => {
  res.json({
    config: apifyConfig.getPublicConfig(),
    guardrails: { maxLeads: apifyConfig.MAX_LEADS_BOUNDS, rating: apifyConfig.RATING_BOUNDS },
  });
});

app.post('/api/apify/config', (req, res) => {
  try {
    apifyConfig.saveConfig(req.body || {});
    res.json({ config: apifyConfig.getPublicConfig(), saved: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Uso da conta Apify ---

app.get('/api/apify/usage', async (req, res) => {
  try {
    const usage = await fetchApifyUsage();
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Rodar o scraper direto do painel (chamada real ao Apify, sem dados simulados) ---

app.post('/api/scraper/run', async (req, res) => {
  try {
    const result = await scrapeLeads();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Relatorios (resultados dos disparos) ---

app.get('/api/reports', (req, res) => {
  try {
    res.json(computeReport());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Leads (lista de captados) ---

app.get('/api/leads', (req, res) => {
  try {
    const leadsPath = path.resolve(process.cwd(), process.env.LEADS_CSV_PATH || 'config/leads.csv');
    if (!fs.existsSync(leadsPath)) {
      res.json({ leads: [], total: 0, porStatus: { pendente: 0, enviado: 0, erro: 0 } });
      return;
    }
    // csv-parse (nao split(',')): os enderecos do Google Maps vem entre aspas
    // e cheios de virgulas, entao um split ingenuo embaralha as colunas.
    const leads = parse(fs.readFileSync(leadsPath, 'utf8'), { columns: true, skip_empty_lines: true });
    const porStatus = leads.reduce(
      (acc, lead) => {
        const status = lead.status || 'pendente';
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      },
      { pendente: 0, enviado: 0, erro: 0 }
    );
    res.json({ leads, total: leads.length, porStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Backup / restauracao dos dados ---
// Leads e log de envios sao dados gerados: nao cabem em variavel de ambiente e
// nao vao para o git. Sem volume persistente eles somem a cada deploy — e o
// log sumir e o pior caso, porque e ele que impede mandar mensagem repetida.
// Estas rotas dao uma rede de seguranca manual enquanto isso.

function lerCsvSeExistir(relativo) {
  const caminho = path.resolve(process.cwd(), relativo);
  return fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf8') : '';
}

app.get('/api/backup', (req, res) => {
  try {
    res.json({
      geradoEm: new Date().toISOString(),
      leadsCsv: lerCsvSeExistir(process.env.LEADS_CSV_PATH || 'config/leads.csv'),
      logEnviosCsv: lerCsvSeExistir(process.env.LOG_CSV_PATH || 'config/log-envios.csv'),
      messageTemplate: lerCsvSeExistir(MESSAGE_TEMPLATE_PATH),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backup/restore', (req, res) => {
  try {
    const { leadsCsv, logEnviosCsv } = req.body || {};
    if (!leadsCsv && !logEnviosCsv) {
      res.status(400).json({ error: 'O arquivo de backup nao tem leads nem log de envios.' });
      return;
    }

    const resumo = {};

    // O log e restaurado inteiro: ele so cresce, e quanto mais completo,
    // melhor a protecao contra reenvio.
    if (logEnviosCsv) {
      const caminho = path.resolve(process.cwd(), process.env.LOG_CSV_PATH || 'config/log-envios.csv');
      fs.mkdirSync(path.dirname(caminho), { recursive: true });
      fs.writeFileSync(caminho, logEnviosCsv, 'utf8');
      resumo.logRestaurado = parse(logEnviosCsv, { columns: true, skip_empty_lines: true }).length;
    }

    if (leadsCsv) {
      const caminho = path.resolve(process.cwd(), process.env.LEADS_CSV_PATH || 'config/leads.csv');
      const doBackup = parse(leadsCsv, { columns: true, skip_empty_lines: true });
      const atuais = fs.existsSync(caminho)
        ? parse(fs.readFileSync(caminho, 'utf8'), { columns: true, skip_empty_lines: true })
        : [];

      // Merge por telefone normalizado. Na duvida entre "pendente" e
      // "enviado", vence "enviado": e sempre mais seguro deixar de mandar
      // para alguem do que mandar duas vezes.
      const porTelefone = new Map();
      const juntar = (lead) => {
        const chave = normalizePhone(lead.telefone);
        if (!chave) return;
        const existente = porTelefone.get(chave);
        if (!existente) {
          porTelefone.set(chave, { ...lead, telefone: chave });
          return;
        }
        const jaContatado = existente.status === 'enviado' || lead.status === 'enviado';
        porTelefone.set(chave, {
          ...existente,
          status: jaContatado ? 'enviado' : existente.status,
          atualizado_em: existente.atualizado_em || lead.atualizado_em || '',
        });
      };
      atuais.forEach(juntar);
      doBackup.forEach(juntar);

      const merged = [...porTelefone.values()];
      fs.mkdirSync(path.dirname(caminho), { recursive: true });
      fs.writeFileSync(
        caminho,
        stringify(merged, { header: true, columns: ['nome', 'telefone', 'rating', 'endereco', 'status', 'atualizado_em'] }),
        'utf8'
      );
      resumo.leadsAntes = atuais.length;
      resumo.leadsNoBackup = doBackup.length;
      resumo.leadsDepois = merged.length;
    }

    res.json({ ok: true, ...resumo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Disparo manual ("Disparar agora") ---

// runSender() pode levar dezenas de minutos (delay de 45-120s entre cada
// mensagem), muito alem do timeout de uma request HTTP. Por isso o POST so
// dispara o job em background e responde na hora; o painel acompanha o
// resultado por polling em /api/sender/status.
const senderJob = { running: false, startedAt: null, finishedAt: null, result: null, error: null };

const MOTIVOS = {
  'fora-da-janela': 'Fora da janela de horario permitida. Ajuste as janelas em "Copy & disparo" se quiser disparar agora.',
  'sem-pendentes': 'Nenhum lead pendente na fila. Rode o scraper para captar novos leads.',
  'limite-diario': 'Limite diario de mensagens ja atingido hoje. Os leads restantes ficam para amanha.',
  'erro-conexao': 'Nao foi possivel conectar ao WhatsApp. Verifique a pagina WhatsApp.',
};

app.post('/api/sender/send-now', (req, res) => {
  if (senderJob.running) {
    res.status(409).json({ error: 'Ja existe um disparo em andamento.' });
    return;
  }

  senderJob.running = true;
  senderJob.startedAt = new Date().toISOString();
  senderJob.finishedAt = null;
  senderJob.result = null;
  senderJob.error = null;

  runSender({ ignoreWindow: true })
    .then((result) => {
      senderJob.result = { ...result, motivo: result.skippedReason ? MOTIVOS[result.skippedReason] || result.skippedReason : null };
    })
    .catch((err) => {
      senderJob.error = err.message;
    })
    .finally(() => {
      senderJob.running = false;
      senderJob.finishedAt = new Date().toISOString();
    });

  res.status(202).json({ started: true });
});

app.get('/api/sender/status', (req, res) => {
  res.json({ ...senderJob, dentroDaJanela: isWithinSendingWindow(new Date()) });
});

// --- Captacao automatica (cron do Apify) ---

app.get('/api/auto-scrape', (req, res) => {
  try {
    res.json({
      config: autoScrape.loadConfig(),
      bounds: autoScrape.BOUNDS,
      leadsPendentes: autoScrape.countPendingLeads(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auto-scrape', (req, res) => {
  try {
    const config = autoScrape.saveConfig(req.body || {});
    res.json({ config, leadsPendentes: autoScrape.countPendingLeads() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Diagnostico (por que o disparo automatico nao rodou?) ---

app.get('/api/diagnostics', (req, res) => {
  try {
    const agora = new Date();
    const cfg = settings.loadSettings();
    const wpp = whatsapp.getState();

    res.json({
      agendadorLigado: ENABLE_SCHEDULER === 'true',
      horaDoServidor: agora.toLocaleString('pt-BR'),
      fusoHorario: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dentroDaJanela: isWithinSendingWindow(agora),
      janelas: cfg.windows,
      limiteDiario: cfg.dailyLimit,
      whatsapp: { status: wpp.status, numero: wpp.info ? wpp.info.number : null },
      leadsPendentes: autoScrape.countPendingLeads(),
      captacaoAutomatica: autoScrape.loadConfig().enabled,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(Number(PORT), () => {
  console.log(`Painel web da Validee rodando em http://localhost:${PORT}`);
  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
    console.warn('Aviso: DASHBOARD_USER/DASHBOARD_PASSWORD nao definidos — o painel esta SEM SENHA. Configure antes de expor a um servidor publico.');
  }

  // Um disparo automatico que nao acontece costuma ser uma destas duas coisas:
  // o agendador desligado, ou o fuso do container diferente do fuso das
  // janelas. Ambos ficam explicitos aqui para nao virar caca ao fantasma.
  const fuso = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`Fuso horario do servidor: ${fuso} — agora sao ${new Date().toLocaleString('pt-BR')}`);
  if (ENABLE_SCHEDULER === 'true') {
    const janelas = settings.loadSettings().windows;
    console.log(`Disparo automatico LIGADO. Janelas (neste fuso): ${janelas.map((w) => `${w.start}-${w.end}`).join(', ')}`);
  } else {
    console.warn('Disparo automatico DESLIGADO (ENABLE_SCHEDULER != "true"). Nada sera enviado sozinho — so pelo botao "Disparar agora".');
  }
});

// Roda o scheduler de disparo no mesmo processo do painel, compartilhando a
// mesma sessao do WhatsApp (evita dois processos disputando o mesmo perfil
// do Chrome). Usado na VPS; em uso local o padrao e deixar desligado e rodar
// `npm run send:schedule` separadamente quando quiser testar o envio.
if (ENABLE_SCHEDULER === 'true') {
  startScheduler();
}

// Reconecta o WhatsApp sozinho se ja houver sessao salva no volume, para o
// painel nao aparecer "desconectado" depois de todo deploy/restart.
whatsapp.autoConnectIfSessionExists();

// Numa VPS este processo deve ficar rodando indefinidamente (via pm2) — um
// erro nao tratado (ex: falha pontual do puppeteer) nao pode derrubar o
// painel nem o scheduler.
process.on('unhandledRejection', (err) => {
  console.error('Erro nao tratado (unhandledRejection):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Erro nao tratado (uncaughtException):', err);
});

// O EasyPanel manda SIGTERM para parar o container antes de um novo deploy.
// Sem isto, o processo Node e derrubado sem chance de fechar o Chrome, e o
// SingletonLock fica preso no volume — o container seguinte (hostname
// diferente) se recusa a abrir o perfil ("profile appears to be in use by
// another Chromium process ... on another computer"). Fechando o client aqui,
// o Chrome remove o proprio lock ao sair.
async function encerrarComCalma(sinal) {
  console.log(`Recebido ${sinal}. Encerrando o cliente do WhatsApp antes de sair...`);
  try {
    await whatsapp.destroyClient();
  } catch (err) {
    console.warn('Erro ao encerrar o WhatsApp durante o shutdown:', err.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => encerrarComCalma('SIGTERM'));
process.on('SIGINT', () => encerrarComCalma('SIGINT'));
