'use strict';
/**
 * viceplay.cloud — Lan House Digital PS5 (GTA VI)
 * - Login real via OAuth2 (Discord e Google), sessão em cookie HttpOnly assinado (HMAC-SHA256)
 * - Fila FIFO em tempo real, preços validados 100% no servidor
 * - PIX "copia e cola" válido (padrão EMV/BR Code com CRC16)
 * - Painel /admin com proteção contra força bruta
 * Sem dependências externas (Node 18+).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const ENV = {
  PORT: Number(process.env.PORT) || 3000,
  BASE_URL: (process.env.BASE_URL || '').replace(/\/+$/, ''),
  ADMIN_USER: process.env.ADMIN_USER || '5288',
  ADMIN_PASS: process.env.ADMIN_PASS || '5288',
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || '',
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN || '',
  MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY || '',
  DEMO_MODE: process.env.DEMO_MODE !== 'false',
  TRUST_PROXY: process.env.TRUST_PROXY === 'true' || !!process.env.VERCEL || !!process.env.RENDER
};

const mpEnabled = () => !!ENV.MP_ACCESS_TOKEN;

let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[viceplay] SESSION_SECRET não definido: usando segredo temporário (logins caem ao reiniciar).');
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
  parsecInviteUrl: 'https://parsec.gg/g/viceplay-cloud-ps5',
  streamMode: 'youtube',
  streamSourceUrl: 'https://www.youtube.com/embed/QdBZY2fkU-0?autoplay=1&mute=1&loop=1&playlist=QdBZY2fkU-0&controls=1&rel=0',
  streamTitle: 'Sessão GTA VI • PS5 #01',
  activePlayer: null, // { orderId, uid, name, totalMinutes, remainingSeconds, startedAt }
  queue: [], // [{ orderId, uid, name, totalMinutes, joinedAt }]
  pixKey: 'pix@viceplay.cloud',
  pixName: 'VICEPLAY CLOUD',
  pixCity: 'SAO PAULO',
  walletUsdt: '0x71C89A4B29F10cE9824F1B3bA91820E77c9f2A1',
  walletBtc: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  walletSol: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
};

const packagesConfig = {
  bumpPriceBRL: 9.9,
  bumpMinutes: 30,
  cryptoDiscountRate: 0.15,
  usdtRateBRL: 5.0,
  packages: {
    trial_10m: { id: 'trial_10m', name: 'Teste Rápido (10 min)', minutes: 10, bonusMinutes: 0, priceBRL: 3.8 },
    hour_1h: { id: 'hour_1h', name: 'Sessão 1 Hora', minutes: 60, bonusMinutes: 0, priceBRL: 22.75 },
    combo_2h: { id: 'combo_2h', name: 'Combo Heist Leonida (2h10)', minutes: 120, bonusMinutes: 10, priceBRL: 44.9 },
    pass_4h: { id: 'pass_4h', name: 'Passaporte Madrugada (4h25)', minutes: 240, bonusMinutes: 25, priceBRL: 86.9 }
  }
};

const orders = new Map(); // orderId -> order
const viewers = new Map(); // clientId -> lastSeen

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
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function getBaseUrl(req) {
  if (ENV.BASE_URL) return ENV.BASE_URL;
  const fwd = ENV.TRUST_PROXY && req.headers['x-forwarded-proto'];
  const proto = fwd ? String(fwd).split(',')[0].trim() : 'http';
  return `${proto}://${req.headers.host || `localhost:${ENV.PORT}`}`;
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
  if (ENV.TRUST_PROXY && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
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
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32 * 1024) {
        reject(new Error('Payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
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
const adminLoginLimiter = makeLimiter(15 * 60_000, 8);
const checkoutLimiter = makeLimiter(60_000, 10);

function getSessionUser(req) {
  const data = unsign(parseCookies(req).vp_session, 'sess');
  return data ? data.u : null;
}

function issueCsrf() {
  return sign({ t: 'csrf', n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 2 * 60 * 60 * 1000 });
}

function isAdmin(req) {
  return !!unsign(req.headers['x-admin-token'], 'admin');
}

// ---------------------------------------------------------------------------
// PIX copia e cola (BR Code / EMV) com CRC16-CCITT válido
// ---------------------------------------------------------------------------
function emv(id, value) {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

function crc16(payload) {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function asciiUpper(str, max) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .toUpperCase()
    .trim()
    .slice(0, max);
}

function buildPixPayload(amount, txid) {
  const merchant = emv('00', 'br.gov.bcb.pix') + emv('01', ps5Config.pixKey.slice(0, 77));
  const base =
    emv('00', '01') +
    emv('26', merchant) +
    emv('52', '0000') +
    emv('53', '986') +
    emv('54', amount.toFixed(2)) +
    emv('58', 'BR') +
    emv('59', asciiUpper(ps5Config.pixName, 25) || 'VICEPLAY') +
    emv('60', asciiUpper(ps5Config.pixCity, 15) || 'SAO PAULO') +
    emv('62', emv('05', txid.replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***')) +
    '6304';
  return base + crc16(base);
}

// ---------------------------------------------------------------------------
// Mercado Pago API v1 (PIX Automático + QR Code + Webhook / Verificação)
// ---------------------------------------------------------------------------
async function createMercadoPagoPix(req, order, user) {
  const payerEmail =
    user.handle && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.handle)
      ? user.handle
      : `player.${order.orderId.toLowerCase()}@viceplay.cloud`;

  const expires = new Date(Date.now() + 30 * 60_000).toISOString();
  const baseUrl = getBaseUrl(req);
  const body = {
    transaction_amount: Number(order.finalPriceBRL.toFixed(2)),
    description: `viceplay.cloud - ${order.packageName}`,
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
    console.error('[viceplay] Mercado Pago erro:', r.status, JSON.stringify(data));
    throw new Error(data.message || 'Erro ao gerar PIX no Mercado Pago.');
  }

  const tx = data.point_of_interaction?.transaction_data || {};
  return {
    mpPaymentId: String(data.id),
    pixPayload: tx.qr_code || buildPixPayload(order.finalPriceBRL, order.orderId),
    pixQrBase64: tx.qr_code_base64 || null
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
    if (data.status === 'approved') {
      enqueueOrActivate(order);
    } else if (data.status === 'cancelled' || data.status === 'rejected') {
      order.status = 'cancelled';
    }
  } catch (err) {
    console.error('[viceplay] Falha ao consultar Mercado Pago:', err.message);
  }
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
  if (ps5Config.activePlayer || ps5Config.consoleStatus === 'maintenance') return;
  const next = ps5Config.queue.shift();
  const order = next && orders.get(next.orderId);
  if (order) startSession(order);
  else if (ps5Config.consoleStatus === 'busy') ps5Config.consoleStatus = 'online';
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
  const bumpPrice = includeBump ? packagesConfig.bumpPriceBRL : 0;
  const bumpMinutes = includeBump ? packagesConfig.bumpMinutes : 0;
  const subtotal = Math.round((pkg.priceBRL + bumpPrice) * 100) / 100;
  const isCrypto = ['usdt', 'btc', 'sol'].includes(paymentMethod);
  const discount = isCrypto ? Math.round(subtotal * packagesConfig.cryptoDiscountRate * 100) / 100 : 0;
  const finalPriceBRL = Math.round((subtotal - discount) * 100) / 100;
  return {
    packageId: pkg.id,
    packageName: pkg.name,
    baseMinutes: pkg.minutes,
    bonusMinutes: pkg.bonusMinutes,
    bumpMinutes,
    totalMinutes: pkg.minutes + pkg.bonusMinutes + bumpMinutes,
    subtotalBRL: subtotal,
    discountBRL: discount,
    finalPriceBRL,
    finalUSDT: (finalPriceBRL / packagesConfig.usdtRateBRL).toFixed(2),
    paymentMethod: isCrypto ? paymentMethod : 'pix',
    isCrypto
  };
}

function publicOrder(o) {
  const queueIdx = ps5Config.queue.findIndex((q) => q.orderId === o.orderId);
  const summary = queueSummary(true);
  const isActive = o.status === 'active' && ps5Config.activePlayer?.orderId === o.orderId;
  return {
    orderId: o.orderId,
    status: o.status,
    packageName: o.packageName,
    totalMinutes: o.totalMinutes,
    finalPriceBRL: o.finalPriceBRL,
    finalUSDT: o.finalUSDT,
    paymentMethod: o.paymentMethod,
    isCrypto: o.isCrypto,
    paymentCode: o.isCrypto ? o.cryptoWallet : o.pixPayload,
    pixQrBase64: o.isCrypto ? null : o.pixQrBase64 || null,
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

function oauthStart(req, res, provider) {
  if (!providerEnabled(provider)) return redirect(res, `/?auth_error=${provider}_not_configured`);
  const cfg = OAUTH[provider];
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(req, res, 'vp_oauth', sign({ t: 'oauth', s: state, p: provider, exp: Date.now() + 10 * 60_000 }), 600);
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
  const saved = unsign(parseCookies(req).vp_oauth, 'oauth');
  setCookie(req, res, 'vp_oauth', '', 0);

  if (query.get('error')) return redirect(res, '/?auth_error=cancelled');
  if (!providerEnabled(provider)) return redirect(res, `/?auth_error=${provider}_not_configured`);
  if (!saved || saved.p !== provider || !query.get('state') || !safeEqual(query.get('state'), saved.s)) {
    return redirect(res, '/?auth_error=state');
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
    setCookie(req, res, 'vp_session', sign({ t: 'sess', u: user, exp: Date.now() + SESSION_TTL_MS }), SESSION_TTL_MS / 1000);
    redirect(res, '/?login=ok');
  } catch (err) {
    console.error('[viceplay] Falha no OAuth:', err.message);
    redirect(res, '/?auth_error=failed');
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
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

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const abs = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(abs, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 - Página não encontrada');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
}

async function handler(req, res) {
  securityHeaders(req, res);
  const ip = getIp(req);
  if (!globalLimiter(ip)) return sendJson(res, 429, { error: 'Muitas requisições. Aguarde 1 minuto.' });

  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const user = getSessionUser(req);

  try {
    // ---------------- Auth ----------------
    const authMatch = p.match(/^\/auth\/(discord|google)(\/callback)?$/);
    if (req.method === 'GET' && authMatch) {
      return authMatch[2] ? oauthCallback(req, res, authMatch[1], url.searchParams) : oauthStart(req, res, authMatch[1]);
    }

    if (req.method === 'POST' && p === '/auth/logout') {
      setCookie(req, res, 'vp_session', '', 0);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/me') {
      return sendJson(res, 200, {
        user: user ? { name: user.name, handle: user.handle, avatar: user.avatar, provider: user.provider } : null,
        providers: { discord: providerEnabled('discord'), google: providerEnabled('google') },
        demoMode: ENV.DEMO_MODE
      });
    }

    // ---------------- Público ----------------
    if (req.method === 'GET' && p === '/api/config') {
      const cid = url.searchParams.get('cid');
      if (cid && /^[a-z0-9]{8,32}$/.test(cid)) viewers.set(cid, Date.now());
      const ap = ps5Config.activePlayer;
      return sendJson(res, 200, {
        csrfToken: issueCsrf(),
        packages: packagesConfig.packages,
        bumpPriceBRL: packagesConfig.bumpPriceBRL,
        cryptoDiscountRate: packagesConfig.cryptoDiscountRate,
        usdtRateBRL: packagesConfig.usdtRateBRL,
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
      if (ps5Config.emergencyOffline) return sendJson(res, 503, { error: 'Sistema desligado em modo de emergência. Tente mais tarde.' });
      if (!unsign(req.headers['x-csrf-token'], 'csrf')) return sendJson(res, 403, { error: 'csrf', message: 'Sessão expirada. Tente novamente.' });
      if (!user) return sendJson(res, 401, { error: 'login', message: 'Entre com Discord ou Google para continuar.' });
      if (!checkoutLimiter(user.uid)) return sendJson(res, 429, { error: 'Muitos pedidos seguidos. Aguarde um pouco.' });

      const pendingCount = [...orders.values()].filter((o) => o.uid === user.uid && o.status === 'pending').length;
      if (pendingCount >= 3) return sendJson(res, 429, { error: 'Você já tem pedidos aguardando pagamento.' });

      const body = await readJson(req);
      const calc = calculateOrder(String(body.packageId || ''), body.includeBump === true, String(body.paymentMethod || 'pix'));
      const orderId = `VP${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
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
        pixPayload: '',
        pixQrBase64: null,
        cryptoWallet: calc.paymentMethod === 'btc' ? ps5Config.walletBtc : calc.paymentMethod === 'sol' ? ps5Config.walletSol : ps5Config.walletUsdt
      };

      if (!order.isCrypto) {
        if (mpEnabled()) {
          const mp = await createMercadoPagoPix(req, order, user);
          order.mpPaymentId = mp.mpPaymentId;
          order.pixPayload = mp.pixPayload;
          order.pixQrBase64 = mp.pixQrBase64;
        } else {
          order.pixPayload = buildPixPayload(calc.finalPriceBRL, orderId);
        }
      }

      orders.set(orderId, order);
      return sendJson(res, 200, { ok: true, order: publicOrder(order) });
    }

    if (req.method === 'GET' && p === '/api/order') {
      if (!user) return sendJson(res, 401, { error: 'login' });
      const o = orders.get(String(url.searchParams.get('id') || ''));
      if (!o || o.uid !== user.uid) return sendJson(res, 404, { error: 'Pedido não encontrado.' });
      await syncMercadoPagoPayment(o);
      return sendJson(res, 200, { ok: true, order: publicOrder(o) });
    }

    // Webhook oficial do Mercado Pago (confirma pagamento instantaneamente)
    if (req.method === 'POST' && p === '/api/webhooks/mercadopago') {
      if (!mpEnabled()) return sendJson(res, 200, { ok: true });
      const body = await readJson(req).catch(() => ({}));
      const mpId = String(body?.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id') || '');
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
              if (target) {
                target.mpPaymentId = mpId;
                if (mpData.status === 'approved') enqueueOrActivate(target);
                else if (mpData.status === 'cancelled' || mpData.status === 'rejected') target.status = 'cancelled';
              }
            }
          } catch (err) {
            console.error('[viceplay] Webhook MP erro:', err.message);
          }
        } else {
          target.lastMpCheck = 0;
          await syncMercadoPagoPayment(target);
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    // Simulação de pagamento: só em modo de teste e só para o dono do pedido
    if (req.method === 'POST' && p === '/api/demo/confirm') {
      if (!ENV.DEMO_MODE) return sendJson(res, 403, { error: 'Modo de teste desativado.' });
      if (!unsign(req.headers['x-csrf-token'], 'csrf')) return sendJson(res, 403, { error: 'csrf' });
      if (!user) return sendJson(res, 401, { error: 'login' });
      const body = await readJson(req);
      const o = orders.get(String(body.orderId || ''));
      if (!o || o.uid !== user.uid) return sendJson(res, 404, { error: 'Pedido não encontrado.' });
      enqueueOrActivate(o);
      return sendJson(res, 200, { ok: true, order: publicOrder(o) });
    }

    // ---------------- Admin ----------------
    if (req.method === 'POST' && p === '/api/admin/login') {
      if (!adminLoginLimiter(ip)) return sendJson(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
      const body = await readJson(req);
      const okUser = safeEqual(String(body.username || ''), ENV.ADMIN_USER);
      const okPass = safeEqual(String(body.password || ''), ENV.ADMIN_PASS);
      if (!okUser || !okPass) return sendJson(res, 401, { error: 'Usuário ou senha incorretos.' });
      return sendJson(res, 200, { ok: true, adminToken: sign({ t: 'admin', exp: Date.now() + 12 * 60 * 60 * 1000 }) });
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'Não autorizado.' });

      if (req.method === 'GET' && p === '/api/admin/state') {
        return sendJson(res, 200, {
          ok: true,
          ps5Config,
          packagesConfig,
          queueSummary: queueSummary(false),
          orders: [...orders.values()].reverse().slice(0, 60),
          providers: { discord: providerEnabled('discord'), google: providerEnabled('google') },
          mercadoPago: mpEnabled(),
          mpPublicKey: ENV.MP_PUBLIC_KEY,
          demoMode: ENV.DEMO_MODE
        });
      }

      if (req.method === 'POST' && p === '/api/admin/save') {
        const body = await readJson(req);
        const c = body.ps5Config || {};
        const str = (k, max) => {
          if (typeof c[k] === 'string' && c[k].trim()) ps5Config[k] = clip(c[k], max);
        };
        if (['online', 'busy', 'maintenance'].includes(c.consoleStatus)) ps5Config.consoleStatus = c.consoleStatus;
        if (['youtube', 'twitch', 'hls_webrtc'].includes(c.streamMode)) ps5Config.streamMode = c.streamMode;
        if (typeof c.streamSourceUrl === 'string' && /^https:\/\//.test(c.streamSourceUrl.trim())) {
          ps5Config.streamSourceUrl = clip(c.streamSourceUrl, 400);
        }
        str('streamTitle', 100);
        str('ps5LocalIp', 45);
        str('remotePlayPin', 20);
        str('connectionMode', 30);
        if (typeof c.parsecInviteUrl === 'string' && /^https:\/\//.test(c.parsecInviteUrl.trim())) {
          ps5Config.parsecInviteUrl = clip(c.parsecInviteUrl, 300);
        }
        str('pixKey', 77);
        str('pixName', 25);
        str('pixCity', 15);
        str('walletUsdt', 120);
        str('walletBtc', 120);
        str('walletSol', 120);

        // Mercado Pago (salvo em memória e persistido no .env local quando possível)
        const mp = body.mercadoPago || {};
        let envUpdated = false;
        if (typeof mp.publicKey === 'string' && mp.publicKey.trim()) {
          ENV.MP_PUBLIC_KEY = clip(mp.publicKey, 160);
          envUpdated = true;
        }
        if (typeof mp.accessToken === 'string' && mp.accessToken.trim()) {
          ENV.MP_ACCESS_TOKEN = clip(mp.accessToken, 200);
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
            fs.writeFileSync(envPath, lines.filter(Boolean).join('\n') + '\n', 'utf8');
          } catch {}
        }

        const prices = body.prices || {};
        for (const id of Object.keys(packagesConfig.packages)) {
          const v = Number(prices[id]);
          if (Number.isFinite(v) && v > 0 && v < 10000) packagesConfig.packages[id].priceBRL = Math.round(v * 100) / 100;
        }
        const bump = Number(prices.bumpPriceBRL);
        if (Number.isFinite(bump) && bump >= 0 && bump < 10000) packagesConfig.bumpPriceBRL = Math.round(bump * 100) / 100;

        if (ps5Config.consoleStatus === 'online' && ps5Config.activePlayer) ps5Config.consoleStatus = 'busy';
        if (ps5Config.consoleStatus === 'busy' && !ps5Config.activePlayer) ps5Config.consoleStatus = 'online';
        advanceQueue();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/admin/action') {
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
                console.warn('[viceplay] Desligamento de emergência acionado pelo /admin.');
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
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'Rota não encontrada.' });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, p);
    return sendJson(res, 405, { error: 'Método não permitido.' });
  } catch (err) {
    console.error('[viceplay] Erro:', err.message);
    return sendJson(res, 400, { error: err.message || 'Erro inesperado.' });
  }
}

if (require.main === module) {
  http.createServer(handler).listen(ENV.PORT, () => {
    console.log(`[viceplay.cloud] Rodando em http://localhost:${ENV.PORT}`);
    console.log(`  Discord login: ${providerEnabled('discord') ? 'ativo' : 'não configurado'}`);
    console.log(`  Google login:  ${providerEnabled('google') ? 'ativo' : 'não configurado'}`);
    console.log(`  Mercado Pago:  ${mpEnabled() ? 'ativo (PIX automático)' : 'não configurado (BR Code manual)'}`);
    console.log(`  Modo de teste: ${ENV.DEMO_MODE ? 'ligado (botão "simular pagamento")' : 'desligado'}`);
  });
}

module.exports = handler;
