require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.resolve(process.cwd(), 'config/settings.json');

// Limites de seguranca que o painel web NAO pode ultrapassar, mesmo que o
// usuario digite um valor fora da faixa. Protegem contra configurar o sistema
// para um comportamento de disparo em massa.
const GUARDRAILS = {
  dailyLimit: { min: 1, max: 40 },
  delaySeconds: { min: 20, max: 600 },
};

const DEFAULT_WINDOWS = [
  { days: [2, 3, 4], start: '07:00', end: '08:00' },
  { days: [2, 3, 4], start: '12:00', end: '14:00' },
  { days: [2, 3, 4], start: '18:30', end: '20:00' },
];

function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

function parseTimeToMinutes(hhmm) {
  const match = /^([0-1]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim());
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function defaultSettings() {
  return {
    dailyLimit: Number(process.env.DAILY_LIMIT) || 15,
    minDelaySeconds: Number(process.env.MIN_DELAY_SECONDS) || 45,
    maxDelaySeconds: Number(process.env.MAX_DELAY_SECONDS) || 120,
    windows: DEFAULT_WINDOWS,
  };
}

function normalizeWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    // Nunca aceitamos remover todas as janelas: sem isso o sender dispararia
    // a qualquer hora, o que e exatamente o que essas janelas existem pra evitar.
    throw new Error('E preciso manter ao menos uma janela de horario de disparo.');
  }

  return windows.map((w) => {
    const days = Array.isArray(w.days)
      ? [...new Set(w.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [];
    if (days.length === 0) {
      throw new Error('Cada janela precisa ter ao menos um dia da semana selecionado.');
    }

    const startMin = parseTimeToMinutes(w.start);
    const endMin = parseTimeToMinutes(w.end);
    if (startMin === null || endMin === null || startMin >= endMin) {
      throw new Error(`Janela de horario invalida: "${w.start}" ate "${w.end}".`);
    }

    return { days, start: w.start, end: w.end };
  });
}

function normalizeSettings(raw) {
  const base = defaultSettings();
  const merged = { ...base, ...raw };

  const dailyLimit = clamp(Math.round(Number(merged.dailyLimit) || base.dailyLimit), GUARDRAILS.dailyLimit);
  let minDelaySeconds = clamp(Math.round(Number(merged.minDelaySeconds) || base.minDelaySeconds), GUARDRAILS.delaySeconds);
  let maxDelaySeconds = clamp(Math.round(Number(merged.maxDelaySeconds) || base.maxDelaySeconds), GUARDRAILS.delaySeconds);

  if (maxDelaySeconds < minDelaySeconds) {
    maxDelaySeconds = minDelaySeconds;
  }

  const windows = normalizeWindows(merged.windows || base.windows);

  return { dailyLimit, minDelaySeconds, maxDelaySeconds, windows };
}

function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    const initial = normalizeSettings(defaultSettings());
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }

  const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  return normalizeSettings(raw);
}

function saveSettings(partial) {
  const current = loadSettings();
  const merged = normalizeSettings({ ...current, ...partial });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = {
  loadSettings,
  saveSettings,
  parseTimeToMinutes,
  GUARDRAILS,
  DEFAULT_WINDOWS,
};
