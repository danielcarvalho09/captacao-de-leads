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

// Numa VPS este processo deve ficar rodando indefinidamente (via pm2) — um
// erro nao tratado (ex: falha pontual do puppeteer) nao pode derrubar o
// painel nem o scheduler.
process.on('unhandledRejection', (err) => {
  console.error('Erro nao tratado (unhandledRejection):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Erro nao tratado (uncaughtException):', err);
});

// --- Leads (lista de captados) ---

app.get('/api/leads', (req, res) => {
  try {
    const leadsPath = path.resolve(process.cwd(), 'config/leads.csv');
    if (!fs.existsSync(leadsPath)) {
      return res.json({ leads: [] });
    }
    const csv = fs.readFileSync(leadsPath, 'utf8');
    const lines = csv.trim().split('\n');
    if (lines.length <= 1) {
      return res.json({ leads: [] });
    }
    const headers = lines[0].split(',');
    const leads = lines.slice(1).map(line => {
      const values = line.split(',');
      const lead = {};
      headers.forEach((h, i) => {
        lead[h.trim()] = values[i] ? values[i].trim().replace(/^"(.*)"$/, '$1') : '';
      });
      return lead;
    });
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Disparar agora (manual, sem agendador) ---

app.post('/api/sender/send-now', async (req, res) => {
  try {
    const result = await runSender();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
