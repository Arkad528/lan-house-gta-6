/**
 * viceplay.cloud - Lan House Digital GTA VI (PS5)
 * Servidor Backend + Painel Admin (/admin) + Live Stream PS5
 * Credenciais Admin: Usuário 5288 | Senha 5288
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CSRF_SECRET = process.env.CSRF_SECRET || 'viceplay-cloud-ps5-hmac-secret-2026-gta6';
const ADMIN_USER = '5288';
const ADMIN_PASS = '5288';

// Estado Dinâmico do PS5 e Configurações Editáveis no /admin
const ps5Config = {
  consoleName: 'viceplay.cloud • PS5 Pro #01 (4K 60fps)',
  consoleStatus: 'online', // 'online' | 'busy' | 'maintenance'
  ps5LocalIp: '192.168.1.150',
  remotePlayPin: '48291033',
  connectionMode: 'parsec_chiaki', // 'parsec_chiaki' | 'webrtc_capture' | 'ps_remote_direct'
  parsecInviteUrl: 'https://parsec.gg/g/viceplay-cloud-ps5',
  streamMode: 'youtube', // 'youtube' | 'twitch' | 'hls_webrtc'
  streamSourceUrl: 'https://www.youtube.com/embed/QdBZY2fkU-0?autoplay=1&mute=1&loop=1&playlist=QdBZY2fkU-0&controls=1&rel=0',
  streamTitle: 'AO VIVO em viceplay.cloud • Sessão GTA VI PS5 #01',
  viewersCount: 18,
  activePlayer: null, // { userHandle, provider, remainingSeconds, orderId, startedAt }
  pixKey: 'pix@viceplay.cloud',
  walletUsdt: '0x71C89A4B29F10cE9824F1B3bA91820E77c9f2A1',
  walletBtc: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  walletSol: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
};

// Tabela de Preços Editável pelo /admin (Inicia com Base R$ 1,95 / 10 min)
const packagesConfig = {
  baseRate10m: 1.95,
  bumpPriceBRL: 3.50,
  cryptoDiscountRate: 0.15,
  packages: {
    trial_10m: { id: 'trial_10m', name: 'Teste Rápido (10 Min)', minutes: 10, priceBRL: 1.95, originalPriceBRL: 1.95, bonusMinutes: 0 },
    hour_1h: { id: 'hour_1h', name: 'Sessão 1 Hora', minutes: 60, priceBRL: 11.70, originalPriceBRL: 11.70, bonusMinutes: 0 },
    decoy_2h: { id: 'decoy_2h', name: 'Sessão 2 Horas', minutes: 120, priceBRL: 22.50, originalPriceBRL: 23.40, bonusMinutes: 0 },
    combo_3h: { id: 'combo_3h', name: 'Combo 3 Horas (+15m Grátis)', minutes: 180, priceBRL: 24.90, originalPriceBRL: 35.10, bonusMinutes: 15 },
    pass_6h: { id: 'pass_6h', name: 'Maratona 6 Horas (+30m Grátis)', minutes: 360, priceBRL: 38.90, originalPriceBRL: 70.20, bonusMinutes: 30 }
  }
};

const ordersList = [];
const rateLimitMap = new Map();

// Cronômetro em tempo real da sessão ativa do PS5
setInterval(() => {
  if (ps5Config.activePlayer && ps5Config.activePlayer.remainingSeconds > 0) {
    ps5Config.activePlayer.remainingSeconds -= 1;
    if (ps5Config.activePlayer.remainingSeconds <= 0) {
      ps5Config.activePlayer = null;
      ps5Config.consoleStatus = 'online';
    }
  }
}, 1000);

function generateSignedToken(prefix = 'csrf') {
  const ts = Date.now().toString(36);
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = `${prefix}.${ts}.${nonce}`;
  const sig = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${sig}`;
}

function verifySignedToken(token, expectedPrefix = 'csrf') {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 4) return false;
  const [prefix, ts, nonce, sig] = parts;
  if (prefix !== expectedPrefix) return false;
  const payload = `${prefix}.${ts}.${nonce}`;
  const expected = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex').slice(0, 32);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; script-src 'self'; connect-src 'self'; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://*;"
  );
}

function checkRateLimit(ip, maxRequests = 90) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - record.windowStart > 60_000) {
    record.count = 1;
    record.windowStart = now;
  } else {
    record.count += 1;
  }
  rateLimitMap.set(ip, record);
  return record.count <= maxRequests;
}

function sanitizeString(str, maxLen = 250) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'`]/g, '').trim().slice(0, maxLen);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 32 * 1024) {
        reject(new Error('Payload Too Large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('JSON inválido'));
      }
    });
  });
}

function calculateServerSideOrder({ packageId, customMinutes, includeBump, paymentMethod }) {
  const pkgs = packagesConfig.packages;
  let baseMinutes = 0;
  let basePriceBRL = 0;
  let bonusMinutes = 0;
  let packageName = '';

  if (packageId && pkgs[packageId]) {
    const pkg = pkgs[packageId];
    baseMinutes = pkg.minutes;
    basePriceBRL = pkg.priceBRL;
    bonusMinutes = pkg.bonusMinutes;
    packageName = pkg.name;
  } else if (typeof customMinutes === 'number' && Number.isInteger(customMinutes)) {
    const m = Math.max(10, Math.min(360, Math.round(customMinutes / 10) * 10));
    baseMinutes = m;
    const p10 = pkgs.trial_10m.priceBRL;
    const p60 = pkgs.hour_1h.priceBRL;
    const p120 = pkgs.decoy_2h.priceBRL;
    const p180 = pkgs.combo_3h.priceBRL;
    const p360 = pkgs.pass_6h.priceBRL;

    if (m <= 60) {
      basePriceBRL = (m / 10) * p10;
      bonusMinutes = 0;
    } else if (m <= 120) {
      basePriceBRL = p60 + ((m - 60) / 60) * (p120 - p60);
      bonusMinutes = 0;
    } else if (m < 180) {
      basePriceBRL = p120 + ((m - 120) / 60) * (p180 - p120);
      bonusMinutes = 0;
    } else if (m === 180) {
      basePriceBRL = p180;
      bonusMinutes = 15;
    } else if (m < 360) {
      basePriceBRL = p180 + ((m - 180) / 180) * (p360 - p180);
      bonusMinutes = 15;
    } else {
      basePriceBRL = p360;
      bonusMinutes = 30;
    }

    basePriceBRL = Math.round(basePriceBRL * 100) / 100;
    packageName = `Sessão Personalizada (${m} min)`;
  } else {
    throw new Error('Selecione um pacote válido.');
  }

  const bumpPrice = includeBump ? packagesConfig.bumpPriceBRL : 0;
  const bumpMinutes = includeBump ? 30 : 0;
  const subtotalBRL = Math.round((basePriceBRL + bumpPrice) * 100) / 100;
  const isCrypto = ['usdt', 'btc', 'sol'].includes(paymentMethod);
  const discountBRL = isCrypto ? Math.round(subtotalBRL * packagesConfig.cryptoDiscountRate * 100) / 100 : 0;
  const finalPriceBRL = Math.round((subtotalBRL - discountBRL) * 100) / 100;
  const totalMinutes = baseMinutes + bonusMinutes + bumpMinutes;
  const finalUSDT = (finalPriceBRL / 5.0).toFixed(2);

  return {
    packageName,
    baseMinutes,
    bonusMinutes,
    bumpMinutes,
    totalMinutes,
    subtotalBRL,
    discountBRL,
    finalPriceBRL,
    finalUSDT,
    paymentMethod: isCrypto ? paymentMethod : 'pix',
    isCrypto
  };
}

async function requestHandler(req, res) {
  applySecurityHeaders(res);
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  if (!checkRateLimit(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'Muitas requisições. Aguarde 1 minuto.' }));
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 1. Configuração Pública + Estado da Live Screen do PS5
  if (req.method === 'GET' && parsedUrl.pathname === '/api/config') {
    const token = generateSignedToken('csrf');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(
      JSON.stringify({
        csrfToken: token,
        packages: packagesConfig.packages,
        bumpPriceBRL: packagesConfig.bumpPriceBRL,
        cryptoDiscountRate: packagesConfig.cryptoDiscountRate,
        ps5Public: {
          consoleName: ps5Config.consoleName,
          consoleStatus: ps5Config.consoleStatus,
          streamMode: ps5Config.streamMode,
          streamSourceUrl: ps5Config.streamSourceUrl,
          streamTitle: ps5Config.streamTitle,
          viewersCount: ps5Config.viewersCount,
          activePlayer: ps5Config.activePlayer
        }
      })
    );
  }

  // 2. Criar Pedido no Checkout
  if (req.method === 'POST' && parsedUrl.pathname === '/api/checkout') {
    try {
      const csrfHeader = req.headers['x-csrf-token'];
      if (!verifySignedToken(csrfHeader, 'csrf')) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'Sessão atualizada. Recarregue a página.' }));
      }

      const body = await parseJsonBody(req);
      const userProvider = sanitizeString(body.provider || '', 20);
      const userHandle = sanitizeString(body.userHandle || '', 60);

      if (!userProvider || !userHandle) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'Conecte seu Discord ou Google para continuar.' }));
      }

      const calc = calculateServerSideOrder({
        packageId: sanitizeString(body.packageId || '', 30),
        customMinutes: typeof body.customMinutes === 'number' ? body.customMinutes : null,
        includeBump: Boolean(body.includeBump),
        paymentMethod: sanitizeString(body.paymentMethod || 'pix', 15)
      });

      const orderId = 'VP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const accessPin = ps5Config.remotePlayPin || crypto.randomInt(100000, 999999).toString();
      const pixPayload = `00020126580014BR.GOV.BCB.PIX0136${ps5Config.pixKey}520400005303986540${calc.finalPriceBRL.toFixed(2)}5802BR5914VICEPLAY.CLOUD6009SAO PAULO62070503***6304ABCD`;
      const cryptoWallet =
        calc.paymentMethod === 'btc'
          ? ps5Config.walletBtc
          : calc.paymentMethod === 'sol'
          ? ps5Config.walletSol
          : ps5Config.walletUsdt;

      const orderRecord = {
        orderId,
        createdAt: new Date().toISOString(),
        userProvider,
        userHandle,
        status: 'pending',
        ...calc,
        pixPayload,
        cryptoWallet,
        accessPin,
        parsecInviteUrl: ps5Config.parsecInviteUrl
      };

      ordersList.unshift(orderRecord);
      if (ordersList.length > 50) ordersList.pop();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, order: orderRecord }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: err.message || 'Erro no checkout.' }));
    }
  }

  // 3. Confirmar Pagamento / Iniciar Sessão no PS5
  if (req.method === 'POST' && parsedUrl.pathname === '/api/activate-session') {
    try {
      const body = await parseJsonBody(req);
      const orderId = sanitizeString(body.orderId || '', 20);
      const order = ordersList.find((o) => o.orderId === orderId);
      if (order) {
        order.status = 'active';
        ps5Config.activePlayer = {
          orderId: order.orderId,
          userHandle: order.userHandle,
          provider: order.userProvider,
          remainingSeconds: order.totalMinutes * 60,
          startedAt: new Date().toISOString()
        };
        ps5Config.consoleStatus = 'busy';
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, activePlayer: ps5Config.activePlayer }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Falha ao ativar sessão.' }));
    }
  }

  // 4. API de Login do /admin (Usuário: 5288 | Senha: 5288)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/login') {
    try {
      const body = await parseJsonBody(req);
      const user = String(body.username || '').trim();
      const pass = String(body.password || '').trim();

      if (user === ADMIN_USER && pass === ADMIN_PASS) {
        const adminToken = generateSignedToken('admin');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, adminToken }));
      }
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Usuário ou senha incorretos.' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Requisição inválida.' }));
    }
  }

  // 5. API de Leitura do Painel /admin
  if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/state') {
    const authHeader = req.headers['x-admin-token'];
    if (!verifySignedToken(authHeader, 'admin')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Não autorizado.' }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(
      JSON.stringify({
        ok: true,
        ps5Config,
        packagesConfig,
        ordersList
      })
    );
  }

  // 6. API de Salvar Configurações do PS5, Stream, Preços e Carteiras no /admin
  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/save') {
    const authHeader = req.headers['x-admin-token'];
    if (!verifySignedToken(authHeader, 'admin')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Não autorizado.' }));
    }

    try {
      const body = await parseJsonBody(req);

      if (body.ps5Config) {
        const c = body.ps5Config;
        if (c.consoleName) ps5Config.consoleName = sanitizeString(c.consoleName, 80);
        if (['online', 'busy', 'maintenance'].includes(c.consoleStatus)) ps5Config.consoleStatus = c.consoleStatus;
        if (c.ps5LocalIp) ps5Config.ps5LocalIp = sanitizeString(c.ps5LocalIp, 45);
        if (c.remotePlayPin) ps5Config.remotePlayPin = sanitizeString(c.remotePlayPin, 20);
        if (c.connectionMode) ps5Config.connectionMode = sanitizeString(c.connectionMode, 30);
        if (c.parsecInviteUrl) ps5Config.parsecInviteUrl = sanitizeString(c.parsecInviteUrl, 200);
        if (['youtube', 'twitch', 'hls_webrtc'].includes(c.streamMode)) ps5Config.streamMode = c.streamMode;
        if (typeof c.streamSourceUrl === 'string') ps5Config.streamSourceUrl = sanitizeString(c.streamSourceUrl, 300);
        if (c.streamTitle) ps5Config.streamTitle = sanitizeString(c.streamTitle, 100);
        if (c.pixKey) ps5Config.pixKey = sanitizeString(c.pixKey, 120);
        if (c.walletUsdt) ps5Config.walletUsdt = sanitizeString(c.walletUsdt, 120);
        if (c.walletBtc) ps5Config.walletBtc = sanitizeString(c.walletBtc, 120);
        if (c.walletSol) ps5Config.walletSol = sanitizeString(c.walletSol, 120);
      }

      if (body.prices) {
        const p = body.prices;
        if (typeof p.trial_10m === 'number' && p.trial_10m > 0) {
          packagesConfig.packages.trial_10m.priceBRL = p.trial_10m;
          packagesConfig.baseRate10m = p.trial_10m;
          packagesConfig.packages.hour_1h.priceBRL = Math.round(p.trial_10m * 6 * 100) / 100;
        }
        if (typeof p.decoy_2h === 'number' && p.decoy_2h > 0) packagesConfig.packages.decoy_2h.priceBRL = p.decoy_2h;
        if (typeof p.combo_3h === 'number' && p.combo_3h > 0) packagesConfig.packages.combo_3h.priceBRL = p.combo_3h;
        if (typeof p.pass_6h === 'number' && p.pass_6h > 0) packagesConfig.packages.pass_6h.priceBRL = p.pass_6h;
        if (typeof p.bumpPriceBRL === 'number' && p.bumpPriceBRL >= 0) packagesConfig.bumpPriceBRL = p.bumpPriceBRL;
      }

      if (body.action === 'kick_player') {
        ps5Config.activePlayer = null;
        ps5Config.consoleStatus = 'online';
      }

      if (body.action === 'add_15m' && ps5Config.activePlayer) {
        ps5Config.activePlayer.remainingSeconds += 15 * 60;
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, ps5Config, packagesConfig }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Erro ao salvar configurações.' }));
    }
  }

  // Roteamento de páginas estáticas (/ e /admin)
  let filePath = parsedUrl.pathname;
  if (filePath === '/') filePath = '/index.html';
  else if (filePath === '/admin' || filePath === '/admin/') filePath = '/admin.html';

  const safeSuffix = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const absPath = path.join(__dirname, 'public', safeSuffix);

  if (!absPath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(absPath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  };

  fs.readFile(absPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 - Página não encontrada');
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

if (require.main === module) {
  const server = http.createServer(requestHandler);
  server.listen(PORT, () => {
    console.log(`[viceplay.cloud] Servidor rodando em http://localhost:${PORT}`);
  });
}

module.exports = requestHandler;
