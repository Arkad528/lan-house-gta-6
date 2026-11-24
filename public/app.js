(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  const PKG = {
    trial_10m: { name: 'Teste Rápido (10 min)', short: '10 min', minutes: 10, bonus: 0, price: 3.8 },
    hour_1h: { name: 'Sessão 1 Hora', short: '1 hora', minutes: 60, bonus: 0, price: 22.75 },
    combo_2h: { name: 'Combo Heist Leonida (2h15)', short: '2h15', minutes: 120, bonus: 15, price: 44.9 },
    pass_4h: { name: 'Passaporte Madrugada (5h)', short: '5 horas', minutes: 240, bonus: 60, price: 86.9 }
  };

  const BUTTON_LABELS = {
    trial_10m: 'Jogar 10 minutos',
    hour_1h: 'Jogar 1 hora',
    combo_2h: 'Jogar Combo 2h15',
    pass_4h: 'Jogar 5 horas'
  };

  const AUTH_ERRORS = {
    discord_not_configured: 'Login com Discord ainda não foi configurado no servidor.',
    google_not_configured: 'Login com Google ainda não foi configurado no servidor.',
    cancelled: 'Login cancelado.',
    state: 'Sessão de login expirou. Tente novamente.',
    failed: 'Não foi possível concluir o login. Tente novamente.'
  };

  const STORAGE_PENDING = 'pg6_after_login';

  const state = {
    csrf: null,
    user: null,
    isAdmin: false,
    providers: { discord: false, google: false },
    demoMode: false,
    pkg: 'combo_2h',
    bump: false,
    method: 'pix',
    coin: 'usdttrc20',
    cryptoOptions: [
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
      { id: 'btc', label: 'BTC', network: 'Bitcoin', group: 'Populares' },
      { id: 'eth', label: 'ETH', network: 'Ethereum', group: 'Populares' },
      { id: 'ltc', label: 'LTC', network: 'Litecoin', group: 'Populares' },
      { id: 'trx', label: 'TRX', network: 'Tron (TRC20)', group: 'Populares' },
      { id: 'bnbbsc', label: 'BNB', network: 'BSC (BEP20)', group: 'Populares' },
      { id: 'ton', label: 'TON', network: 'TON Network', group: 'Populares' }
    ],
    bumpPrice: 9.9,
    cryptoRate: 0.15,
    mpFeeRate: 0.01,
    npFeeRate: 0.005,
    usdtRate: 5,
    pub: null,
    order: null,
    pollTimer: null,
    countdownTimer: null,
    soundAlertEnabled: false,
    soundPromptDismissed: false,
    audioCtx: null,
    titleAlertTimer: null
  };

  const clientId = (() => {
    let id = sessionStorage.getItem('pg6_cid');
    if (!id || !/^[a-z0-9]{8,32}$/.test(id)) {
      id = (Math.random().toString(36).slice(2, 12) + Date.now().toString(36)).slice(0, 24);
      sessionStorage.setItem('pg6_cid', id);
    }
    return id;
  })();

  // ---------------------------------------------------------------- utils
  const money = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

  function duration(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (!h) return `${m} min`;
    return m ? `${h}h ${String(m).padStart(2, '0')}min` : `${h}h`;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  let toastTimer = null;
  function toast(msg, type) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast ${type || ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
  }

  async function api(url, options) {
    const res = await fetch(url, { credentials: 'same-origin', ...options });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  // ---------------------------------------------------------------- modais
  function openModal(id) {
    $(id).classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closeModal(id) {
    $(id).classList.add('hidden');
    if (!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('modal-open');
    if (id === 'order-modal') {
      stopCountdown();
      // Mantém o polling rodando em segundo plano se o jogador ativou o aviso sonoro na fila!
      if (!(state.order && state.order.status === 'queued' && state.soundAlertEnabled)) {
        stopPolling();
      }
    }
  }

  function stopCountdown() {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }

  function startCountdown(expiresAt) {
    stopCountdown();
    const box = $('o-countdown');
    const timeEl = $('o-countdown-time');
    if (!box || !timeEl) return;
    const deadline = Number(expiresAt) || Date.now() + 30 * 60_000;

    const tick = () => {
      const leftSec = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      const m = Math.floor(leftSec / 60);
      const s = leftSec % 60;
      timeEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      box.classList.toggle('is-warn', leftSec > 60 && leftSec <= 300);
      box.classList.toggle('is-urgent', leftSec <= 60);

      if (leftSec <= 0) {
        stopCountdown();
        if (state.order && state.order.status === 'pending') {
          updateOrderStatus({ status: 'expired' });
        }
      }
    };

    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  // ---------------------------------------------------------------- som de alerta (Web Audio API)
  function unlockAudio() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!state.audioCtx) state.audioCtx = new AudioCtx();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
    return state.audioCtx;
  }

  function playChime(type) {
    const ctx = unlockAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    // 'confirm' = 1 toque suave de teste | 'ready' = 3 notas claras chamando para jogar
    const notes =
      type === 'confirm'
        ? [{ f: 660, t: 0, d: 0.14 }]
        : [
            { f: 523.25, t: 0, d: 0.18 },
            { f: 659.25, t: 0.19, d: 0.18 },
            { f: 783.99, t: 0.38, d: 0.22 },
            { f: 1046.5, t: 0.62, d: 0.42 }
          ];

    notes.forEach((n) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      gain.gain.setValueAtTime(0.001, now + n.t);
      gain.gain.exponentialRampToValueAtTime(type === 'confirm' ? 0.14 : 0.28, now + n.t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.d + 0.03);
    });
  }

  function notifyTurnReady() {
    if (state.soundAlertEnabled) {
      playChime('ready');
      setTimeout(() => playChime('ready'), 1400);
    }
    toast('É a sua vez! O controle do PS5 está liberado!', 'success');
    openModal('order-modal');

    // Pisca o título da aba caso o jogador esteja em outra aba
    const origTitle = 'playgta6 — Jogue GTA VI no PS5 por hora';
    clearInterval(state.titleAlertTimer);
    let toggle = false;
    state.titleAlertTimer = setInterval(() => {
      if (!document.hidden) {
        document.title = origTitle;
        clearInterval(state.titleAlertTimer);
        return;
      }
      toggle = !toggle;
      document.title = toggle ? '🔔 SUA VEZ NO PS5! — playgta6' : origTitle;
    }, 900);

    // Notificação nativa do navegador se o usuário permitiu
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('playgta6 — É a sua vez no PS5!', {
          body: 'O console foi liberado. Volte para a aba para pegar seu PIN e jogar GTA VI.'
        });
      } catch {}
    }
  }

  function renderSoundPrompt(status) {
    const box = $('o-sound-prompt');
    if (status !== 'queued' || state.soundPromptDismissed) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    if (state.soundAlertEnabled) {
      $('o-sound-prompt-text').textContent = 'Aviso sonoro ativado! Pode assistir à live tranquilo — vamos tocar um alerta quando for a sua vez.';
      $('btn-sound-enable').textContent = '🔔 Testar som';
      $('btn-sound-dismiss').textContent = 'Desativar';
    } else {
      $('o-sound-prompt-text').innerHTML = 'Quer receber um <strong>aviso sonoro</strong> assim que o PS5 ficar livre para você?';
      $('btn-sound-enable').textContent = '🔔 Sim, me avise com som';
      $('btn-sound-dismiss').textContent = 'Agora não';
    }
  }

  // ---------------------------------------------------------------- dados
  async function loadMe() {
    const { ok, data } = await api('/api/me');
    if (!ok) return;
    state.user = data.user;
    state.isAdmin = !!data.isAdmin;
    if (data.csrfToken) state.csrf = data.csrfToken;
    state.providers = data.providers || state.providers;
    state.demoMode = !!data.demoMode;
    renderAuth();
  }

  async function loadConfig() {
    const { ok, data } = await api(`/api/config?cid=${clientId}`);
    if (!ok) return;
    state.csrf = data.csrfToken;
    if (data.packages) {
      Object.keys(PKG).forEach((k) => {
        if (data.packages[k]) PKG[k].price = data.packages[k].priceBRL;
      });
    }
    if (typeof data.bumpPriceBRL === 'number') state.bumpPrice = data.bumpPriceBRL;
    if (typeof data.cryptoDiscountRate === 'number') state.cryptoRate = data.cryptoDiscountRate;
    if (typeof data.mpFeeRate === 'number') state.mpFeeRate = data.mpFeeRate;
    if (typeof data.npFeeRate === 'number') state.npFeeRate = data.npFeeRate;
    if (typeof data.usdtRateBRL === 'number') state.usdtRate = data.usdtRateBRL;
    if (Array.isArray(data.cryptoOptions) && data.cryptoOptions.length > 0) {
      state.cryptoOptions = data.cryptoOptions;
      if (!state.cryptoOptions.some((c) => c.id === state.coin)) {
        state.coin = state.cryptoOptions[0].id;
      }
      renderCryptoCoins();
    }
    state.pub = data.ps5Public || null;
    renderStage();
    renderPlans();
    renderCheckout();
  }

  // ---------------------------------------------------------------- render
  function setAvatar(imgId, fallbackId, user) {
    const img = $(imgId);
    const fb = $(fallbackId);
    fb.textContent = (user.name || 'J').trim().charAt(0).toUpperCase();
    if (user.avatar) {
      img.src = user.avatar;
      img.classList.remove('hidden');
      fb.classList.add('hidden');
      img.onerror = () => {
        img.classList.add('hidden');
        fb.classList.remove('hidden');
      };
    } else {
      img.classList.add('hidden');
      fb.classList.remove('hidden');
    }
  }

  function renderAuth() {
    const u = state.user;
    $('btn-open-login').classList.toggle('hidden', !!u);
    $('user-chip').classList.toggle('hidden', !u);
    const existingAdminLink = $('btn-admin-shortcut');
    if (u && state.isAdmin) {
      if (!existingAdminLink) {
        const a = el('a', 'btn-link', 'Admin');
        a.id = 'btn-admin-shortcut';
        a.href = '/admin';
        $('user-chip').insertBefore(a, $('btn-logout'));
      }
    } else if (existingAdminLink) {
      existingAdminLink.remove();
    }
    $('checkout-login').classList.toggle('hidden', !!u);
    $('checkout-user').classList.toggle('hidden', !u);
    if (!u) return;
    const providerLabel = u.provider === 'google' ? 'Google' : 'Discord';
    $('user-name').textContent = u.name;
    $('user-provider').textContent = providerLabel;
    $('checkout-user-name').textContent = u.name;
    $('checkout-user-provider').textContent = `Conectado via ${providerLabel}`;
    setAvatar('user-avatar-img', 'user-avatar-fallback', u);
    setAvatar('checkout-avatar-img', 'checkout-avatar-fallback', u);
  }

  function renderStage() {
    const pub = state.pub;
    if (!pub) return;

    $('live-stream-title').textContent = pub.streamTitle || 'Sessão GTA VI';
    const iframe = $('ps5-live-iframe');
    if (pub.streamSourceUrl && iframe.getAttribute('src') !== pub.streamSourceUrl) iframe.setAttribute('src', pub.streamSourceUrl);
    $('stat-viewers').textContent = pub.viewersCount || 1;

    const q = pub.queueSummary || { peopleAheadCount: 0, queueOnlyCount: 0, estimatedWaitMinutesForNewPlayer: 0, items: [] };
    const badge = $('queue-badge');
    const list = $('queue-list');
    const note = $('checkout-queue-note');

    if (pub.emergencyOffline) {
      $('stat-player').textContent = 'Sistema desligado';
      badge.textContent = 'Fora do ar';
      badge.className = 'pill pill-red';
      $('queue-headline').textContent = 'Sistema temporariamente desligado.';
      $('queue-sub').textContent = 'Novos acessos e pagamentos estão pausados no momento.';
      $('queue-wait').textContent = 'Pausado';
      note.textContent = 'Sistema temporariamente desligado.';
      list.classList.add('hidden');
      return;
    }

    if (pub.consoleStatus === 'maintenance') {
      $('stat-player').textContent = 'Em manutenção';
      badge.textContent = 'Manutenção';
      badge.className = 'pill pill-red';
      $('queue-headline').textContent = 'Console em manutenção rápida.';
      $('queue-sub').textContent = 'Você pode comprar agora e entrar na fila; o tempo só conta quando liberar.';
      $('queue-wait').textContent = 'Pausado';
      note.textContent = 'Console em manutenção. Seu pedido entra na fila.';
      list.classList.add('hidden');
      return;
    }

    if (!pub.activePlayer) {
      $('stat-player').textContent = 'Console livre';
      badge.textContent = 'Fila zero';
      badge.className = 'pill pill-green';
      $('queue-headline').textContent = 'Ninguém na frente. Pagou, jogou.';
      $('queue-sub').textContent = 'Seu tempo só começa a contar quando o controle for liberado para você.';
      $('queue-wait').textContent = 'Imediato';
      note.textContent = 'Entrada imediata, ninguém na fila.';
      list.classList.add('hidden');
      return;
    }

    const minsLeft = Math.max(1, Math.ceil(pub.activePlayer.remainingSeconds / 60));
    $('stat-player').textContent = `Jogando: ${pub.activePlayer.name}`;
    badge.textContent = `${q.peopleAheadCount} na frente`;
    badge.className = 'pill pill-amber';
    $('queue-headline').textContent =
      q.queueOnlyCount > 0
        ? `1 jogando e ${q.queueOnlyCount} na fila. Garanta o próximo lugar.`
        : `1 jogador em sessão, termina em ~${minsLeft} min.`;
    $('queue-sub').textContent = 'Ordem de chegada. Seu tempo só começa quando chegar a sua vez.';
    $('queue-wait').textContent = `~${q.estimatedWaitMinutesForNewPlayer} min`;
    note.textContent = `Você entra na fila na posição #${q.peopleAheadCount}. Espera estimada: ~${q.estimatedWaitMinutesForNewPlayer} min.`;

    list.replaceChildren();
    const playing = el('div', 'queue-item is-playing');
    playing.append(el('b', '', 'JOGANDO'), el('strong', '', pub.activePlayer.name), el('span', '', `libera em ~${minsLeft} min`));
    list.append(playing);
    (q.items || []).forEach((item) => {
      const chip = el('div', 'queue-item');
      chip.append(el('b', '', `#${item.position}`), el('strong', '', item.name), el('span', '', `${item.totalMinutes} min · entra em ~${item.estimatedWaitMinutes} min`));
      list.append(chip);
    });
    list.classList.remove('hidden');
  }

  function isCrypto() {
    return state.method === 'crypto';
  }

  function grossUp(amount, feeRate) {
    return Math.round((amount / (1 - feeRate)) * 100) / 100;
  }

  function isCryptoAllowed() {
    return !(state.pkg === 'trial_10m' && !state.bump);
  }

  function renderPlans() {
    $$('[data-price]').forEach((node) => {
      const id = node.dataset.price;
      const p = PKG[id].price;
      const useCrypto = isCrypto() && id !== 'trial_10m';
      const shown = useCrypto ? grossUp(p * (1 - state.cryptoRate), state.npFeeRate) : grossUp(p, state.mpFeeRate);
      node.textContent = money(shown);
    });
    const trialRate = document.querySelector('.plan[data-pkg="trial_10m"] .plan-rate');
    if (trialRate) {
      trialRate.textContent = isCrypto() ? 'Apenas PIX (Crypto a partir de 1h)' : 'R$ 23,04/h';
    }
    $('toggle-pix').classList.toggle('active', !isCrypto());
    $('toggle-crypto').classList.toggle('active', isCrypto());

    $$('.plan[data-pkg]').forEach((card) => {
      card.classList.toggle('is-selected', card.dataset.pkg === state.pkg);
    });
    $$('[data-select-pkg]').forEach((btn) => {
      btn.textContent = BUTTON_LABELS[btn.dataset.selectPkg];
    });
  }

  function calc() {
    const pkg = PKG[state.pkg];
    const bumpBase = state.bump ? state.bumpPrice : 0;
    const baseSubtotal = Math.round((pkg.price + bumpBase) * 100) / 100;
    const pkgPix = grossUp(pkg.price, state.mpFeeRate);
    const bumpPix = grossUp(state.bumpPrice, state.mpFeeRate);
    const pixSubtotal = grossUp(baseSubtotal, state.mpFeeRate);

    let total;
    let discount;
    if (isCrypto()) {
      total = grossUp(baseSubtotal * (1 - state.cryptoRate), state.npFeeRate);
      discount = Math.round((pixSubtotal - total) * 100) / 100;
    } else {
      total = pixSubtotal;
      discount = 0;
    }

    return {
      pkg,
      pkgPix,
      bumpPix,
      discount,
      total,
      minutes: pkg.minutes + pkg.bonus + (state.bump ? 30 : 0)
    };
  }

  function renderCryptoCoins() {
    const quickWrap = $('coins-quick');
    const select = $('crypto-select');
    if (!quickWrap || !select) return;

    const quickIds = ['usdttrc20', 'usdtbsc', 'usdtmatic', 'btc'];
    quickWrap.replaceChildren();
    quickIds.forEach((id) => {
      const opt = state.cryptoOptions.find((c) => c.id === id);
      if (!opt) return;
      const btn = el('button', `coin ${opt.id === state.coin ? 'is-active' : ''}`);
      btn.type = 'button';
      btn.dataset.coin = opt.id;
      btn.append(document.createTextNode(opt.label + ' '), el('small', '', opt.network.split(' ')[0]));
      btn.addEventListener('click', () => {
        state.coin = opt.id;
        renderCheckout();
      });
      quickWrap.append(btn);
    });

    select.replaceChildren();
    const groups = {};
    state.cryptoOptions.forEach((opt) => {
      const g = opt.group || 'Moedas';
      if (!groups[g]) groups[g] = [];
      groups[g].push(opt);
    });
    Object.keys(groups).forEach((gName) => {
      const og = document.createElement('optgroup');
      og.label = gName;
      groups[gName].forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.id;
        o.textContent = `${opt.label} — Rede ${opt.network}`;
        og.append(o);
      });
      select.append(og);
    });
    select.value = state.coin;
  }

  function renderCheckout() {
    const cryptoAllowed = isCryptoAllowed();
    if (!cryptoAllowed && state.method === 'crypto') {
      state.method = 'pix';
    }
    const c = calc();

    $$('[data-pick]').forEach((b) => b.classList.toggle('is-active', b.dataset.pick === state.pkg));
    $$('[data-method-choice]').forEach((l) => {
      const isCryChoice = l.dataset.methodChoice === 'crypto';
      l.classList.toggle('is-active', l.dataset.methodChoice === state.method);
      l.classList.toggle('is-disabled', isCryChoice && !cryptoAllowed);
      const input = l.querySelector('input');
      if (input) input.disabled = isCryChoice && !cryptoAllowed;
      if (isCryChoice) {
        const sm = l.querySelector('small');
        if (sm) sm.textContent = cryptoAllowed ? 'USDT, USDC, BTC, ETH, LTC, TRX, BNB, TON' : 'Disponível a partir de 1 hora';
      }
    });
    $$('input[name="pay"]').forEach((r) => (r.checked = r.value === state.method));
    $('coins').classList.toggle('hidden', !isCrypto());
    $$('[data-coin]').forEach((b) => b.classList.toggle('is-active', b.dataset.coin === state.coin));
    const selEl = $('crypto-select');
    if (selEl && selEl.value !== state.coin) selEl.value = state.coin;

    const selCoin = state.cryptoOptions.find((x) => x.id === state.coin) || { label: state.coin.toUpperCase(), network: '' };
    const warnEl = $('crypto-network-warn');
    if (warnEl) {
      warnEl.textContent = `⚠️ Envie ${selCoin.label} apenas na rede ${selCoin.network} para evitar perda de fundos.`;
    }

    $('bump-price').textContent = '+ ' + money(c.bumpPix);
    $('r-name').textContent = c.pkg.name;
    $('r-price').textContent = money(c.pkgPix);
    $('r-bonus-row').classList.toggle('hidden', !c.pkg.bonus);
    $('r-bonus').textContent = c.pkg.bonus >= 60 ? `Bônus +${duration(c.pkg.bonus)}` : `Bônus +${c.pkg.bonus} min`;
    $('r-bump-row').classList.toggle('hidden', !state.bump);
    $('r-bump').textContent = '+ ' + money(c.bumpPix);
    $('r-crypto-row').classList.toggle('hidden', !isCrypto());
    $('r-crypto').textContent = '- ' + money(c.discount);
    $('r-time').textContent = duration(c.minutes);
    $('r-total').textContent = money(c.total);
    const selCoin2 = state.cryptoOptions.find((x) => x.id === state.coin) || { label: state.coin.toUpperCase(), network: '' };
    $('r-usdt').classList.toggle('hidden', !isCrypto());
    $('r-usdt').textContent = `≈ ${(c.total / state.usdtRate).toFixed(2)} USDT (${selCoin2.label} · ${selCoin2.network})`;

    const offline = !!(state.pub && state.pub.emergencyOffline);
    const queued = state.pub && (state.pub.activePlayer || state.pub.consoleStatus === 'maintenance');
    const submitBtn = $('btn-submit-order');
    submitBtn.disabled = offline;
    submitBtn.textContent = offline
      ? 'Sistema desligado (emergência)'
      : state.user
      ? `${queued ? 'Garantir vaga na fila' : 'Gerar pagamento'} · ${money(c.total)}`
      : 'Entrar para continuar';

    $('cta-title').textContent = `${c.pkg.name} por ${money(c.total)}`;
  }

  function renderAll() {
    renderPlans();
    renderCheckout();
  }

  // ---------------------------------------------------------------- login
  function startLogin(provider) {
    if (!state.providers[provider]) {
      toast(AUTH_ERRORS[`${provider}_not_configured`], 'error');
      return;
    }
    const resumeCheckout = !$('checkout-modal').classList.contains('hidden') || !$('login-modal').classList.contains('hidden');
    sessionStorage.setItem(
      STORAGE_PENDING,
      JSON.stringify({ pkg: state.pkg, bump: state.bump, method: state.method, coin: state.coin, resume: resumeCheckout })
    );
    window.location.href = `/auth/${provider}`;
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    state.user = null;
    state.isAdmin = false;
    renderAuth();
    renderCheckout();
    toast('Você saiu da conta.');
  }

  function handleReturnFromLogin() {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('auth_error');
    const loginOk = params.get('login') === 'ok';
    if (err || loginOk) history.replaceState(null, '', window.location.pathname + window.location.hash);
    if (err) {
      toast(AUTH_ERRORS[err] || 'Falha no login.', 'error');
      sessionStorage.removeItem(STORAGE_PENDING);
      return;
    }
    if (!loginOk || !state.user) return;

    toast(`Conectado como ${state.user.name}.`, 'success');
    let pending = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(STORAGE_PENDING) || 'null');
    } catch {}
    sessionStorage.removeItem(STORAGE_PENDING);
    if (pending) {
      if (PKG[pending.pkg]) state.pkg = pending.pkg;
      state.bump = !!pending.bump;
      state.method = pending.method === 'crypto' ? 'crypto' : 'pix';
      if (state.cryptoOptions.some((c) => c.id === pending.coin)) state.coin = pending.coin;
      $('chk-bump').checked = state.bump;
      renderAll();
      if (pending.resume) openModal('checkout-modal');
    }
  }

  // ---------------------------------------------------------------- checkout
  function openCheckout(pkg) {
    if (pkg && PKG[pkg]) state.pkg = pkg;
    renderAll();
    openModal('checkout-modal');
  }

  async function submitOrder(retried) {
    if (!state.user) {
      openModal('login-modal');
      return;
    }
    const btn = $('btn-submit-order');
    btn.disabled = true;
    btn.textContent = 'Gerando pagamento...';

    const { ok, status, data } = await api('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '' },
      body: JSON.stringify({
        packageId: state.pkg,
        includeBump: state.bump,
        paymentMethod: isCrypto() ? state.coin : 'pix'
      })
    }).catch(() => ({ ok: false, status: 0, data: {} }));

    btn.disabled = false;
    renderCheckout();

    if (ok && data.order) {
      closeModal('checkout-modal');
      showOrder(data.order);
      return;
    }
    if (status === 403 && data.error === 'csrf' && !retried) {
      await loadConfig();
      return submitOrder(true);
    }
    if (status === 401) {
      state.user = null;
      renderAuth();
      openModal('login-modal');
      return;
    }
    toast(data.message || data.error || 'Não foi possível gerar o pedido.', 'error');
  }

  function showOrder(order) {
    state.order = order;
    state.soundPromptDismissed = false;
    $('order-title').textContent = `Pedido #${order.orderId}`;
    $('o-plan').textContent = order.packageName;
    $('o-time').textContent = duration(order.totalMinutes);
    $('o-total').textContent = order.isCrypto
      ? order.cryptoPayAmount
        ? `${order.cryptoPayAmount} ${order.cryptoPayCurrency}`
        : `${money(order.finalPriceBRL)} · ${order.finalUSDT} USDT`
      : money(order.finalPriceBRL);
    const netSuffix = order.cryptoNetwork ? ` (Rede ${order.cryptoNetwork})` : '';
    $('order-method-label').textContent = order.isCrypto
      ? order.cryptoPayAmount
        ? `Envie exatamente ${order.cryptoPayAmount} ${order.cryptoPayCurrency}${netSuffix}`
        : `Envie ${order.finalUSDT} USDT equivalentes em ${order.paymentMethod.toUpperCase()}${netSuffix}`
      : order.mpMode === 'sandbox'
      ? 'PIX Mercado Pago (MODO TESTE — use Access Token APP_USR- para banco real)'
      : 'PIX Mercado Pago · Escaneie o QR Code ou use Copia e Cola';
    $('o-code-label').textContent = order.isCrypto
      ? `Endereço ${order.cryptoPayCurrency || order.paymentMethod.toUpperCase()}${netSuffix}`
      : 'PIX copia e cola';
    $('o-code').value = order.paymentCode || '';
    const amountBox = $('o-amount-box');
    const amountInput = $('o-crypto-amount');
    if (order.isCrypto) {
      const exactVal = order.cryptoPayAmount || order.finalUSDT;
      const exactCur = order.cryptoPayCurrency || order.paymentMethod.toUpperCase();
      $('o-amount-label').textContent = `Valor exato a enviar (${exactCur})`;
      amountInput.value = exactVal;
      $('o-exact-warn').textContent = `⚠️ Envie exatamente ${exactVal} ${exactCur}${netSuffix} (sem descontar a taxa da corretora). Valores menores não confirmam automaticamente.`;
      amountBox.classList.remove('hidden');
    } else {
      amountBox.classList.add('hidden');
      amountInput.value = '';
    }
    const extraBox = $('o-extra-box');
    const extraInput = $('o-extra-id');
    if (order.isCrypto && order.cryptoExtraId) {
      extraInput.value = order.cryptoExtraId;
      extraBox.classList.remove('hidden');
    } else {
      extraBox.classList.add('hidden');
      extraInput.value = '';
    }
    const qrBox = $('o-qr-box');
    const qrImg = $('o-qr-img');
    if (order.pixQrBase64) {
      qrImg.src = `data:image/png;base64,${order.pixQrBase64}`;
      qrBox.classList.remove('hidden');
    } else {
      qrBox.classList.add('hidden');
      qrImg.removeAttribute('src');
    }
    $('btn-demo-pay').classList.toggle('hidden', !state.demoMode);
    updateOrderStatus(order);
    openModal('order-modal');
    startPolling();
  }

  function updateOrderStatus(o) {
    state.order = { ...state.order, ...o };
    const pill = $('o-status-pill');
    const spinner = $('o-spinner');
    const title = $('o-status-title');
    const text = $('o-status-text');
    const pin = $('o-pin');
    const parsec = $('o-parsec');
    const payBlock = $('o-pay-block');
    const demo = $('btn-demo-pay');

    pin.classList.add('hidden');
    parsec.classList.add('hidden');
    spinner.classList.add('hidden');
    payBlock.classList.toggle('hidden', o.status !== 'pending');
    demo.classList.toggle('hidden', !(state.demoMode && o.status === 'pending'));
    renderSoundPrompt(o.status);

    switch (o.status) {
      case 'pending':
        pill.className = 'pill pill-amber';
        pill.textContent = 'Aguardando pagamento';
        spinner.classList.remove('hidden');
        title.textContent = 'Aguardando confirmação';
        text.textContent = 'Assim que o pagamento for confirmado, seu acesso aparece aqui automaticamente.';
        startCountdown(state.order.expiresAt);
        break;
      case 'queued':
        stopCountdown();
        pill.className = 'pill pill-cyan';
        pill.textContent = `Na fila · #${o.queuePosition}`;
        spinner.classList.remove('hidden');
        title.textContent = 'Pagamento confirmado';
        text.textContent = `Você é o #${o.queuePosition} da fila. Previsão: ~${o.estimatedWaitMinutes} min. Seu tempo só começa quando o controle for liberado.`;
        break;
      case 'active':
        stopCountdown();
        pill.className = 'pill pill-green';
        pill.textContent = 'Controle liberado';
        title.textContent = 'É a sua vez!';
        text.textContent = `Tempo restante: ${duration(Math.ceil((o.remainingSeconds || 0) / 60))}. Use o PIN abaixo no PS Remote Play.`;
        if (o.accessPin) {
          pin.textContent = o.accessPin;
          pin.classList.remove('hidden');
        }
        if (o.parsecInviteUrl) {
          parsec.href = o.parsecInviteUrl;
          parsec.classList.remove('hidden');
        }
        break;
      case 'completed':
        stopCountdown();
        pill.className = 'pill';
        pill.textContent = 'Sessão encerrada';
        title.textContent = 'Obrigado por jogar!';
        text.textContent = 'Seu tempo terminou. Quer continuar? Escolha um novo plano.';
        stopPolling();
        break;
      case 'expired':
      case 'cancelled':
        stopCountdown();
        pill.className = 'pill pill-red';
        pill.textContent = o.status === 'expired' ? 'Expirado' : 'Cancelado';
        title.textContent = o.status === 'expired' ? 'Pagamento não identificado' : 'Pedido cancelado';
        text.textContent = 'Gere um novo pedido para jogar.';
        stopPolling();
        break;
      default:
        break;
    }
  }

  async function pollOrder() {
    if (!state.order) return;
    const qs = new URLSearchParams({ id: state.order.orderId });
    if (state.order.orderToken) qs.set('ot', state.order.orderToken);
    const { ok, data } = await api(`/api/order?${qs.toString()}`).catch(() => ({ ok: false }));
    if (ok && data.order) {
      const prevStatus = state.order.status;
      updateOrderStatus(data.order);
      if (prevStatus !== 'active' && data.order.status === 'active') {
        loadConfig();
        if (prevStatus === 'queued' || state.soundAlertEnabled) notifyTurnReady();
      }
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(pollOrder, 4000);
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function demoPay() {
    if (!state.order) return;
    const btn = $('btn-demo-pay');
    btn.disabled = true;
    const { ok, data } = await api('/api/demo/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '' },
      body: JSON.stringify({ orderId: state.order.orderId })
    });
    btn.disabled = false;
    if (ok && data.order) {
      updateOrderStatus(data.order);
      loadConfig();
    } else {
      toast(data.error || 'Falha ao simular pagamento.', 'error');
    }
  }

  async function copyCode() {
    const input = $('o-code');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    const btn = $('btn-copy');
    btn.textContent = 'Copiado';
    setTimeout(() => (btn.textContent = 'Copiar'), 1800);
  }

  // ---------------------------------------------------------------- eventos
  function bindEvents() {
    $('btn-open-login').addEventListener('click', () => openModal('login-modal'));
    $('btn-logout').addEventListener('click', logout);

    $$('[data-login]').forEach((b) => b.addEventListener('click', () => startLogin(b.dataset.login)));
    $$('[data-open-checkout]').forEach((b) => b.addEventListener('click', () => openCheckout()));
    $$('[data-select-pkg]').forEach((b) => b.addEventListener('click', () => openCheckout(b.dataset.selectPkg)));
    $$('[data-pick]').forEach((b) =>
      b.addEventListener('click', () => {
        state.pkg = b.dataset.pick;
        renderAll();
      })
    );

    $('toggle-pix').addEventListener('click', () => {
      state.method = 'pix';
      renderAll();
    });
    $('toggle-crypto').addEventListener('click', () => {
      state.method = 'crypto';
      renderAll();
    });

    $$('input[name="pay"]').forEach((r) =>
      r.addEventListener('change', () => {
        state.method = r.value === 'crypto' ? 'crypto' : 'pix';
        renderAll();
      })
    );
    $$('[data-coin]').forEach((b) =>
      b.addEventListener('click', () => {
        state.coin = b.dataset.coin;
        renderCheckout();
      })
    );
    $('chk-bump').addEventListener('change', (e) => {
      state.bump = e.target.checked;
      renderCheckout();
    });

    $('crypto-select').addEventListener('change', (e) => {
      state.coin = e.target.value;
      renderCheckout();
    });

    $('btn-copy-amount').addEventListener('click', async () => {
      const input = $('o-crypto-amount');
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      const btn = $('btn-copy-amount');
      btn.textContent = 'Copiado';
      setTimeout(() => (btn.textContent = 'Copiar'), 1800);
    });

    $('btn-copy-extra').addEventListener('click', async () => {
      const input = $('o-extra-id');
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      const btn = $('btn-copy-extra');
      btn.textContent = 'Copiado';
      setTimeout(() => (btn.textContent = 'Copiar'), 1800);
    });

    $('btn-submit-order').addEventListener('click', () => submitOrder(false));
    $('btn-copy').addEventListener('click', copyCode);
    $('btn-demo-pay').addEventListener('click', demoPay);

    $('btn-sound-enable').addEventListener('click', () => {
      state.soundAlertEnabled = true;
      playChime('confirm');
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
      renderSoundPrompt(state.order?.status);
      toast('Aviso sonoro ativado! Vamos tocar um alerta quando for sua vez.', 'success');
    });

    $('btn-sound-dismiss').addEventListener('click', () => {
      if (state.soundAlertEnabled) {
        state.soundAlertEnabled = false;
        renderSoundPrompt(state.order?.status);
        toast('Aviso sonoro desativado.');
      } else {
        state.soundPromptDismissed = true;
        renderSoundPrompt(state.order?.status);
      }
    });

    // Fechar modais: botão, clique fora e tecla Esc
    $$('[data-close-modal]').forEach((b) => b.addEventListener('click', () => closeModal(b.closest('.modal').id)));
    $$('.modal').forEach((m) =>
      m.addEventListener('mousedown', (e) => {
        if (e.target === m) closeModal(m.id);
      })
    );
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = [...$$('.modal:not(.hidden)')].pop();
      if (open) closeModal(open.id);
    });
  }

  function setupReveal() {
    const items = $$('.reveal');
    if (!('IntersectionObserver' in window)) {
      items.forEach((i) => i.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    items.forEach((i, idx) => {
      i.style.transitionDelay = `${Math.min(idx % 4, 3) * 70}ms`;
      io.observe(i);
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    renderCryptoCoins();
    setupReveal();
    renderAll();
    await Promise.all([loadMe(), loadConfig()]);
    handleReturnFromLogin();

    setInterval(() => {
      if (!document.hidden) loadConfig();
    }, 8000);
  });
})();
