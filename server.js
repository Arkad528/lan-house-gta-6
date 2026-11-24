'use strict';
/**
 * playgta6 — Lan House Digital PS5 (GTA VI)
 * - Login real via OAuth2 (Discord e Google), sessão em cookie HttpOnly assinado (HMAC-SHA256)
 * - Fila FIFO em tempo real, preços validados 100% no servidor
 * - PIX (Mercado Pago + BR Code) e Crypto (NOWPayments)
 * - Painel /admin com proteção contra força bruta e desligamento de emergência
 * Sem dependências externas (Node 18+).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let QRCode = null;
try {
  QRCode = require('qrcode');
} catch {}

async function generateQrBase64(text) {
  if (!QRCode || !text) return null;
  try {
    const dataUrl = await QRCode.toDataURL(String(text), { width: 256, margin: 2, errorCorrectionLevel: 'M' });
    return dataUrl.replace(/^data:image\/png;base64,/, '');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// .env (carregador simples, sem dependência)
// ---------------------------------------------------------------------------
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
})();

const DEFAULT_ADMIN_HASHES = new Set([
  'cce496487612c8b23f719bdbe8c5b1169c390dd9490b0b638e88199c8f96655d',
  'eb88313feda4f7618e42265f6b0b2ecd7a7800e0d5a43c2089f727885a6e3b89'
]);

const ENV = {
  PORT: Number(process.env.PORT) || 3000,
  BASE_URL: (process.env.BASE_URL || '').replace(/\/+$/, ''),
  ADMIN_DISCORD_IDS: new Set(
    (process.env.ADMIN_DISCORD_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{15,25}$/.test(s))
  ),
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || '',
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN || '',
  MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY || '',
  MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET || '',
  NOWPAYMENTS_API_KEY: process.env.NOWPAYMENTS_API_KEY || '',
  NOWPAYMENTS_IPN_SECRET: process.env.NOWPAYMENTS_IPN_SECRET || '',
  KV_REST_API_URL: (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''),
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
  DEMO_MODE_RAW: process.env.DEMO_MODE,
  TRUST_PROXY: process.env.TRUST_PROXY === 'true' || !!process.env.VERCEL || !!process.env.RENDER
};

const CRYPTO_ENABLED = false;
const kvEnabled = () => !!(ENV.KV_REST_API_URL && ENV.KV_REST_API_TOKEN);
const mpEnabled = () => !!ENV.MP_ACCESS_TOKEN;
const mpMode = () => {
  if (!ENV.MP_ACCESS_TOKEN) return 'none';
  if (ENV.MP_ACCESS_TOKEN.startsWith('TEST-')) return 'sandbox';
  return 'prod';
};
const npEnabled = () => !!ENV.NOWPAYMENTS_API_KEY;
// Modo de teste fica DESLIGADO automaticamente se Mercado Pago ou NOWPayments estiverem ativos (a menos que DEMO_MODE=true explícito)
const isDemoMode = () => {
  if (ENV.DEMO_MODE_RAW === 'false') return false;
  if (ENV.DEMO_MODE_RAW === 'true') return true;
  if (mpEnabled() || npEnabled()) return false;
  return !process.env.VERCEL && !process.env.RENDER;
};

const WEAK_SECRETS = new Set(['troque-por-uma-chave-secreta-longa-e-aleatoria', 'changeme', 'secret', 'default']);
let SECRET = (process.env.SESSION_SECRET || '').trim();
if (!SECRET || SECRET.length < 32 || WEAK_SECRETS.has(SECRET.toLowerCase())) {
  if (SECRET) {
    console.error('[playgta6] SESSION_SECRET fraco ou padrão detectado! Ignorado e substituído por segredo aleatório forte.');
  } else {
    console.warn('[playgta6] SESSION_SECRET não definido: usando segredo temporário (logins caem ao reiniciar).');
  }
  SECRET = crypto.randomBytes(32).toString('hex');
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Estado do PS5, fila e preços (em memória)
// ---------------------------------------------------------------------------
const ps5Config = {
  consoleStatus: 'online', // online | busy | maintenance
  emergencyOffline: false,
  ps5LocalIp: '192.168.1.150',
  remotePlayPin: '48291033',
  connectionMode: 'parsec_chiaki',
  parsecInviteUrl: 'https://parsec.gg/g/playgta6-ps5',
  streamMode: 'youtube',
  streamSourceUrl: 'https://www.youtube.com/embed/QdBZY2fkU-0?autoplay=1&mute=1&loop=1&playlist=QdBZY2fkU-0&controls=1&rel=0',
  streamTitle: 'Sessão GTA VI • PS5 #01',
  activePlayer: null, // { orderId, uid, name, totalMinutes, remainingSeconds, startedAt }
  queue: [] // [{ orderId, uid, name, totalMinutes, joinedAt }]
};

const packagesConfig = {
  bumpPriceBRL: 9.9,
  bumpMinutes: 30,
  cryptoDiscountRate: 0.15,
  mpFeeRate: 0.01,   // 1% taxa Mercado Pago embutida no preço PIX
  npFeeRate: 0.005,  // 0,5% taxa NOWPayments embutida no preço Crypto
  usdtRateBRL: 5.0,
  packages: {
    trial_10m: { id: 'trial_10m', name: 'Teste Rápido (10 min)', minutes: 10, bonusMinutes: 0, priceBRL: 3.8 },
    hour_1h: { id: 'hour_1h', name: 'Sessão 1 Hora', minutes: 60, bonusMinutes: 0, priceBRL: 22.75 },
    combo_2h: { id: 'combo_2h', name: 'Combo Heist Leonida (2h15)', minutes: 120, bonusMinutes: 15, priceBRL: 44.9 },
    pass_4h: { id: 'pass_4h', name: 'Passaporte Madrugada (5h)', minutes: 240, bonusMinutes: 60, priceBRL: 86.9 }
  }
};

function grossUp(amount, feeRate) {
  return Math.round((amount / (1 - feeRate)) * 100) / 100;
}

const orders = new Map(); // orderId -> order
const viewers = new Map(); // clientId -> lastSeen

// ---------------------------------------------------------------------------
// Estado compartilhado opcional (Upstash Redis / Vercel KV via REST, 0 deps)
// ---------------------------------------------------------------------------
const KV_STATE_KEY = 'playgta6:state:v1';
let lastKvSync = 0;

async function syncStateFromKv(force) {
  if (!kvEnabled()) return;
  const now = Date.now();
  if (!force && now - lastKvSync < 2000) return;
  lastKvSync = now;
  try {
    const r = await fetch(ENV.KV_REST_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ENV.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['GET', KV_STATE_KEY]),
      signal: AbortSignal.timeout(4000)
    });
    if (!r.ok) return;
    const data = await r.json();
    if (!data || typeof data.result !== 'string') return;
    const snap = JSON.parse(data.result);
    if (snap.ps5Config) {
      Object.assign(ps5Config, snap.ps5Config);
      if (ps5Config.activePlayer && Number.isFinite(snap.savedAt)) {
        const elapsedSec = Math.max(0, Math.floor((now - snap.savedAt) / 1000));
        ps5Config.activePlayer.remainingSeconds = Math.max(0, ps5Config.activePlayer.remainingSeconds - elapsedSec);
        if (ps5Config.activePlayer.remainingSeconds <= 0) finishActive();
      }
    }
    if (snap.packagesConfig && snap.packagesConfig.packages) {
      if (typeof snap.packagesConfig.bumpPriceBRL === 'number') packagesConfig.bumpPriceBRL = snap.packagesConfig.bumpPriceBRL;
      for (const id of Object.keys(packagesConfig.packages)) {
        const savedPkg = snap.packagesConfig.packages[id];
        if (savedPkg && typeof savedPkg.priceBRL === 'number') packagesConfig.packages[id].priceBRL = savedPkg.priceBRL;
      }
    }
    if (Array.isArray(snap.orders)) {
      for (const so of snap.orders) {
        if (!so || !so.orderId) continue;
        const local = orders.get(so.orderId);
        orders.set(so.orderId, local ? { ...so, pixQrBase64: local.pixQrBase64 || null } : so);
      }
    }
  } catch (err) {
    console.error('[playgta6] KV load erro:', err.message);
  }
}

async function persistStateToKv() {
  if (!kvEnabled()) return;
  try {
    const snap = {
      savedAt: Date.now(),
      ps5Config,
      packagesConfig: {
        bumpPriceBRL: packagesConfig.bumpPriceBRL,
        packages: Object.fromEntries(
          Object.entries(packagesConfig.packages).map(([k, v]) => [k, { priceBRL: v.priceBRL }])
        )
      },
      orders: [...orders.values()]
        .slice(-150)
        .map(({ pixQrBase64, ...rest }) => rest)
    };
    await fetch(ENV.KV_REST_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ENV.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['SET', KV_STATE_KEY, JSON.stringify(snap)]),
      signal: AbortSignal.timeout(4000)
    });
    lastKvSync = Date.now();
  } catch (err) {
    console.error('[playgta6] KV save erro:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function unsign(token, type) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!safeEqual(sig, hmac(body))) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!obj || obj.t !== type || !obj.exp || Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

function clip(str, max) {
  return String(str || '').replace(/[\u0000-\u001f<>`]/g, '').trim().slice(0, max);
}

function maskName(name) {
  const n = String(name || 'Jogador');
  return n.length <= 3 ? `${n[0]}**` : `${n.slice(0, 3)}***`;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const raw = part.slice(idx + 1).trim();
      try {
        out[k] = decodeURIComponent(raw);
      } catch {
        out[k] = raw;
      }
    }
  }
  return out;
}

function getBaseUrl(req) {
  if (ENV.BASE_URL) return ENV.BASE_URL;
  const fwd = ENV.TRUST_PROXY && req.headers['x-forwarded-proto'];
  const proto = fwd ? String(fwd).split(',')[0].trim() : 'http';
  const rawHost = String(req.headers.host || '').trim();
  const safeHost = /^[a-zA-Z0-9.-]+(:\d+)?$/.test(rawHost) ? rawHost : `localhost:${ENV.PORT}`;
  return `${proto === 'https' ? 'https' : 'http'}://${safeHost}`;
}

function isSameOrigin(req) {
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs === 'cross-site') return false;
  const base = getBaseUrl(req);
  const origin = req.headers.origin;
  if (origin) {
    if (origin === 'null') return false;
    return origin === base;
  }
  const referer = req.headers.referer;
  if (referer) {
    return referer === base || referer.startsWith(base + '/');
  }
  return true;
}

function setCookie(req, res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (getBaseUrl(req).startsWith('https://')) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

function getIp(req) {
  if (ENV.TRUST_PROXY) {
    const vercelIp = req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'];
    if (vercelIp) return String(vercelIp).split(',')[0].trim();
    if (req.headers['x-forwarded-for']) {
      return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > 32 * 1024) {
        aborted = true;
        reject(new Error('Payload muito grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function makeLimiter(windowMs, max) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      if (hits.size > 10000) {
        let removed = 0;
        for (const k of hits.keys()) {
          hits.delete(k);
          if (++removed >= 2000) break;
        }
      }
    }
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    rec.count += 1;
    return rec.count <= max;
  };
}

const globalLimiter = makeLimiter(60_000, 150);
const checkoutLimiter = makeLimiter(60_000, 10);
const checkoutIpLimiter = makeLimiter(60_000, 15);
const adminActionLimiter = makeLimiter(60_000, 60);
const webhookLimiter = makeLimiter(60_000, 30);

function getSessionUser(req) {
  const data = unsign(parseCookies(req).pg6_session, 'sess');
  return data ? data.u : null;
}

function isAdminUser(user) {
  if (!user || user.provider !== 'discord' || typeof user.uid !== 'string') return false;
  if (!user.uid.startsWith('discord:')) return false;
  const discordId = user.uid.slice('discord:'.length);
  if (ENV.ADMIN_DISCORD_IDS.size > 0) return ENV.ADMIN_DISCORD_IDS.has(discordId);
  const digest = crypto.createHash('sha256').update(discordId).digest('hex');
  return DEFAULT_ADMIN_HASHES.has(digest);
}

function issueCsrf(uid) {
  return sign({ t: 'csrf', u: uid || 'anon', n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 2 * 60 * 60 * 1000 });
}

function verifyCsrf(token, uid, strictUid) {
  const data = unsign(token, 'csrf');
  if (!data) return false;
  if (strictUid) return !!uid && data.u === uid;
  return data.u === (uid || 'anon') || data.u === 'anon';
}

// ---------------------------------------------------------------------------
// Mercado Pago API v1 (PIX Automático + QR Code + Webhook / Verificação)
// ---------------------------------------------------------------------------
async function createMercadoPagoPix(req, order, user) {
  const payerEmail =
    user.handle && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.handle)
      ? user.handle
      : `player.${order.orderId.toLowerCase()}@playgta6.com`;

  const expires = new Date(Date.now() + 30 * 60_000).toISOString().replace('Z', '-00:00');
  const baseUrl = getBaseUrl(req);
  const body = {
    transaction_amount: Number(order.finalPriceBRL.toFixed(2)),
    description: `playgta6 - ${order.packageName}`,
    payment_method_id: 'pix',
    external_reference: order.orderId,
    date_of_expiration: expires,
    payer: {
      email: payerEmail,
      first_name: (user.name || 'Jogador').split(' ')[0].slice(0, 40)
    }
  };

  if (baseUrl.startsWith('https://') && !baseUrl.includes('localhost')) {
    body.notification_url = `${baseUrl}/api/webhooks/mercadopago`;
  }

  const r = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ENV.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': order.orderId
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[playgta6] Mercado Pago erro:', r.status, JSON.stringify(data));
    throw new Error('Erro ao gerar PIX no Mercado Pago. Verifique seu Access Token.');
  }

  const tx = data.point_of_interaction?.transaction_data || {};
  if (!tx.qr_code) {
    console.error('[playgta6] Mercado Pago sem qr_code:', JSON.stringify(data));
    throw new Error('Mercado Pago não retornou o código PIX. Verifique se sua conta tem chave PIX ativa.');
  }
  const pixPayload = String(tx.qr_code).trim();
  const cleanMpQr = typeof tx.qr_code_base64 === 'string' && tx.qr_code_base64.trim()
    ? tx.qr_code_base64.replace(/\s+/g, '')
    : null;
  const pixQrBase64 = cleanMpQr || (await generateQrBase64(pixPayload));

  return {
    mpPaymentId: String(data.id),
    pixPayload,
    pixQrBase64,
    ticketUrl: typeof tx.ticket_url === 'string' && /^https:\/\//.test(tx.ticket_url) ? tx.ticket_url : null
  };
}

async function syncMercadoPagoPayment(order) {
  if (!mpEnabled() || !order || !order.mpPaymentId || order.status !== 'pending') return;
  const now = Date.now();
  if (order.lastMpCheck && now - order.lastMpCheck < 3500) return;
  order.lastMpCheck = now;

  try {
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(order.mpPaymentId)}`, {
      headers: { Authorization: `Bearer ${ENV.MP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return;
    const data = await r.json();
    const amountOk = Number(data.transaction_amount) >= order.finalPriceBRL - 0.01;
    const refOk = Boolean(data.external_reference) && String(data.external_reference) === order.orderId;
    if (data.status === 'approved' && amountOk && refOk) {
      const approvedAt = Date.parse(data.date_approved || data.date_last_updated || '');
      const sessionMs = order.totalMinutes * 60_000;
      if (Number.isFinite(approvedAt) && Date.now() - approvedAt > sessionMs) {
        order.status = 'completed';
      } else {
        enqueueOrActivate(order);
      }
    } else if (data.status === 'cancelled' || data.status === 'rejected') {
      order.status = 'cancelled';
    }
  } catch (err) {
    console.error('[playgta6] Falha ao consultar Mercado Pago:', err.message);
  }
}

function verifyMercadoPagoSignature(req, dataId) {
  if (!ENV.MP_WEBHOOK_SECRET) return true;
  const sigHeader = String(req.headers['x-signature'] || '');
  if (!sigHeader) return false;
  const parts = {};
  for (const seg of sigHeader.split(',')) {
    const idx = seg.indexOf('=');
    if (idx > 0) parts[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
  }
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !/^\d{9,14}$/.test(ts)) return false;
  const tsSec = ts.length > 11 ? Math.floor(Number(ts) / 1000) : Number(ts);
  if (Math.abs(Math.floor(Date.now() / 1000) - tsSec) > 300) return false;

  const requestId = String(req.headers['x-request-id'] || '').trim();
  let manifest = '';
  if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  const expected = crypto.createHmac('sha256', ENV.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeEqual(v1, expected);
}

// ---------------------------------------------------------------------------
// NOWPayments API v1 (Moedas e redes exatamente habilitadas na loja + /v1/merchant/coins)
// ---------------------------------------------------------------------------
const CRYPTO_CATALOG = [
  // Stablecoins
  { id: 'usdttrc20', label: 'USDT', network: 'TRC20 (Tron)', group: 'Stablecoins' },
  { id: 'usdtbsc', label: 'USDT', network: 'BEP20 (BSC)', group: 'Stablecoins' },
  { id: 'usdtmatic', label: 'USDT', network: 'Polygon', group: 'Stablecoins' },
  { id: 'usdtarb', label: 'USDT', network: 'Arbitrum', group: 'Stablecoins' },
  { id: 'usdtop', label: 'USDT', network: 'Optimism', group: 'Stablecoins' },
  { id: 'usdtton', label: 'USDT', network: 'TON', group: 'Stablecoins' },
  { id: 'usdterc20', label: 'USDT', network: 'ERC20 (Ethereum)', group: 'Stablecoins' },
  { id: 'usdtavaxc', label: 'USDT', network: 'AVAX C-Chain', group: 'Stablecoins' },
  { id: 'usdcsol', label: 'USDC', network: 'Solana', group: 'Stablecoins' },
  { id: 'usdcmatic', label: 'USDC', network: 'Polygon', group: 'Stablecoins' },
  { id: 'usdcbsc', label: 'USDC', network: 'BEP20 (BSC)', group: 'Stablecoins' },
  { id: 'usdcarb', label: 'USDC', network: 'Arbitrum', group: 'Stablecoins' },
  { id: 'usdcop', label: 'USDC', network: 'Optimism', group: 'Stablecoins' },
  { id: 'usdc', label: 'USDC', network: 'ERC20 (Ethereum)', group: 'Stablecoins' },
  // Popular Coins
  { id: 'btc', label: 'BTC', network: 'Bitcoin', group: 'Populares' },
  { id: 'eth', label: 'ETH', network: 'Ethereum', group: 'Populares' },
  { id: 'ltc', label: 'LTC', network: 'Litecoin', group: 'Populares' },
  { id: 'trx', label: 'TRX', network: 'Tron (TRC20)', group: 'Populares' },
  { id: 'bnbbsc', label: 'BNB', network: 'BSC (BEP20)', group: 'Populares' },
  { id: 'ton', label: 'TON', network: 'TON Network', group: 'Populares' }
];

const CRYPTO_BY_ID = Object.fromEntries(CRYPTO_CATALOG.map((c) => [c.id, c]));
const CRYPTO_ALIASES = { usdt: 'usdttrc20', btc: 'btc', ltc: 'ltc', eth: 'eth', trx: 'trx', ton: 'ton', bnb: 'bnbbsc' };

function resolveCryptoOption(method) {
  const key = CRYPTO_ALIASES[method] || method;
  return CRYPTO_BY_ID[key] || null;
}

let npCoinsCache = { fetchedAt: 0, coins: null };

async function getNowPaymentsAvailableOptions() {
  if (!npEnabled()) return CRYPTO_CATALOG;
  const now = Date.now();
  if (npCoinsCache.coins && now - npCoinsCache.fetchedAt < 10 * 60_000) {
    return npCoinsCache.coins;
  }
  try {
    const r = await fetch('https://api.nowpayments.io/v1/merchant/coins', {
      headers: { 'x-api-key': ENV.NOWPAYMENTS_API_KEY },
      signal: AbortSignal.timeout(6000)
    });
    if (r.ok) {
      const data = await r.json();
      const enabledSet = new Set((data.selectedCurrencies || []).map((c) => String(c).toLowerCase()));
      if (enabledSet.size > 0) {
        const filtered = CRYPTO_CATALOG.filter((c) => enabledSet.has(c.id));
        const result = filtered.length > 0 ? filtered : CRYPTO_CATALOG;
        npCoinsCache = { fetchedAt: now, coins: result, rawCount: enabledSet.size };
        return result;
      }
    }
  } catch (err) {
    console.error('[playgta6] Falha ao listar moedas NOWPayments:', err.message);
  }
  return CRYPTO_CATALOG;
}

async function createNowPaymentsCrypto(req, order) {
  const opt = resolveCryptoOption(order.paymentMethod) || CRYPTO_CATALOG[0];
  const payCurrency = opt.id;
  const baseUrl = getBaseUrl(req);
  const body = {
    price_amount: Number(order.finalPriceBRL.toFixed(2)),
    price_currency: 'brl',
    pay_currency: payCurrency,
    order_id: order.orderId,
    order_description: `playgta6 - ${order.packageName}`
  };

  if (baseUrl.startsWith('https://') && !baseUrl.includes('localhost')) {
    body.ipn_callback_url = `${baseUrl}/api/webhooks/nowpayments`;
  }

  const r = await fetch('https://api.nowpayments.io/v1/payment', {
    method: 'POST',
    headers: {
      'x-api-key': ENV.NOWPAYMENTS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.pay_address) {
    console.error('[playgta6] NOWPayments erro:', r.status, JSON.stringify(data));
    const rawMsg = String(data.message || '').toLowerCase();
    let userMsg = 'Erro ao gerar pagamento Crypto na NOWPayments.';
    if (r.status === 401 || r.status === 403 || rawMsg.includes('api key')) {
      userMsg = 'Chave da NOWPayments inválida. Verifique NOWPAYMENTS_API_KEY na Vercel.';
    } else if (rawMsg.includes('minimal') || rawMsg.includes('less than') || rawMsg.includes('minimum')) {
      userMsg = 'Valor abaixo do mínimo aceito por esta rede Crypto. Tente USDT (Polygon/BEP20), LTC, TRX, TON ou pague via PIX.';
    } else if (rawMsg.includes('payout') || rawMsg.includes('wallet') || rawMsg.includes('address')) {
      userMsg = 'Configure sua carteira de recebimento (Outcome Wallet) no painel da NOWPayments.';
    } else if (rawMsg.includes('currency') || rawMsg.includes('estimate') || rawMsg.includes('unavailable')) {
      userMsg = 'Esta rede/moeda não está habilitada na sua conta NOWPayments. Tente outra rede ou pague via PIX.';
    }
    const err = new Error(userMsg);
    err.isSafeUserError = true;
    throw err;
  }

  return {
    npPaymentId: String(data.payment_id),
    cryptoWallet: String(data.pay_address),
    cryptoPayAmount: data.pay_amount !== undefined ? String(data.pay_amount) : null,
    cryptoPayCurrency: String(data.pay_currency || payCurrency).toUpperCase(),
    cryptoNetwork: data.network ? String(data.network).toUpperCase() : opt.network,
    cryptoExtraId: data.payin_extra_id ? String(data.payin_extra_id) : null
  };
}

async function syncNowPaymentsPayment(order) {
  if (!npEnabled() || !order || !order.npPaymentId || order.status !== 'pending') return;
  const now = Date.now();
  if (order.lastNpCheck && now - order.lastNpCheck < 4000) return;
  order.lastNpCheck = now;

  try {
    const r = await fetch(`https://api.nowpayments.io/v1/payment/${encodeURIComponent(order.npPaymentId)}`, {
      headers: { 'x-api-key': ENV.NOWPAYMENTS_API_KEY },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return;
    const data = await r.json();
    const refOk = Boolean(data.order_id) && String(data.order_id) === order.orderId;
    const amountOk = Number(data.price_amount || 0) >= order.finalPriceBRL - 0.05;
    if ((data.payment_status === 'finished' || data.payment_status === 'confirmed') && refOk && amountOk) {
      const paidAt = Date.parse(data.updated_at || data.created_at || '');
      const sessionMs = order.totalMinutes * 60_000;
      if (Number.isFinite(paidAt) && Date.now() - paidAt > sessionMs) {
        order.status = 'completed';
      } else {
        enqueueOrActivate(order);
      }
    } else if (['failed', 'refunded', 'expired'].includes(data.payment_status)) {
      order.status = 'expired';
    }
  } catch (err) {
    console.error('[playgta6] Falha ao consultar NOWPayments:', err.message);
  }
}

function sortKeysRecursive(val) {
  if (Array.isArray(val)) return val.map(sortKeysRecursive);
  if (val && typeof val === 'object') {
    return Object.keys(val)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeysRecursive(val[k]);
        return acc;
      }, {});
  }
  return val;
}

function verifyNowPaymentsIpn(bodyObj, sigHeader) {
  if (!ENV.NOWPAYMENTS_IPN_SECRET) return true;
  if (!sigHeader) return false;
  const sorted = sortKeysRecursive(bodyObj || {});
  const expected = crypto.createHmac('sha512', ENV.NOWPAYMENTS_IPN_SECRET).update(JSON.stringify(sorted)).digest('hex');
  return safeEqual(sigHeader, expected);
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------
function startSession(order) {
  order.status = 'active';
  ps5Config.activePlayer = {
    orderId: order.orderId,
    uid: order.uid,
    name: order.userName,
    totalMinutes: order.totalMinutes,
    remainingSeconds: order.totalMinutes * 60,
    startedAt: new Date().toISOString()
  };
  ps5Config.consoleStatus = 'busy';
}

function enqueueOrActivate(order) {
  if (!order || !['pending'].includes(order.status)) return;
  order.paidAt = new Date().toISOString();
  if (!ps5Config.activePlayer && ps5Config.consoleStatus !== 'maintenance') {
    startSession(order);
  } else {
    order.status = 'queued';
    ps5Config.queue.push({
      orderId: order.orderId,
      uid: order.uid,
      name: order.userName,
      totalMinutes: order.totalMinutes,
      joinedAt: new Date().toISOString()
    });
  }
}

function finishActive() {
  if (ps5Config.activePlayer) {
    const done = orders.get(ps5Config.activePlayer.orderId);
    if (done) done.status = 'completed';
  }
  ps5Config.activePlayer = null;
  advanceQueue();
}

function advanceQueue() {
  if (ps5Config.activePlayer || ps5Config.consoleStatus === 'maintenance' || ps5Config.emergencyOffline) return;
  while (ps5Config.queue.length > 0) {
    const next = ps5Config.queue.shift();
    const order = next && orders.get(next.orderId);
    if (order && order.status === 'queued') {
      startSession(order);
      return;
    }
  }
  if (ps5Config.consoleStatus === 'busy') ps5Config.consoleStatus = 'online';
}

function queueSummary(publicView) {
  const activeSeconds = ps5Config.activePlayer ? ps5Config.activePlayer.remainingSeconds : 0;
  let cumulative = activeSeconds;
  const items = ps5Config.queue.map((q, idx) => {
    const wait = Math.ceil(cumulative / 60);
    cumulative += q.totalMinutes * 60;
    return {
      position: idx + 1,
      orderId: publicView ? undefined : q.orderId,
      name: publicView ? maskName(q.name) : q.name,
      totalMinutes: q.totalMinutes,
      estimatedWaitMinutes: wait
    };
  });
  return {
    peopleAheadCount: (ps5Config.activePlayer ? 1 : 0) + ps5Config.queue.length,
    queueOnlyCount: ps5Config.queue.length,
    estimatedWaitMinutesForNewPlayer: Math.ceil(cumulative / 60),
    items
  };
}

setInterval(() => {
  // Cronômetro da sessão ativa
  if (ps5Config.activePlayer) {
    ps5Config.activePlayer.remainingSeconds -= 1;
    if (ps5Config.activePlayer.remainingSeconds <= 0) finishActive();
  } else {
    advanceQueue();
  }
}, 1000).unref();

setInterval(() => {
  const now = Date.now();
  // Pedidos não pagos expiram em 30 min
  for (const o of orders.values()) {
    if (o.status === 'pending' && now - Date.parse(o.createdAt) > 30 * 60_000) o.status = 'expired';
  }
  // Mantém no máximo 300 pedidos
  if (orders.size > 300) {
    const removable = [...orders.values()].filter((o) => !['active', 'queued'].includes(o.status));
    removable.slice(0, orders.size - 300).forEach((o) => orders.delete(o.orderId));
  }
  // Espectadores ativos nos últimos 30s
  for (const [id, ts] of viewers) if (now - ts > 30_000) viewers.delete(id);
}, 15_000).unref();

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------
function calculateOrder(packageId, includeBump, paymentMethod) {
  const pkg = packagesConfig.packages[packageId];
  if (!pkg) throw new Error('Selecione um pacote válido.');
  const bumpBase = includeBump ? packagesConfig.bumpPriceBRL : 0;
  const bumpMinutes = includeBump ? packagesConfig.bumpMinutes : 0;
  const baseSubtotal = Math.round((pkg.priceBRL + bumpBase) * 100) / 100;
  const cryptoOpt = resolveCryptoOption(paymentMethod);
  const isCrypto = !!cryptoOpt;

  if (isCrypto && !CRYPTO_ENABLED) {
    const err = new Error('Pagamento em Crypto disponível em breve. Utilize PIX.');
    err.isSafeUserError = true;
    throw err;
  }

  if (isCrypto && pkg.id === 'trial_10m' && !includeBump) {
    const err = new Error('Pagamento em Crypto disponível a partir do plano de 1 hora.');
    err.isSafeUserError = true;
    throw err;
  }

  const pixSubtotal = grossUp(baseSubtotal, packagesConfig.mpFeeRate);
  let finalPriceBRL;
  let discount;

  if (isCrypto) {
    const cryptoNet = baseSubtotal * (1 - packagesConfig.cryptoDiscountRate);
    finalPriceBRL = grossUp(cryptoNet, packagesConfig.npFeeRate);
    discount = Math.round((pixSubtotal - finalPriceBRL) * 100) / 100;
  } else {
    finalPriceBRL = pixSubtotal;
    discount = 0;
  }

  return {
    packageId: pkg.id,
    packageName: pkg.name,
    baseMinutes: pkg.minutes,
    bonusMinutes: pkg.bonusMinutes,
    bumpMinutes,
    totalMinutes: pkg.minutes + pkg.bonusMinutes + bumpMinutes,
    subtotalBRL: pixSubtotal,
    discountBRL: discount,
    finalPriceBRL,
    finalUSDT: (finalPriceBRL / packagesConfig.usdtRateBRL).toFixed(2),
    paymentMethod: isCrypto ? cryptoOpt.id : 'pix',
    cryptoNetwork: isCrypto ? cryptoOpt.network : null,
    isCrypto
  };
}

function issueOrderToken(o) {
  return sign({
    t: 'ord',
    id: o.orderId,
    ca: Date.parse(o.createdAt) || Date.now(),
    uid: o.uid,
    un: o.userName,
    uh: o.userHandle,
    up: o.userProvider,
    mpId: o.mpPaymentId || null,
    npId: o.npPaymentId || null,
    pkg: o.packageId,
    pn: o.packageName,
    tm: o.totalMinutes,
    brl: o.finalPriceBRL,
    usdt: o.finalUSDT,
    pm: o.paymentMethod,
    cr: o.isCrypto,
    ps: o.pixSource || null,
    exp: Date.now() + 2 * 60 * 60 * 1000
  });
}

function publicOrder(o) {
  const queueIdx = ps5Config.queue.findIndex((q) => q.orderId === o.orderId);
  const summary = queueSummary(true);
  const isActive = o.status === 'active' && ps5Config.activePlayer?.orderId === o.orderId;
  return {
    orderId: o.orderId,
    orderToken: issueOrderToken(o),
    status: o.status,
    expiresAt: Date.parse(o.createdAt) + 30 * 60_000,
    packageName: o.packageName,
    totalMinutes: o.totalMinutes,
    finalPriceBRL: o.finalPriceBRL,
    finalUSDT: o.finalUSDT,
    paymentMethod: o.paymentMethod,
    isCrypto: o.isCrypto,
    paymentCode: o.isCrypto ? o.cryptoWallet : o.pixPayload,
    pixQrBase64: o.pixQrBase64 || null,
    pixSource: o.pixSource || null,
    mpMode: o.pixSource === 'mercadopago' ? mpMode() : 'none',
    ticketUrl: o.ticketUrl || null,
    cryptoPayAmount: o.isCrypto ? o.cryptoPayAmount || null : null,
    cryptoPayCurrency: o.isCrypto ? o.cryptoPayCurrency || o.paymentMethod.toUpperCase() : null,
    cryptoNetwork: o.isCrypto ? o.cryptoNetwork || null : null,
    cryptoExtraId: o.isCrypto ? o.cryptoExtraId || null : null,
    queuePosition: queueIdx >= 0 ? queueIdx + 1 : null,
    estimatedWaitMinutes: queueIdx >= 0 ? summary.items[queueIdx].estimatedWaitMinutes : null,
    remainingSeconds: isActive ? ps5Config.activePlayer.remainingSeconds : null,
    // PIN e link só são revelados quando é a vez do jogador
    accessPin: isActive ? ps5Config.remotePlayPin : null,
    parsecInviteUrl: isActive ? ps5Config.parsecInviteUrl : null
  };
}

// ---------------------------------------------------------------------------
// OAuth2 (Discord / Google)
// ---------------------------------------------------------------------------
const OAUTH = {
  discord: {
    label: 'Discord',
    clientId: () => ENV.DISCORD_CLIENT_ID,
    clientSecret: () => ENV.DISCORD_CLIENT_SECRET,
    authUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    scope: 'identify',
    extra: {},
    async profile(accessToken) {
      const r = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) throw new Error(`discord profile ${r.status}`);
      const u = await r.json();
      return {
        id: String(u.id),
        name: u.global_name || u.username,
        handle: u.username,
        avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null
      };
    }
  },
  google: {
    label: 'Google',
    clientId: () => ENV.GOOGLE_CLIENT_ID,
    clientSecret: () => ENV.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid profile email',
    extra: { prompt: 'select_account' },
    async profile(accessToken) {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) throw new Error(`google profile ${r.status}`);
      const u = await r.json();
      return { id: String(u.sub), name: u.name || u.email, handle: u.email, avatar: u.picture || null };
    }
  }
};

const providerEnabled = (p) => !!(OAUTH[p] && OAUTH[p].clientId() && OAUTH[p].clientSecret());

function oauthStart(req, res, provider, nextPath) {
  const safeNext = nextPath === '/admin' ? '/admin' : '/';
  if (!providerEnabled(provider)) return redirect(res, `${safeNext}?auth_error=${provider}_not_configured`);
  const cfg = OAUTH[provider];
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(req, res, 'pg6_oauth', sign({ t: 'oauth', s: state, p: provider, next: safeNext, exp: Date.now() + 10 * 60_000 }), 600);
  const params = new URLSearchParams({
    client_id: cfg.clientId(),
    redirect_uri: `${getBaseUrl(req)}/auth/${provider}/callback`,
    response_type: 'code',
    scope: cfg.scope,
    state,
    ...cfg.extra
  });
  redirect(res, `${cfg.authUrl}?${params}`);
}

async function oauthCallback(req, res, provider, query) {
  const cfg = OAUTH[provider];
  const saved = unsign(parseCookies(req).pg6_oauth, 'oauth');
  setCookie(req, res, 'pg6_oauth', '', 0);
  const safeNext = saved && saved.next === '/admin' ? '/admin' : '/';

  if (query.get('error')) return redirect(res, `${safeNext}?auth_error=cancelled`);
  if (!providerEnabled(provider)) return redirect(res, `${safeNext}?auth_error=${provider}_not_configured`);
  if (!saved || saved.p !== provider || !query.get('state') || !safeEqual(query.get('state'), saved.s)) {
    return redirect(res, `${safeNext}?auth_error=state`);
  }

  try {
    const tokenRes = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: cfg.clientId(),
        client_secret: cfg.clientSecret(),
        grant_type: 'authorization_code',
        code: query.get('code') || '',
        redirect_uri: `${getBaseUrl(req)}/auth/${provider}/callback`
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!tokenRes.ok) throw new Error(`${provider} token ${tokenRes.status}: ${await tokenRes.text()}`);
    const token = await tokenRes.json();
    const profile = await cfg.profile(token.access_token);

    const user = {
      uid: `${provider}:${profile.id}`,
      provider,
      name: clip(profile.name, 60) || 'Jogador',
      handle: clip(profile.handle, 80),
      avatar: profile.avatar && /^https:\/\//.test(profile.avatar) ? profile.avatar : null
    };
    const ttlMs = isAdminUser(user) ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
    setCookie(req, res, 'pg6_session', sign({ t: 'sess', u: user, exp: Date.now() + ttlMs }), ttlMs / 1000);
    redirect(res, `${safeNext}?login=ok`);
  } catch (err) {
    console.error('[playgta6] Falha no OAuth:', err.message);
    redirect(res, `${safeNext}?auth_error=failed`);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https://cdn.discordapp.com https://*.googleusercontent.com",
      "script-src 'self'",
      "connect-src 'self'",
      'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://vdo.ninja',
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
  if (getBaseUrl(req).startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname, user) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  // Normaliza barras duplicadas e segmentos '.' / '..' antes de qualquer checagem
  const normalizedUrlPath = path.posix.normalize(decoded.replace(/\\/g, '/'));
  const isAdminShortcut = normalizedUrlPath.toLowerCase() === '/admin' || normalizedUrlPath.toLowerCase() === '/admin/';
  let rel = normalizedUrlPath === '/' ? '/index.html' : normalizedUrlPath;
  if (isAdminShortcut) rel = '/admin.html';

  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // Proteção server-side infalível contra bypass por URL-encoding, case-sensitivity ou barras extras
  const relFromPublic = path.relative(PUBLIC_DIR, abs).replace(/\\/g, '/').toLowerCase();
  const isAdminAsset = relFromPublic === 'admin.html' || relFromPublic === 'admin.js';
  if (isAdminAsset) {
    if (!user) {
      if (isAdminShortcut && req.method === 'GET') return redirect(res, '/auth/discord?next=/admin');
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? '' : '404 - Página não encontrada');
    }
    if (!isAdminUser(user)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? '' : '404 - Página não encontrada');
    }
  }

  fs.readFile(abs, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? '' : '404 - Página não encontrada');
    }
    const headers = {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': isAdminAsset ? 'no-store' : 'no-cache'
    };
    if (isAdminAsset) headers['X-Robots-Tag'] = 'noindex, nofollow';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? '' : content);
  });
}

const ALLOWED_STREAM_HOSTS = new Set(['www.youtube.com', 'www.youtube-nocookie.com', 'player.twitch.tv', 'vdo.ninja']);

function isValidHttpsUrl(raw, allowedHosts) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'https:') return false;
    if (allowedHosts && !allowedHosts.has(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

async function handler(req, res) {
  securityHeaders(req, res);
  const ip = getIp(req);
  if (!globalLimiter(ip)) return sendJson(res, 429, { error: 'Muitas requisições. Aguarde 1 minuto.' });

  const rawUrl = String(req.url || '/');
  const url = new URL(rawUrl.startsWith('//') ? '/' + rawUrl.replace(/^\/+/, '') : rawUrl, 'http://local');
  const p = url.pathname;
  const user = getSessionUser(req);

  try {
    // ---------------- Auth ----------------
    const authMatch = p.match(/^\/auth\/(discord|google)(\/callback)?$/);
    if (req.method === 'GET' && authMatch) {
      return authMatch[2]
        ? oauthCallback(req, res, authMatch[1], url.searchParams)
        : oauthStart(req, res, authMatch[1], url.searchParams.get('next'));
    }

    if (req.method === 'POST' && p === '/auth/logout') {
      if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'Origem inválida.' });
      setCookie(req, res, 'pg6_session', '', 0);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/me') {
      return sendJson(res, 200, {
        user: user ? { name: user.name, handle: user.handle, avatar: user.avatar, provider: user.provider } : null,
        isAdmin: isAdminUser(user),
        csrfToken: issueCsrf(user?.uid),
        providers: { discord: providerEnabled('discord'), google: providerEnabled('google') },
        demoMode: isDemoMode()
      });
    }

    // ---------------- Público ----------------
    if (req.method === 'GET' && p === '/api/config') {
      await syncStateFromKv(false);
      const cid = url.searchParams.get('cid');
      if (cid && /^[a-z0-9]{8,32}$/.test(cid) && viewers.size < 5000) viewers.set(cid, Date.now());
      const ap = ps5Config.activePlayer;
      const cryptoOptions = CRYPTO_ENABLED ? await getNowPaymentsAvailableOptions() : CRYPTO_CATALOG;
      return sendJson(res, 200, {
        csrfToken: issueCsrf(user?.uid),
        packages: packagesConfig.packages,
        bumpPriceBRL: packagesConfig.bumpPriceBRL,
        cryptoDiscountRate: packagesConfig.cryptoDiscountRate,
        mpFeeRate: packagesConfig.mpFeeRate,
        npFeeRate: packagesConfig.npFeeRate,
        usdtRateBRL: packagesConfig.usdtRateBRL,
        cryptoOptions: cryptoOptions.map((c) => ({ id: c.id, label: c.label, network: c.network, group: c.group })),
        ps5Public: {
          consoleStatus: ps5Config.emergencyOffline ? 'maintenance' : ps5Config.consoleStatus,
          emergencyOffline: ps5Config.emergencyOffline,
          streamSourceUrl: ps5Config.streamSourceUrl,
          streamTitle: ps5Config.streamTitle,
          viewersCount: Math.max(1, viewers.size),
          activePlayer: ap ? { name: maskName(ap.name), remainingSeconds: ap.remainingSeconds } : null,
          queueSummary: queueSummary(true)
        }
      });
    }

    if (req.method === 'POST' && p === '/api/checkout') {
      if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'Origem inválida.' });
      await syncStateFromKv(true);
      if (ps5Config.emergencyOffline) return sendJson(res, 503, { error: 'Sistema desligado em modo de emergência. Tente mais tarde.' });
      if (!user) return sendJson(res, 401, { error: 'login', message: 'Entre com Discord ou Google para continuar.' });
      if (!verifyCsrf(req.headers['x-csrf-token'], user.uid, true)) return sendJson(res, 403, { error: 'csrf', message: 'Sessão expirada. Tente novamente.' });
      if (!checkoutLimiter(user.uid) || !checkoutIpLimiter(ip)) return sendJson(res, 429, { error: 'Muitos pedidos seguidos. Aguarde um pouco.' });

      const pendingCount = [...orders.values()].filter((o) => o.uid === user.uid && o.status === 'pending').length;
      if (pendingCount >= 3) return sendJson(res, 429, { error: 'Você já tem pedidos aguardando pagamento.' });

      const body = await readJson(req);
      const calc = calculateOrder(String(body.packageId || ''), body.includeBump === true, String(body.paymentMethod || 'pix'));
      const orderId = `PG6${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const order = {
        orderId,
        createdAt: new Date().toISOString(),
        uid: user.uid,
        userName: user.name,
        userHandle: user.handle,
        userProvider: user.provider,
        status: 'pending',
        ...calc,
        mpPaymentId: null,
        npPaymentId: null,
        pixPayload: '',
        pixQrBase64: null,
        pixSource: null,
        ticketUrl: null,
        cryptoPayAmount: null,
        cryptoPayCurrency: null,
        cryptoExtraId: null,
        cryptoWallet: ''
      };

      if (!order.isCrypto) {
        if (!mpEnabled()) {
          return sendJson(res, 503, { error: 'PIX (Mercado Pago) não está configurado no servidor. Adicione MP_ACCESS_TOKEN na Vercel.' });
        }
        const mp = await createMercadoPagoPix(req, order, user);
        order.mpPaymentId = mp.mpPaymentId;
        order.pixPayload = mp.pixPayload;
        order.pixQrBase64 = mp.pixQrBase64;
        order.ticketUrl = mp.ticketUrl;
        order.pixSource = 'mercadopago';
      } else {
        if (!npEnabled()) {
          return sendJson(res, 503, { error: 'Crypto (NOWPayments) não está configurado no servidor. Adicione NOWPAYMENTS_API_KEY na Vercel.' });
        }
        const np = await createNowPaymentsCrypto(req, order);
        order.npPaymentId = np.npPaymentId;
        order.cryptoWallet = np.cryptoWallet;
        order.cryptoPayAmount = np.cryptoPayAmount;
        order.cryptoPayCurrency = np.cryptoPayCurrency;
        order.cryptoNetwork = np.cryptoNetwork;
        order.cryptoExtraId = np.cryptoExtraId;
        order.pixQrBase64 = await generateQrBase64(order.cryptoWallet);
      }

      orders.set(orderId, order);
      await persistStateToKv();
      return sendJson(res, 200, { ok: true, order: publicOrder(order) });
    }

    if (req.method === 'GET' && p === '/api/order') {
      if (!user) return sendJson(res, 401, { error: 'login' });
      await syncStateFromKv(false);
      const id = String(url.searchParams.get('id') || '');
      let o = orders.get(id);

      // Rehidrata pedido a partir do token assinado HMAC (resolve múltiplas instâncias serverless na Vercel!)
      if (!o) {
        const tok = unsign(url.searchParams.get('ot') || '', 'ord');
        if (tok && tok.id === id && tok.uid === user.uid) {
          const createdMs = Number.isFinite(tok.ca) ? tok.ca : Date.now();
          o = {
            orderId: tok.id,
            createdAt: new Date(createdMs).toISOString(),
            uid: tok.uid,
            userName: tok.un || user.name,
            userHandle: tok.uh || user.handle,
            userProvider: tok.up || user.provider,
            status: 'pending',
            packageId: tok.pkg,
            packageName: tok.pn,
            totalMinutes: tok.tm,
            finalPriceBRL: tok.brl,
            finalUSDT: tok.usdt,
            paymentMethod: tok.pm,
            isCrypto: !!tok.cr,
            pixSource: tok.ps || null,
            mpPaymentId: tok.mpId || null,
            npPaymentId: tok.npId || null,
            pixPayload: '',
            pixQrBase64: null,
            cryptoWallet: ''
          };
          orders.set(id, o);
        }
      }

      if (!o || o.uid !== user.uid) return sendJson(res, 404, { error: 'Pedido não encontrado.' });
      const prevStatus = o.status;
      if (o.isCrypto) await syncNowPaymentsPayment(o);
      else await syncMercadoPagoPayment(o);
      if (o.status === 'pending' && Date.now() - Date.parse(o.createdAt) > 30 * 60_000) {
        o.status = 'expired';
      }
      if (o.status !== prevStatus) await persistStateToKv();
      return sendJson(res, 200, { ok: true, order: publicOrder(o) });
    }

    // Webhook IPN oficial da NOWPayments (confirma Crypto automaticamente)
    if (req.method === 'POST' && p === '/api/webhooks/nowpayments') {
      if (!webhookLimiter(ip)) return sendJson(res, 429, { error: 'rate_limit' });
      if (!CRYPTO_ENABLED || !npEnabled()) return sendJson(res, 200, { ok: true });
      await syncStateFromKv(true);
      const body = await readJson(req).catch(() => ({}));
      if (!verifyNowPaymentsIpn(body, req.headers['x-nowpayments-sig'])) {
        return sendJson(res, 403, { error: 'Assinatura IPN inválida.' });
      }
      const rawNpId = String(body.payment_id || '').trim();
      const npId = /^[a-zA-Z0-9_-]{4,40}$/.test(rawNpId) ? rawNpId : '';
      const target =
        orders.get(String(body.order_id || '')) ||
        (npId ? [...orders.values()].find((o) => o.npPaymentId === npId) : null);
      if (target && target.status === 'pending') {
        if (!target.npPaymentId && npId) target.npPaymentId = npId;
        if (!target.lastNpCheck || Date.now() - target.lastNpCheck >= 2000) {
          target.lastNpCheck = 0;
          await syncNowPaymentsPayment(target);
          await persistStateToKv();
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    // Webhook oficial do Mercado Pago (confirma pagamento instantaneamente)
    if (req.method === 'POST' && p === '/api/webhooks/mercadopago') {
      if (!webhookLimiter(ip)) return sendJson(res, 429, { error: 'rate_limit' });
      if (!mpEnabled()) return sendJson(res, 200, { ok: true });
      const body = await readJson(req).catch(() => ({}));
      const rawMpId = String(body?.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id') || '').trim();
      const mpId = /^\d{4,25}$/.test(rawMpId) ? rawMpId : '';
      if (!verifyMercadoPagoSignature(req, mpId)) {
        return sendJson(res, 403, { error: 'Assinatura Mercado Pago inválida.' });
      }
      await syncStateFromKv(true);
      const hasPending = [...orders.values()].some((o) => o.status === 'pending' && !o.isCrypto);
      if (!hasPending) return sendJson(res, 200, { ok: true });
      if (mpId) {
        let target = [...orders.values()].find((o) => o.mpPaymentId === mpId);
        if (!target) {
          // Consulta na API do MP para pegar external_reference
          try {
            const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(mpId)}`, {
              headers: { Authorization: `Bearer ${ENV.MP_ACCESS_TOKEN}` },
              signal: AbortSignal.timeout(8000)
            });
            if (r.ok) {
              const mpData = await r.json();
              target = orders.get(String(mpData.external_reference || ''));
              if (target && target.status === 'pending') {
                if (!target.mpPaymentId) target.mpPaymentId = mpId;
                target.lastMpCheck = 0;
                await syncMercadoPagoPayment(target);
                await persistStateToKv();
              }
            }
          } catch (err) {
            console.error('[playgta6] Webhook MP erro:', err.message);
          }
        } else if (target.status === 'pending' && (!target.lastMpCheck || Date.now() - target.lastMpCheck >= 2000)) {
          target.lastMpCheck = 0;
          await syncMercadoPagoPayment(target);
          await persistStateToKv();
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    // Simulação de pagamento: só em modo de teste e só para o dono do pedido
    if (req.method === 'POST' && p === '/api/demo/confirm') {
      if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'Origem inválida.' });
      if (!isDemoMode()) return sendJson(res, 403, { error: 'Modo de teste desativado.' });
      if (!user) return sendJson(res, 401, { error: 'login' });
      if (!verifyCsrf(req.headers['x-csrf-token'], user.uid, true)) return sendJson(res, 403, { error: 'csrf' });
      const body = await readJson(req);
      const o = orders.get(String(body.orderId || ''));
      if (!o || o.uid !== user.uid) return sendJson(res, 404, { error: 'Pedido não encontrado.' });
      enqueueOrActivate(o);
      return sendJson(res, 200, { ok: true, order: publicOrder(o) });
    }

    // ---------------- Admin (exclusivo para os IDs Discord autorizados) ----------------
    if (p.startsWith('/api/admin/')) {
      if (!user) return sendJson(res, 401, { error: 'not_logged_in', message: 'Entre com uma conta Discord autorizada.' });
      if (!isAdminUser(user)) return sendJson(res, 403, { error: 'forbidden', message: 'Sua conta não tem permissão de administrador.' });

      if (req.method === 'GET' && p === '/api/admin/state') {
        await syncStateFromKv(true);
        return sendJson(res, 200, {
          ok: true,
          csrfToken: issueCsrf(user.uid),
          adminUser: { name: user.name, handle: user.handle, avatar: user.avatar },
          ps5Config,
          packagesConfig,
          queueSummary: queueSummary(false),
          orders: [...orders.values()]
            .reverse()
            .slice(0, 60)
            .map(({ pixQrBase64, ...rest }) => rest),
          providers: { discord: providerEnabled('discord'), google: providerEnabled('google') },
          mercadoPago: mpEnabled(),
          mpMode: mpMode(),
          mpPublicKey: ENV.MP_PUBLIC_KEY,
          nowPayments: npEnabled(),
          nowPaymentsIpnConfigured: !!ENV.NOWPAYMENTS_IPN_SECRET,
          demoMode: isDemoMode()
        });
      }

      if (req.method === 'POST') {
        if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'Origem inválida.' });
        if (!adminActionLimiter(user.uid)) return sendJson(res, 429, { error: 'Muitas ações seguidas. Aguarde 1 minuto.' });
        if (!verifyCsrf(req.headers['x-csrf-token'], user.uid, true)) return sendJson(res, 403, { error: 'csrf', message: 'Sessão expirada. Recarregue a página.' });
      }

      if (req.method === 'POST' && p === '/api/admin/save') {
        await syncStateFromKv(true);
        const body = await readJson(req);
        const c = body.ps5Config || {};
        const str = (k, max) => {
          if (typeof c[k] === 'string' && c[k].trim()) ps5Config[k] = clip(c[k], max);
        };
        if (['online', 'busy', 'maintenance'].includes(c.consoleStatus)) ps5Config.consoleStatus = c.consoleStatus;
        if (['youtube', 'twitch', 'hls_webrtc'].includes(c.streamMode)) ps5Config.streamMode = c.streamMode;
        if (['parsec_chiaki', 'webrtc_capture', 'ps_remote_direct'].includes(c.connectionMode)) ps5Config.connectionMode = c.connectionMode;
        if (typeof c.streamSourceUrl === 'string' && c.streamSourceUrl.trim()) {
          if (!isValidHttpsUrl(c.streamSourceUrl, ALLOWED_STREAM_HOSTS)) {
            return sendJson(res, 400, { error: 'URL de stream deve ser HTTPS do YouTube, Twitch ou VDO.Ninja.' });
          }
          ps5Config.streamSourceUrl = clip(c.streamSourceUrl, 400);
        }
        str('streamTitle', 100);
        str('ps5LocalIp', 45);
        str('remotePlayPin', 20);
        if (typeof c.parsecInviteUrl === 'string' && c.parsecInviteUrl.trim()) {
          if (!isValidHttpsUrl(c.parsecInviteUrl)) {
            return sendJson(res, 400, { error: 'Link Parsec/WebRTC deve começar com https:// válido.' });
          }
          ps5Config.parsecInviteUrl = clip(c.parsecInviteUrl, 300);
        }

        // Mercado Pago & NOWPayments (salvos em memória e persistidos no .env local quando possível)
        const mp = body.mercadoPago || {};
        const np = body.nowPayments || {};
        let envUpdated = false;
        if (typeof mp.publicKey === 'string' && mp.publicKey.trim()) {
          ENV.MP_PUBLIC_KEY = clip(mp.publicKey, 160);
          envUpdated = true;
        }
        if (typeof mp.accessToken === 'string' && mp.accessToken.trim()) {
          ENV.MP_ACCESS_TOKEN = clip(mp.accessToken, 200);
          envUpdated = true;
        }
        if (typeof np.apiKey === 'string' && np.apiKey.trim()) {
          ENV.NOWPAYMENTS_API_KEY = clip(np.apiKey, 200);
          envUpdated = true;
        }
        if (typeof np.ipnSecret === 'string' && np.ipnSecret.trim()) {
          ENV.NOWPAYMENTS_IPN_SECRET = clip(np.ipnSecret, 200);
          envUpdated = true;
        }
        if (envUpdated && !process.env.VERCEL) {
          try {
            const envPath = path.join(__dirname, '.env');
            let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
            const upsert = (key, val) => {
              const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
              if (idx >= 0) lines[idx] = `${key}=${val}`;
              else lines.push(`${key}=${val}`);
            };
            if (ENV.MP_PUBLIC_KEY) upsert('MP_PUBLIC_KEY', ENV.MP_PUBLIC_KEY);
            if (ENV.MP_ACCESS_TOKEN) upsert('MP_ACCESS_TOKEN', ENV.MP_ACCESS_TOKEN);
            if (ENV.NOWPAYMENTS_API_KEY) upsert('NOWPAYMENTS_API_KEY', ENV.NOWPAYMENTS_API_KEY);
            if (ENV.NOWPAYMENTS_IPN_SECRET) upsert('NOWPAYMENTS_IPN_SECRET', ENV.NOWPAYMENTS_IPN_SECRET);
            fs.writeFileSync(envPath, lines.filter(Boolean).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
          } catch {}
        }

        const prices = body.prices || {};
        for (const id of Object.keys(packagesConfig.packages)) {
          const v = Number(prices[id]);
          if (Number.isFinite(v) && v > 0 && v < 10000) packagesConfig.packages[id].priceBRL = Math.round(v * 100) / 100;
        }
        const bump = Number(prices.bumpPriceBRL);
        if (Number.isFinite(bump) && bump >= 0 && bump < 10000) packagesConfig.bumpPriceBRL = Math.round(bump * 100) / 100;

        if (!ps5Config.emergencyOffline) {
          if (ps5Config.consoleStatus === 'online' && ps5Config.activePlayer) ps5Config.consoleStatus = 'busy';
          if (ps5Config.consoleStatus === 'busy' && !ps5Config.activePlayer) ps5Config.consoleStatus = 'online';
          advanceQueue();
        }
        await persistStateToKv();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/admin/action') {
        await syncStateFromKv(true);
        const body = await readJson(req);
        const o = body.orderId ? orders.get(String(body.orderId)) : null;
        switch (body.action) {
          case 'confirm_order':
            if (!o) return sendJson(res, 404, { error: 'Pedido não encontrado.' });
            enqueueOrActivate(o);
            break;
          case 'cancel_order':
            if (!o) return sendJson(res, 404, { error: 'Pedido não encontrado.' });
            if (o.status === 'active') finishActive();
            ps5Config.queue = ps5Config.queue.filter((q) => q.orderId !== o.orderId);
            o.status = 'cancelled';
            break;
          case 'kick_player':
            finishActive();
            break;
          case 'add_15m':
            if (ps5Config.activePlayer) ps5Config.activePlayer.remainingSeconds += 15 * 60;
            break;
          case 'clear_queue':
            ps5Config.queue.forEach((q) => {
              const qo = orders.get(q.orderId);
              if (qo) qo.status = 'cancelled';
            });
            ps5Config.queue = [];
            break;
          case 'emergency_shutdown':
            ps5Config.emergencyOffline = true;
            ps5Config.consoleStatus = 'maintenance';
            if (ps5Config.activePlayer) {
              const ao = orders.get(ps5Config.activePlayer.orderId);
              if (ao) ao.status = 'cancelled';
              ps5Config.activePlayer = null;
            }
            ps5Config.queue.forEach((q) => {
              const qo = orders.get(q.orderId);
              if (qo) qo.status = 'cancelled';
            });
            ps5Config.queue = [];
            if (body.stopProcess === true && !process.env.VERCEL) {
              sendJson(res, 200, { ok: true, stoppingProcess: true });
              setTimeout(() => {
                console.warn('[playgta6] Desligamento de emergência acionado pelo /admin.');
                process.exit(0);
              }, 350);
              return;
            }
            break;
          case 'emergency_restore':
            ps5Config.emergencyOffline = false;
            ps5Config.consoleStatus = 'online';
            break;
          default:
            return sendJson(res, 400, { error: 'Ação inválida.' });
        }
        await persistStateToKv();
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'Rota não encontrada.' });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p, user);
    return sendJson(res, 405, { error: 'Método não permitido.' });
  } catch (err) {
    console.error('[playgta6] Erro:', err.message);
    const safeErrors = [
      'Payload muito grande',
      'JSON inválido',
      'Selecione um pacote válido.',
      'Erro ao gerar PIX no Mercado Pago. Verifique seu Access Token.',
      'Mercado Pago não retornou o código PIX. Verifique se sua conta tem chave PIX ativa.',
      'Erro ao gerar pagamento Crypto na NOWPayments.'
    ];
    const msg = err.isSafeUserError || safeErrors.includes(err.message) ? err.message : 'Erro ao processar requisição.';
    return sendJson(res, 400, { error: msg });
  }
}

if (require.main === module) {
  const server = http.createServer(handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.listen(ENV.PORT, () => {
    console.log(`[playgta6] Rodando em http://localhost:${ENV.PORT}`);
    console.log(`  Discord login: ${providerEnabled('discord') ? 'ativo' : 'não configurado'}`);
    console.log(`  Google login:  ${providerEnabled('google') ? 'ativo' : 'não configurado'}`);
    console.log(`  Mercado Pago:  ${mpEnabled() ? 'ativo (PIX automático)' : 'não configurado'}`);
    console.log(`  MP Webhook:    ${ENV.MP_WEBHOOK_SECRET ? 'assinatura verificada' : 'sem segredo (configure MP_WEBHOOK_SECRET)'}`);
    console.log(`  Estado KV:     ${kvEnabled() ? 'Redis/KV compartilhado ativo' : 'memória local (configure KV_REST_API_URL para Vercel)'}`);
    console.log(`  NOWPayments:   ${npEnabled() ? 'ativo (Crypto automático)' : 'não configurado'}`);
    console.log(`  Modo de teste: ${isDemoMode() ? 'ligado (botão "simular pagamento")' : 'desligado'}`);
  });
}

module.exports = handler;
