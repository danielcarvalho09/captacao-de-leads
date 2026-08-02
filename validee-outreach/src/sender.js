require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { getClient } = require('./whatsapp');
const { loadSettings, parseTimeToMinutes } = require('./settings');

const {
  LEADS_CSV_PATH = 'config/leads.csv',
  LOG_CSV_PATH = 'config/log-envios.csv',
  MESSAGE_TEMPLATE_PATH = 'config/message-template.txt',
} = process.env;

const LEADS_COLUMNS = ['nome', 'telefone', 'rating', 'endereco', 'status', 'atualizado_em'];

// As janelas de disparo, o limite diario e o delay entre envios vem de
// config/settings.json (editavel pelo painel web em /copy), lido a cada
// chamada para que ajustes feitos no painel valham mesmo com o --schedule
// ja rodando ha dias. Fora da janela o sender simplesmente nao dispara nada,
// mesmo se chamado manualmente.
function isWithinSendingWindow(date = new Date(), windows = loadSettings().windows) {
  const day = date.getDay(); // 0=domingo ... 2=terca, 3=quarta, 4=quinta
  const minutesOfDay = date.getHours() * 60 + date.getMinutes();
  return windows.some(
    (w) => w.days.includes(day) && minutesOfDay >= parseTimeToMinutes(w.start) && minutesOfDay < parseTimeToMinutes(w.end)
  );
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function todayKey(date = new Date()) {
  return formatTimestamp(date).slice(0, 10);
}

function randomDelayMs(minDelaySeconds, maxDelaySeconds) {
  const seconds = Math.floor(Math.random() * (maxDelaySeconds - minDelaySeconds + 1)) + minDelaySeconds;
  return seconds * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePath(p) {
  return path.resolve(process.cwd(), p);
}

function loadLeads() {
  const csvPath = resolvePath(LEADS_CSV_PATH);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Arquivo de leads nao encontrado em ${csvPath}. Rode o scraper primeiro.`);
  }
  const content = fs.readFileSync(csvPath, 'utf8');
  return parse(content, { columns: true, skip_empty_lines: true });
}

function saveLeads(leads) {
  const csvPath = resolvePath(LEADS_CSV_PATH);
  const normalized = leads.map((lead) => ({
    nome: lead.nome || '',
    telefone: lead.telefone || '',
    rating: lead.rating || '',
    endereco: lead.endereco || '',
    status: lead.status || 'pendente',
    atualizado_em: lead.atualizado_em || '',
  }));
  const csvContent = stringify(normalized, { header: true, columns: LEADS_COLUMNS });
  fs.writeFileSync(csvPath, csvContent, 'utf8');
}

function appendLogEntry({ telefone, nome, timestamp, status }) {
  const logPath = resolvePath(LOG_CSV_PATH);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const exists = fs.existsSync(logPath);
  const row = stringify([[telefone, nome, timestamp, status]]);
  if (!exists) {
    const header = stringify([['telefone', 'nome', 'timestamp', 'status']]);
    fs.writeFileSync(logPath, header + row, 'utf8');
  } else {
    fs.appendFileSync(logPath, row, 'utf8');
  }
}

function countSentToday() {
  const logPath = resolvePath(LOG_CSV_PATH);
  if (!fs.existsSync(logPath)) {
    return 0;
  }
  const content = fs.readFileSync(logPath, 'utf8');
  if (!content.trim()) {
    return 0;
  }
  const rows = parse(content, { columns: true, skip_empty_lines: true });
  const today = todayKey();
  return rows.filter((r) => r.status === 'enviado' && String(r.timestamp).startsWith(today)).length;
}

function loadTemplate() {
  const templatePath = resolvePath(MESSAGE_TEMPLATE_PATH);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template de mensagem nao encontrado em ${templatePath}`);
  }
  return fs.readFileSync(templatePath, 'utf8').trim();
}

function personalize(template, nome) {
  return template.replace(/\{nome\}/g, nome || 'time');
}

