const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { scrapeLeads } = require('./scraper');
const { fetchApifyUsage } = require('./apify-usage');

const CONFIG_PATH = path.resolve(process.cwd(), 'config/auto-scrape.json');
const { LEADS_CSV_PATH = 'config/leads.csv' } = process.env;

// Rodar o scraper custa credito do Apify, entao cada guardrail aqui existe
// para evitar queimar cota a toa:
//  - cooldownHours: nunca busca duas vezes em sequencia
//  - maxUsdPerMonth: para de buscar antes de estourar o plano
//  - fila de buscas: repetir o MESMO nicho/cidade devolve os mesmos lugares
//    (0 leads novos), entao so faz sentido buscar quando ha uma busca diferente
const BOUNDS = {
  cooldownHours: { min: 1, max: 720 },
  maxUsdPerMonth: { min: 0, max: 1000 },
};

function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

function defaults() {
  return {
    enabled: false,
    cooldownHours: 12,
    maxUsdPerMonth: 4,
    queue: [],
    lastRunAt: null,
    lastResult: null,
  };
}

function normalize(raw) {
  const base = defaults();
  const merged = { ...base, ...raw };
  const queue = Array.isArray(merged.queue) ? merged.queue : [];

  return {
    enabled: Boolean(merged.enabled),
    cooldownHours: clamp(Number(merged.cooldownHours) || base.cooldownHours, BOUNDS.cooldownHours),
    maxUsdPerMonth: clamp(Number(merged.maxUsdPerMonth) ?? base.maxUsdPerMonth, BOUNDS.maxUsdPerMonth),
    queue: queue
      .map((item) => ({
        searchTerm: String(item.searchTerm || '').trim(),
        searchLocation: String(item.searchLocation || '').trim(),
        lastRunAt: item.lastRunAt || null,
        added: item.added ?? null,
      }))
      .filter((item) => item.searchTerm && item.searchLocation),
    lastRunAt: merged.lastRunAt || null,
    lastResult: merged.lastResult || null,
  };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const initial = defaults();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  return normalize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
}

function saveConfig(partial) {
  const merged = normalize({ ...loadConfig(), ...partial });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function countPendingLeads() {
  const csvPath = path.resolve(process.cwd(), LEADS_CSV_PATH);
  if (!fs.existsSync(csvPath)) {
    return 0;
  }
  const content = fs.readFileSync(csvPath, 'utf8');
  if (!content.trim()) {
    return 0;
  }
  const leads = parse(content, { columns: true, skip_empty_lines: true });
  return leads.filter((l) => l.status !== 'enviado' && l.status !== 'erro').length;
}

function hoursSince(iso) {
  if (!iso) {
    return Infinity;
  }
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

// A proxima busca e sempre a que esta ha mais tempo sem rodar (nunca rodou
// vem primeiro). Assim a fila gira sozinha em vez de repetir a mesma busca.
function pickNextSearch(queue) {
  if (!queue.length) {
    return null;
  }
  return [...queue].sort((a, b) => {
    if (!a.lastRunAt && !b.lastRunAt) return 0;
    if (!a.lastRunAt) return -1;
    if (!b.lastRunAt) return 1;
    return new Date(a.lastRunAt) - new Date(b.lastRunAt);
  })[0];
}

// Retorna { ran, reason, ... }. Nunca lanca: e chamada de dentro de um cron.
async function maybeAutoScrape() {
  const config = loadConfig();

  if (!config.enabled) {
    return { ran: false, reason: 'desligado' };
  }

  const pending = countPendingLeads();
  if (pending > 0) {
    return { ran: false, reason: 'ainda-ha-pendentes', pending };
  }

  const horas = hoursSince(config.lastRunAt);
  if (horas < config.cooldownHours) {
    return { ran: false, reason: 'cooldown', faltamHoras: Math.ceil(config.cooldownHours - horas) };
  }

  const proxima = pickNextSearch(config.queue);
  if (!proxima) {
    return { ran: false, reason: 'fila-vazia' };
  }

  // Guarda de custo: nao dispara uma busca se a cota do mes ja passou do teto.
  try {
    const usage = await fetchApifyUsage();
    if (usage.currentUsd >= config.maxUsdPerMonth) {
      return {
        ran: false,
        reason: 'teto-de-custo',
        currentUsd: usage.currentUsd,
        maxUsdPerMonth: config.maxUsdPerMonth,
      };
    }
  } catch (err) {
    // Se nem da para consultar o uso, o mais seguro e nao gastar credito.
    return { ran: false, reason: 'erro-ao-checar-uso', error: err.message };
  }

  console.log(`[auto-scrape] Fila vazia. Buscando "${proxima.searchTerm}" em "${proxima.searchLocation}"...`);

  const agora = new Date().toISOString();
  try {
    const resultado = await scrapeLeads({
      searchTerm: proxima.searchTerm,
      searchLocation: proxima.searchLocation,
    });

    const queue = config.queue.map((item) =>
      item.searchTerm === proxima.searchTerm && item.searchLocation === proxima.searchLocation
        ? { ...item, lastRunAt: agora, added: resultado.added }
        : item
    );

    saveConfig({
      queue,
      lastRunAt: agora,
      lastResult: { ...resultado, searchTerm: proxima.searchTerm, searchLocation: proxima.searchLocation, at: agora },
    });

    console.log(`[auto-scrape] ${resultado.added} leads novos de "${proxima.searchTerm} / ${proxima.searchLocation}".`);
    return { ran: true, busca: proxima, ...resultado };
  } catch (err) {
    console.error('[auto-scrape] Falha ao buscar:', err.message);
    saveConfig({ lastRunAt: agora, lastResult: { erro: err.message, at: agora } });
    return { ran: false, reason: 'erro', error: err.message };
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  maybeAutoScrape,
  countPendingLeads,
  pickNextSearch,
  BOUNDS,
};
