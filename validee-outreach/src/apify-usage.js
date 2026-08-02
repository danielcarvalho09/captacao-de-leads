require('dotenv').config();
const { loadConfig } = require('./apify-config');

const API_BASE = 'https://api.apify.com/v2';

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Apify respondeu HTTP ${res.status} para ${url}`);
  }
  return res.json();
}

// Busca limites do plano e uso do mes corrente na conta Apify, para o usuario
// acompanhar se esta perto do limite do plano. Os nomes exatos dos campos
// podem variar por plano/versao da API, entao devolvemos tanto os valores
// mais comuns ja extraidos quanto o JSON bruto para conferencia na UI.
async function fetchApifyUsage() {
  const { token } = loadConfig();
  if (!token) {
    throw new Error('Token do Apify nao configurado. Defina em /apify.html.');
  }

  const [limits, monthly] = await Promise.all([
    fetchJson(`${API_BASE}/users/me/limits`, token),
    fetchJson(`${API_BASE}/users/me/usage/monthly`, token),
  ]);

  const currentUsd = limits?.data?.current?.monthlyUsageUsd ?? monthly?.data?.monthlyUsageUsd ?? null;
  const maxUsd = limits?.data?.limits?.maxMonthlyUsageUsd ?? null;
  const percentUsed =
    typeof currentUsd === 'number' && typeof maxUsd === 'number' && maxUsd > 0
      ? Math.round((currentUsd / maxUsd) * 1000) / 10
      : null;

  return {
    currentUsd,
    maxUsd,
    percentUsed,
    raw: { limits, monthly },
  };
}

module.exports = { fetchApifyUsage };
