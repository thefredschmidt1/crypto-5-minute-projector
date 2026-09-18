'use strict';

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const POLL_MS = Number(process.env.POLL_MS || 10000);
const TEST_MS = 180000;
const ASSETS = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD' };

fs.mkdirSync(DATA_DIR, { recursive: true });
let state = loadState();
if (!state.vapid?.publicKey || !state.vapid?.privateKey) {
  state.vapid = webpush.generateVAPIDKeys();
  saveState();
}
webpush.setVapidDetails('mailto:crypto-projector@localhost', state.vapid.publicKey, state.vapid.privateKey);

function loadState() {
  try {
    return { subscriptions: [], tests: [], signals: {}, active: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { subscriptions: [], tests: [], signals: {}, active: {} };
  }
}

function saveState() {
  const temporary = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, STATE_FILE);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  return values.slice(1).reduce((value, next) => next * k + value * (1 - k), values[0]);
}

function rsi(values, period = 14) {
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const difference = values[i] - values[i - 1];
    difference > 0 ? gains += difference : losses -= difference;
  }
  if (!losses) return 100;
  return 100 - (100 / (1 + (gains / period) / (losses / period)));
}

function analyze(candles) {
  const closes = candles.map(item => item.close);
  const volumes = candles.map(item => item.volume);
  const price = closes.at(-1);
  const e5 = ema(closes.slice(-20), 5);
  const e12 = ema(closes.slice(-25), 12);
  const indicatorRsi = rsi(closes);
  const momentum3 = (price / closes.at(-4) - 1) * 100;
  const momentum5 = (price / closes.at(-6) - 1) * 100;
  const averageVolume = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
  const volumeRatio = volumes.at(-1) / (averageVolume || 1);
  const returns = [];
  for (let i = closes.length - 15; i < closes.length; i++) returns.push(Math.abs((closes[i] / closes[i - 1] - 1) * 100));
  const volatility = returns.reduce((a, b) => a + b, 0) / returns.length;
  let score = 0;
  score += Math.max(-28, Math.min(28, (e5 / e12 - 1) * 100 * 180));
  score += Math.max(-12, Math.min(12, momentum5 * 10));
  score += Math.max(-28, Math.min(28, momentum3 * 24));
  score += indicatorRsi > 55 ? Math.min(12, (indicatorRsi - 55) * .8) : indicatorRsi < 45 ? -Math.min(12, (45 - indicatorRsi) * .8) : 0;
  score += volumeRatio > 1.15 ? Math.sign(momentum3 || 1) * Math.min(8, (volumeRatio - 1) * 8) : 0;
  const conflict = Math.sign(e5 - e12) && Math.sign(momentum3) && Math.sign(e5 - e12) !== Math.sign(momentum3);
  const signal = Math.abs(score) < 20 || volatility > .28 || conflict || Math.abs(momentum3) < .025 ? 'WAIT' : score > 0 ? 'UP' : 'DOWN';
  const confidence = signal === 'WAIT' ? Math.max(35, 55 - Math.abs(score)) : Math.min(88, 52 + Math.abs(score) * .65);
  return { signal, score, confidence: Math.round(confidence), price };
}

async function candlesFor(pair) {
  const response = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1`);
  if (!response.ok) throw new Error(`Kraken HTTP ${response.status}`);
  const json = await response.json();
  if (json.error?.length) throw new Error(json.error.join(', '));
  const key = Object.keys(json.result).find(item => item !== 'last');
  return json.result[key].slice(-180).map(item => ({ close: Number(item[4]), volume: Number(item[6]) }));
}

function localTime(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Detroit', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
}

async function notify(title, body, tag) {
  const payload = JSON.stringify({ title, body, tag, url: '/' });
  const survivors = [];
  for (const subscription of state.subscriptions) {
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 60, urgency: 'high' });
      survivors.push(subscription);
    } catch (error) {
      if (![404, 410].includes(error.statusCode)) survivors.push(subscription);
    }
  }
  state.subscriptions = survivors;
  saveState();
}

async function startTest(asset, result) {
  const startedAt = new Date().toISOString();
  state.active[asset] = { asset, prediction: result.signal, score: result.score, confidence: result.confidence, startPrice: result.price, startedAt, endsAt: new Date(Date.now() + TEST_MS).toISOString() };
  saveState();
  await notify(`${asset} ${result.signal} started — ${localTime(startedAt)}`, `Start $${result.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} · Score ${result.score.toFixed(1)} · 3:00`, `${asset}-start`);
}

async function finishTest(asset, price) {
  const test = state.active[asset];
  if (!test) return;
  const endedAt = new Date().toISOString();
  const actual = price > test.startPrice ? 'UP' : price < test.startPrice ? 'DOWN' : 'FLAT';
  const result = actual === test.prediction ? 'CORRECT' : 'INCORRECT';
  const change = (price / test.startPrice - 1) * 100;
  const completed = { ...test, endPrice: price, endedAt, actual, result, change };
  state.tests.unshift(completed);
  state.tests = state.tests.slice(0, 500);
  delete state.active[asset];
  saveState();
  await notify(`${asset} test ${result}`, `Started ${localTime(test.startedAt)} · Ended ${localTime(endedAt)} · ${change >= 0 ? '+' : ''}${change.toFixed(3)}%`, `${asset}-finish`);
}

let polling = false;
async function monitor() {
  if (polling) return;
  polling = true;
  try {
    for (const [asset, pair] of Object.entries(ASSETS)) {
      try {
        const candles = await candlesFor(pair);
        const result = analyze(candles);
        const previous = state.signals[asset]?.signal || 'WAIT';
        state.signals[asset] = { ...result, checkedAt: new Date().toISOString() };

       if (!state.active[asset] && result.signal !== 'WAIT') {
  await startTest(asset, result);
}
         
        
      
      } catch (error) {
        console.error(asset, error.message);
      }
    }
    saveState();
  } finally {
    polling = false;
  }
}

const app = express();
app.use(express.json({ limit: '32kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, lastSignals: state.signals }));
app.get('/api/push-key', (_req, res) => res.json({ publicKey: state.vapid.publicKey }));
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  state.subscriptions = state.subscriptions.filter(item => item.endpoint !== subscription.endpoint);
  state.subscriptions.push(subscription);
  saveState();
  res.json({ ok: true });
});
app.get('/api/tests', (_req, res) => res.json({ active: state.active, tests: state.tests.slice(0, 50), signals: state.signals }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/sw.js', (_req, res) => res.sendFile(path.join(__dirname, 'sw.js')));
app.get('/manifest.webmanifest', (_req, res) => res.sendFile(path.join(__dirname, 'manifest.webmanifest')));
app.listen(PORT, () => console.log(`Crypto Projector listening on ${PORT}`));

monitor();
setInterval(monitor, POLL_MS);
