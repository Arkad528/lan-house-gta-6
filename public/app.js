(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  const PKG = {
    trial_10m: { name: 'Teste Rápido (10 min)', short: '10 min', minutes: 10, bonus: 0, price: 3.8 },
    hour_1h: { name: 'Sessão 1 Hora', short: '1 hora', minutes: 60, bonus: 0, price: 22.75 },
    combo_2h: { name: 'Combo Heist Leonida (2h10)', short: '2h10', minutes: 120, bonus: 10, price: 44.9 },
    pass_4h: { name: 'Passaporte Madrugada (4h25)', short: '4h25', minutes: 240, bonus: 25, price: 86.9 }
  };

  const BUTTON_LABELS = {
    trial_10m: 'Jogar 10 minutos',
    hour_1h: 'Jogar 1 hora',
    combo_2h: 'Jogar Combo 2h10',
    pass_4h: 'Jogar 4h25'
  };

  const AUTH_ERRORS = {
    discord_not_configured: 'Login com Discord ainda não foi configurado no servidor.',
    google_not_configured: 'Login com Google ainda não foi configurado no servidor.',
    cancelled: 'Login cancelado.',
    state: 'Sessão de login expirou. Tente novamente.',
    failed: 'Não foi possível concluir o login. Tente novamente.'
  };

  const STORAGE_PENDING = 'vp_after_login';

  const state = {
    csrf: null,
    user: null,
    providers: { discord: false, google: false },
    demoMode: false,
    pkg: 'combo_2h',
    bump: false,
    method: 'pix',
    coin: 'usdt',
    bumpPrice: 9.9,
    cryptoRate: 0.15,
    usdtRate: 5,
    pub: null,
    order: null,
    pollTimer: null
  };

  const clientId = (() => {
    let id = sessionStorage.getItem('vp_cid');
    if (!id || !/^[a-z0-9]{8,32}$/.test(id)) {
      id = (Math.random().toString(36).slice(2, 12) + Date.now().toString(36)).slice(0, 24);
      sessionStorage.setItem('vp_cid', id);
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
    if (id === 'order-modal') stopPolling();
  }

  // ---------------------------------------------------------------- dados
  async function loadMe() {
    const { ok, data } = await api('/api/me');
    if (!ok) return;
    state.user = data.user;
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
    if (typeof data.usdtRateBRL === 'number') state.usdtRate = data.usdtRateBRL;
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

  function renderPlans() {
    $$('[data-price]').forEach((node) => {
      const p = PKG[node.dataset.price].price;
      node.textContent = money(isCrypto() ? p * (1 - state.cryptoRate) : p);
    });
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
    const bumpPrice = state.bump ? state.bumpPrice : 0;
    const subtotal = Math.round((pkg.price + bumpPrice) * 100) / 100;
    const discount = isCrypto() ? Math.round(subtotal * state.cryptoRate * 100) / 100 : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;
    return {
      pkg,
      bumpPrice,
      discount,
      total,
      minutes: pkg.minutes + pkg.bonus + (state.bump ? 30 : 0)
    };
  }

  function renderCheckout() {
    const c = calc();

    $$('[data-pick]').forEach((b) => b.classList.toggle('is-active', b.dataset.pick === state.pkg));
    $$('[data-method-choice]').forEach((l) => l.classList.toggle('is-active', l.dataset.methodChoice === state.method));
    $$('input[name="pay"]').forEach((r) => (r.checked = r.value === state.method));
    $('coins').classList.toggle('hidden', !isCrypto());
    $$('[data-coin]').forEach((b) => b.classList.toggle('is-active', b.dataset.coin === state.coin));

    $('bump-price').textContent = '+ ' + money(state.bumpPrice);
    $('r-name').textContent = c.pkg.name;
    $('r-price').textContent = money(c.pkg.price);
    $('r-bonus-row').classList.toggle('hidden', !c.pkg.bonus);
    $('r-bonus').textContent = `Bônus +${c.pkg.bonus} min`;
    $('r-bump-row').classList.toggle('hidden', !state.bump);
    $('r-bump').textContent = '+ ' + money(state.bumpPrice);
    $('r-crypto-row').classList.toggle('hidden', !isCrypto());
    $('r-crypto').textContent = '- ' + money(c.discount);
    $('r-time').textContent = duration(c.minutes);
    $('r-total').textContent = money(c.total);
    $('r-usdt').classList.toggle('hidden', !isCrypto());
    $('r-usdt').textContent = `≈ ${(c.total / state.usdtRate).toFixed(2)} USDT (pago em ${state.coin.toUpperCase()})`;

    const queued = state.pub && (state.pub.activePlayer || state.pub.consoleStatus === 'maintenance');
    $('btn-submit-order').textContent = state.user
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
      if (['usdt', 'btc', 'sol'].includes(pending.coin)) state.coin = pending.coin;
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
    $('order-title').textContent = `Pedido #${order.orderId}`;
    $('o-plan').textContent = order.packageName;
    $('o-time').textContent = duration(order.totalMinutes);
    $('o-total').textContent = order.isCrypto ? `${money(order.finalPriceBRL)} · ${order.finalUSDT} USDT` : money(order.finalPriceBRL);
    $('order-method-label').textContent = order.isCrypto
      ? `Envie ${order.finalUSDT} USDT equivalentes em ${order.paymentMethod.toUpperCase()}`
      : 'Pague com PIX copia e cola';
    $('o-code-label').textContent = order.isCrypto ? `Carteira ${order.paymentMethod.toUpperCase()}` : 'PIX copia e cola';
    $('o-code').value = order.paymentCode || '';
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

    switch (o.status) {
      case 'pending':
        pill.className = 'pill pill-amber';
        pill.textContent = 'Aguardando pagamento';
        spinner.classList.remove('hidden');
        title.textContent = 'Aguardando confirmação';
        text.textContent = 'Assim que o pagamento for confirmado, seu acesso aparece aqui automaticamente.';
        break;
      case 'queued':
        pill.className = 'pill pill-cyan';
        pill.textContent = `Na fila · #${o.queuePosition}`;
        spinner.classList.remove('hidden');
        title.textContent = 'Pagamento confirmado';
        text.textContent = `Você é o #${o.queuePosition} da fila. Previsão: ~${o.estimatedWaitMinutes} min. Seu tempo só começa quando o controle for liberado.`;
        break;
      case 'active':
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
        pill.className = 'pill';
        pill.textContent = 'Sessão encerrada';
        title.textContent = 'Obrigado por jogar!';
        text.textContent = 'Seu tempo terminou. Quer continuar? Escolha um novo plano.';
        stopPolling();
        break;
      case 'expired':
      case 'cancelled':
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
    const { ok, data } = await api(`/api/order?id=${encodeURIComponent(state.order.orderId)}`).catch(() => ({ ok: false }));
    if (ok && data.order) {
      const wasActive = state.order.status === 'active';
      updateOrderStatus(data.order);
      if (!wasActive && data.order.status === 'active') loadConfig();
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

    $('btn-submit-order').addEventListener('click', () => submitOrder(false));
    $('btn-copy').addEventListener('click', copyCode);
    $('btn-demo-pay').addEventListener('click', demoPay);

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
    setupReveal();
    renderAll();
    await Promise.all([loadMe(), loadConfig()]);
    handleReturnFromLogin();

    setInterval(() => {
      if (!document.hidden) loadConfig();
    }, 8000);
  });
})();
