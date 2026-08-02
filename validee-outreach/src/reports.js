require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { loadSettings } = require('./settings');

const { LEADS_CSV_PATH = 'config/leads.csv', LOG_CSV_PATH = 'config/log-envios.csv' } = process.env;

function resolvePath(p) {
  return path.resolve(process.cwd(), p);
}

function readCsv(relativePath) {
  const filePath = resolvePath(relativePath);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.trim()) {
    return [];
  }
  return parse(content, { columns: true, skip_empty_lines: true });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function computeReport() {
  const leads = readCsv(LEADS_CSV_PATH);
  const log = readCsv(LOG_CSV_PATH);
  const settings = loadSettings();

  const leadsSummary = {
    total: leads.length,
    pendente: leads.filter((l) => l.status !== 'enviado' && l.status !== 'erro').length,
    enviado: leads.filter((l) => l.status === 'enviado').length,
    erro: leads.filter((l) => l.status === 'erro').length,
  };

  const today = todayKey();
  const sentToday = log.filter((r) => r.status === 'enviado' && String(r.timestamp).startsWith(today)).length;
  const remainingQuota = Math.max(settings.dailyLimit - sentToday, 0);

  const byDay = new Map();
  for (const row of log) {
    const day = String(row.timestamp).slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) {
      byDay.set(day, { date: day, enviado: 0, erro: 0 });
    }
    const bucket = byDay.get(day);
    if (row.status === 'enviado') bucket.enviado += 1;
    else if (row.status === 'erro') bucket.erro += 1;
  }
  const daily = [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 14);

  const recent = [...log]
    .reverse()
    .slice(0, 50)
    .map((r) => ({ telefone: r.telefone, nome: r.nome, timestamp: r.timestamp, status: r.status }));

  const totalEnviado = log.filter((r) => r.status === 'enviado').length;
  const totalErro = log.filter((r) => r.status === 'erro').length;
  const totalTentativas = totalEnviado + totalErro;
  const taxaSucesso = totalTentativas > 0 ? Math.round((totalEnviado / totalTentativas) * 1000) / 10 : null;

  return {
    leads: leadsSummary,
    hoje: { sentToday, dailyLimit: settings.dailyLimit, remainingQuota },
    totais: { enviado: totalEnviado, erro: totalErro, taxaSucesso },
    daily,
    recent,
  };
}

module.exports = { computeReport };
