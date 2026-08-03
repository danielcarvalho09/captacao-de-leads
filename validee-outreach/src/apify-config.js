require('dotenv').config();
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(process.cwd(), 'config/apify-config.json');

// Contem a chave de API do Apify: nunca deve ir para o git nem ser devolvida
// inteira para o navegador depois de salva (ver getPublicConfig).
const RATING_BOUNDS = { min: 0, max: 5 };
const MAX_LEADS_BOUNDS = { min: 1, max: 500 };

function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

function defaults() {
  return {
    token: process.env.APIFY_TOKEN || '',
    actorId: process.env.APIFY_ACTOR_ID || 'compass/crawler-google-places',
    searchTerm: process.env.SEARCH_TERM || '',
    searchLocation: process.env.SEARCH_LOCATION || '',
    maxLeads: Number(process.env.MAX_LEADS) || 50,
    minRating: Number(process.env.MIN_RATING) || 0,
    maxRating: Number(process.env.MAX_RATING) || 5,
  };
}

function normalize(raw) {
  const base = defaults();
  const merged = { ...base, ...raw };

  const actorId = String(merged.actorId || base.actorId).trim() || base.actorId;
  const searchTerm = String(merged.searchTerm || '').trim();
  const searchLocation = String(merged.searchLocation || '').trim();
  const maxLeads = clamp(Math.round(Number(merged.maxLeads) || base.maxLeads), MAX_LEADS_BOUNDS);

  let minRating = clamp(Number(merged.minRating) ?? base.minRating, RATING_BOUNDS);
  let maxRating = clamp(Number(merged.maxRating) ?? base.maxRating, RATING_BOUNDS);
  if (maxRating < minRating) {
    maxRating = minRating;
  }

  const token = typeof merged.token === 'string' ? merged.token.trim() : '';

  return { token, actorId, searchTerm, searchLocation, maxLeads, minRating, maxRating };
}

// APIFY_TOKEN no ambiente VENCE o que estiver salvo no arquivo.
// Motivo: num container sem volume persistente, config/apify-config.json e
// recriado vazio a cada deploy e o token some. A variavel de ambiente vive na
// configuracao do servico (painel do EasyPanel), nao no disco do container,
// entao sobrevive a deploy. Quem define APIFY_TOKEN quer que ele seja usado.
function tokenDoAmbiente() {
  const t = (process.env.APIFY_TOKEN || '').trim();
  return t || null;
}

function loadConfig() {
  let config;
  if (!fs.existsSync(CONFIG_PATH)) {
    config = normalize(defaults());
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } else {
    config = normalize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  }

  const doAmbiente = tokenDoAmbiente();
  return doAmbiente ? { ...config, token: doAmbiente } : config;
}

// partial.token vazio/ausente mantem o token ja salvo (o formulario web nao
// reenvia o valor real do token, so troca quando o usuario digita um novo).
function saveConfig(partial) {
  const current = loadConfig();
  const tokenToUse = partial.token && partial.token.trim() ? partial.token.trim() : current.token;
  const merged = normalize({ ...current, ...partial, token: tokenToUse });

  if (!merged.searchTerm) {
    throw new Error('O termo de busca (ex: "clinica de estetica") e obrigatorio.');
  }
  if (!merged.searchLocation) {
    throw new Error('A localizacao (ex: "Belo Horizonte, MG, Brasil") e obrigatoria.');
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// Versao segura para devolver ao navegador: nunca inclui o token completo.
function getPublicConfig() {
  const config = loadConfig();
  const hasToken = Boolean(config.token);
  const doAmbiente = tokenDoAmbiente();
  return {
    hasToken,
    tokenPreview: hasToken ? `••••${config.token.slice(-4)}` : null,
    // 'ambiente' significa que o painel nao consegue sobrescrever: quem manda
    // e a variavel APIFY_TOKEN. Precisa aparecer na tela para o usuario nao
    // ficar salvando um token que nunca sera usado.
    tokenOrigem: doAmbiente ? 'ambiente' : hasToken ? 'arquivo' : 'nenhum',
    actorId: config.actorId,
    searchTerm: config.searchTerm,
    searchLocation: config.searchLocation,
    maxLeads: config.maxLeads,
    minRating: config.minRating,
    maxRating: config.maxRating,
  };
}

module.exports = {
  loadConfig,
  tokenDoAmbiente,
  saveConfig,
  getPublicConfig,
  MAX_LEADS_BOUNDS,
  RATING_BOUNDS,
};
