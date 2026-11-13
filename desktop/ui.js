// Shared helpers for the main window. Scripts load in order: ui, history, dictionary, settings, sync, app.
const icons = {
  wave: '<path d="M3 10v4m4-8v12m5-15v18m5-13v8m4-11v14"/>',
  home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4m0 13.6v2.4M4.9 4.9l1.7 1.7m10.8 10.8 1.7 1.7M2.8 12h2.4m13.6 0h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/>',
  sliders: '<path d="M4 7h10m4 0h2M4 17h4m4 0h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-4 4 3 3"/>',
  devices: '<rect x="3" y="5" width="13" height="10" rx="1.5"/><path d="M7 19h5"/><rect x="17" y="9" width="5" height="11" rx="1.2"/>',
  shield: '<path d="M12 3 5 6v5c0 5 3 8.5 7 10 4-1.5 7-5 7-10V6z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 5V3H3v14h2"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  pause: '<path d="M8 5v14m8-14v14"/>',
  chart: '<path d="M4 3v17h17M8 15v-4m5 4V6m5 9v-6"/>',
  trash: '<path d="M4 6h16M9 3h6m-9 3 1 15h10l1-15M10 10v7m4-7v7"/>',
  refresh: '<path d="M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6m-5 5a8 8 0 0 0 14 4l3-3m0 6v-6h-6"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2m-6 8v4m-3 0h6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M4 12h16"/>', square: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>', download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  compare: '<path d="M4 6h6v12H4zM14 6h6v12h-6zM10 9h4m-4 6h4"/>',
  sparkle: '<path d="M12 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7z"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
function icon(name) { const span = document.createElement('span'); span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.wave}</svg>`; return span.firstChild; }
document.querySelectorAll('[data-icon]').forEach(node => node.replaceWith(icon(node.dataset.icon)));
const $ = id => document.getElementById(id);
const call = (method, params) => window.whisper.call(method, params);
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

// Everything the window knows, filled by app.js from `initial` and engine events.
const app = { history: [], settings: {}, sync: null, update: null, version: '', learned: new Set(), engineOnline: false };

let toastTimer, toastAction = null;
// Shows a short message. `action` adds a button (for example Undo); `onTimeout` runs if the toast expires unclicked.
function toast(message, { action, onTimeout, duration = 4500 } = {}) {
  if (toastAction?.onTimeout) toastAction.onTimeout();
  toastAction = action ? { ...action, onTimeout } : null;
  $('toast-text').textContent = message;
  $('toast-action').hidden = !action; $('toast-action').textContent = action?.label || '';
  $('toast').hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; const pending = toastAction; toastAction = null; pending?.onTimeout?.(); }, action ? Math.max(duration, 6000) : duration);
}
$('toast-action').onclick = () => { const pending = toastAction; toastAction = null; $('toast').hidden = true; clearTimeout(toastTimer); pending?.run(); };
const fail = error => toast(error?.message || String(error));

function formatShortcutParts(binding = { modifiers: 10, key: 0 }) {
  const parts = [[2, 'Ctrl'], [1, 'Alt'], [4, 'Shift'], [8, 'Win']].filter(([bit]) => binding.modifiers & bit).map(([, label]) => label);
  if (binding.key) parts.push(binding.key === 32 ? 'Space' : binding.key >= 112 && binding.key <= 135 ? `F${binding.key - 111}` : String.fromCharCode(binding.key));
  return parts;
}
const formatShortcut = binding => formatShortcutParts(binding).join(' + ');
function keycaps(binding) { return formatShortcutParts(binding).map(part => el('kbd', 'keycap', part)); }
const lockMode = () => app.settings.lockMode !== false;
const credentialFlags = { openrouter: 'hasKey', xai: 'hasXaiKey', gateway: 'hasGatewayKey' };
const credentialNames = { openrouter: 'OpenRouter', xai: 'xAI', gateway: 'Vercel AI Gateway' };
// The key the selected voice model needs, if it has not been saved yet.
function missingKey(settings = app.settings) {
  if (!settings || !Object.keys(settings).length) return null;
  const credential = settings.models?.find(model => model.id === settings.transcriptionModel)?.credential || 'openrouter';
  return settings[credentialFlags[credential]] ? null : credential;
}
function shortcutSentence(binding = app.settings.shortcut) {
  return lockMode() ? 'Press to start dictating, press again to paste. Escape cancels.' : 'Hold while you speak, release to paste. Double-tap to keep recording hands-free.';
}

const money = (number, digits = 2) => number == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number);
function formatDuration(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`; }
const compact = number => number >= 10000 ? `${(number / 1000).toFixed(number >= 100000 ? 0 : 1)}K` : Number(number || 0).toLocaleString();
function dayLabel(date, now = new Date()) {
  const start = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

const modelNames = {
  'openai/gpt-transcribe': 'GPT-Transcribe', 'microsoft/mai-transcribe-2': 'MAI-Transcribe-2',
  'microsoft/mai-transcribe-2-streaming': 'MAI-Transcribe-2 · Streaming', 'mai-transcribe-2-streaming': 'MAI-Transcribe-2 · Streaming',
  'google/gemini-3.8-flash': 'Gemini 3.8 Flash', 'openai/gpt-5.6-luna': 'Luna 5.6', 'openai/gpt-6-luna': 'Luna 6',
  'gpt-transcribe': 'GPT-Transcribe', 'mai-transcribe-2-verbatim': 'MAI-Transcribe-2 · Verbatim', 'mai-transcribe-2-clean': 'MAI-Transcribe-2 · Clean',
  'gemini-3.8-flash': 'Gemini 3.8 Flash · Priority', 'grok-voice-transcribe-2.0': 'Grok Voice Transcribe 2.0',
  'grok-voice-transcribe-2-streaming': 'Grok Voice Transcribe 2.0 · Streaming', luna: 'Luna 6', 'luna-fast': 'Luna 6 Fast',
  deepseek: 'DeepSeek V4.1 Flash Fast', 'deepseek/deepseek-v4.1-flash-fast': 'DeepSeek V4.1 Flash Fast'
};
// Which models made a transcript. Entries recorded before model tracking have no facts.
function pipelineFacts(metrics) {
  const model = typeof metrics?.transcriptionModel === 'string' && metrics.transcriptionModel ? (modelNames[metrics.transcriptionModel] || metrics.transcriptionModel) : '';
  if (!model) return [];
  const requested = typeof metrics?.requestedTranscriptionModel === 'string' && metrics.requestedTranscriptionModel ? (modelNames[metrics.requestedTranscriptionModel] || metrics.requestedTranscriptionModel) : '';
  const cleanup = metrics.cleanupMode;
  return [['Voice model', requested && requested !== model ? `${requested} → ${model}` : model], ['Cleanup', !cleanup || cleanup === 'off' ? 'Off' : (modelNames[cleanup] || cleanup)]];
}
function responseTime(metrics) {
  const stop = Number(metrics?.stopMs), paste = Number(metrics?.pasteMs), elapsed = Number(metrics?.elapsedMs);
  if (Number.isFinite(stop) && Number.isFinite(paste)) return paste - stop;
  if (Number.isFinite(stop) && Number.isFinite(elapsed)) return elapsed - stop;
  return Number.isFinite(elapsed) ? elapsed : null;
}

// Views: home, history, dictionary. Settings is a modal on top of whichever view is showing.
let currentView = 'home';
function navigate(view, tab) {
  if (view === 'settings') { openSettings(tab); return; }
  currentView = view;
  for (const name of ['home', 'history', 'dictionary']) $(`${name}-view`).hidden = name !== view;
  document.querySelectorAll('.nav-item[data-view]').forEach(button => button.classList.toggle('selected', button.dataset.view === view));
  if (view !== 'history' && view !== 'home') stopAudio();
  closeDrawers();
  document.querySelector('main').scrollTop = 0;
}
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => navigate(button.dataset.view));
document.querySelectorAll('[data-goto]').forEach(button => button.onclick = () => navigate(button.dataset.goto));
document.querySelectorAll('[data-window]').forEach(button => button.onclick = () => call(button.dataset.window).catch(fail));
