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
const autoScrape = require('../auto-scrape');
const { parse } = require('csv-parse/sync');

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
app.use(express.json());
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

app.listen(Number(PORT), () => {
  console.log(`Painel web da Validee rodando em http://localhost:${PORT}`);
  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
    console.warn('Aviso: DASHBOARD_USER/DASHBOARD_PASSWORD nao definidos — o painel esta SEM SENHA. Configure antes de expor a um servidor publico.');
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