// Normaliza o telefone para o formato aceito pelo whatsapp-web.js (DDI+DDD+numero, so digitos).
// Se vier sem o codigo do Brasil (55), assume Brasil e adiciona.
function toDigitsWithCountryCode(telefoneRaw) {
  let digits = String(telefoneRaw || '').replace(/\D/g, '');
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    digits = `55${digits}`;
  }
  return digits;
}

async function runSender() {
  const settings = loadSettings();

  if (!isWithinSendingWindow(new Date(), settings.windows)) {
    console.log('Fora da janela de envio permitida. Nada sera disparado.');
    return { sent: 0, skippedReason: 'fora-da-janela' };
  }

  const leads = loadLeads();
  const pending = leads.filter((l) => l.status !== 'enviado' && l.status !== 'erro');

  if (pending.length === 0) {
    console.log('Nenhum lead pendente em config/leads.csv.');
    return { sent: 0, skippedReason: 'sem-pendentes' };
  }

  const dailyLimit = settings.dailyLimit;
  const sentToday = countSentToday();
  let remainingQuota = dailyLimit - sentToday;

  if (remainingQuota <= 0) {
    console.log(`Limite diario de ${dailyLimit} mensagens ja atingido hoje. ${pending.length} leads ficam pendentes para amanha.`);
    return { sent: 0, skippedReason: 'limite-diario', pendentes: pending.length };
  }

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('Nao foi possivel conectar ao WhatsApp:', err.message);
    return { sent: 0, skippedReason: 'erro-conexao' };
  }

  const template = loadTemplate();
  let sentCount = 0;
  let stoppedByWindow = false;

  for (let i = 0; i < pending.length; i += 1) {
    if (sentCount >= remainingQuota) {
      break;
    }
    if (!isWithinSendingWindow(new Date(), settings.windows)) {
      stoppedByWindow = true;
      break;
    }

    const lead = pending[i];
    const timestamp = formatTimestamp();

    try {
      const digits = toDigitsWithCountryCode(lead.telefone);
      const numberId = await client.getNumberId(digits);
      if (!numberId) {
        throw new Error('numero invalido ou sem WhatsApp');
      }

      const text = personalize(template, lead.nome);
      await client.sendMessage(numberId._serialized, text);

      lead.status = 'enviado';
      lead.atualizado_em = timestamp;
      appendLogEntry({ telefone: lead.telefone, nome: lead.nome, timestamp, status: 'enviado' });
      sentCount += 1;
      console.log(`[${timestamp}] Enviado para ${lead.nome} (${lead.telefone}).`);
    } catch (err) {
      lead.status = 'erro';
      lead.atualizado_em = timestamp;
      appendLogEntry({ telefone: lead.telefone, nome: lead.nome, timestamp, status: 'erro' });
      console.error(`[${timestamp}] Falha ao enviar para ${lead.nome} (${lead.telefone}): ${err.message}`);
    }

    saveLeads(leads);

    const isLastPending = i === pending.length - 1;
    const reachedQuota = sentCount >= remainingQuota;
    if (!isLastPending && !reachedQuota) {
      const delayMs = randomDelayMs(settings.minDelaySeconds, settings.maxDelaySeconds);
      console.log(`Aguardando ${Math.round(delayMs / 1000)}s antes do proximo envio...`);
      await sleep(delayMs);
    }
  }

  const stillPending = leads.filter((l) => l.status !== 'enviado' && l.status !== 'erro').length;

  if (stoppedByWindow) {
    console.log(`Janela de envio encerrada durante a execucao. ${stillPending} leads ficam pendentes para a proxima janela.`);
  } else if (sentCount >= remainingQuota && stillPending > 0) {
    console.log(`Limite diario de ${dailyLimit} mensagens atingido. ${stillPending} leads ficam pendentes para amanha.`);
  } else {
    console.log(`Envio concluido. ${sentCount} mensagens enviadas nesta execucao.`);
  }

  return { sent: sentCount, pendentes: stillPending };
}

module.exports = {
  runSender,
  isWithinSendingWindow,
};
