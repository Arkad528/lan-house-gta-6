/**
 * ViceCloud PS5 - Frontend Principal + Live Stream Stage + Sincronia com /admin
 */

(function () {
  'use strict';

  const state = {
    csrfToken: null,
    selectedPackageId: 'combo_3h',
    customMinutes: null,
    includeBump: false,
    paymentMethod: 'pix', // 'pix' | 'usdt' | 'btc' | 'sol'
    cryptoCoin: 'usdt',
    showCryptoInCards: false,
    user: null,
    pendingCheckoutAfterAuth: false,
    bumpPriceBRL: 3.50,
    cryptoDiscountRate: 0.15,
    ps5Public: null
  };

  const PACKAGES_CLIENT = {
    trial_10m: { id: 'trial_10m', name: 'Teste Rápido (10 Min)', minutes: 10, priceBRL: 1.95, bonusMinutes: 0 },
    hour_1h: { id: 'hour_1h', name: 'Sessão 1 Hora', minutes: 60, priceBRL: 11.70, bonusMinutes: 0 },
    decoy_2h: { id: 'decoy_2h', name: 'Sessão 2 Horas', minutes: 120, priceBRL: 22.50, bonusMinutes: 0 },
    combo_3h: { id: 'combo_3h', name: 'Combo 3 Horas (+15m Grátis)', minutes: 180, priceBRL: 24.90, bonusMinutes: 15 },
    pass_6h: { id: 'pass_6h', name: 'Maratona 6 Horas (+30m Grátis)', minutes: 360, priceBRL: 38.90, bonusMinutes: 30 }
  };

  const BUMP_MINUTES = 30;

  function formatBRL(val) {
    return 'R$ ' + Number(val).toFixed(2).replace('.', ',');
  }

  function formatDuration(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h}h 00min`;
    return `${h}h ${m}min`;
  }

  async function initConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        state.csrfToken = data.csrfToken;
        if (data.packages) {
          Object.keys(data.packages).forEach((k) => {
            if (PACKAGES_CLIENT[k]) {
              PACKAGES_CLIENT[k].priceBRL = data.packages[k].priceBRL;
            }
          });
        }
        if (typeof data.bumpPriceBRL === 'number') state.bumpPriceBRL = data.bumpPriceBRL;
        if (typeof data.cryptoDiscountRate === 'number') state.cryptoDiscountRate = data.cryptoDiscountRate;
        if (data.ps5Public) {
          state.ps5Public = data.ps5Public;
          renderLiveStage(data.ps5Public);
        }
      }
    } catch (err) {}
    loadSavedUser();
    renderAll();
  }

  function renderLiveStage(pub) {
    if (!pub) return;
    const titleEl = document.getElementById('live-stream-title');
    if (titleEl && pub.streamTitle) titleEl.textContent = pub.streamTitle;

    const iframe = document.getElementById('ps5-live-iframe');
    if (iframe && pub.streamSourceUrl && iframe.getAttribute('src') !== pub.streamSourceUrl) {
      iframe.setAttribute('src', pub.streamSourceUrl);
    }

    const viewersEl = document.getElementById('live-viewers-count');
    if (viewersEl && pub.viewersCount) viewersEl.textContent = pub.viewersCount;

    const playerStatusEl = document.getElementById('live-player-status');
    const topStatusText = document.getElementById('top-status-text');

    if (pub.activePlayer) {
      const minsLeft = Math.ceil(pub.activePlayer.remainingSeconds / 60);
      if (playerStatusEl) {
        playerStatusEl.textContent = `🎮 Jogando agora: ${pub.activePlayer.userHandle} (${minsLeft}m restantes)`;
      }
      if (topStatusText) {
        topStatusText.textContent = `Em Sessão: ${pub.activePlayer.userHandle} • ${minsLeft}m restantes`;
      }
    } else if (pub.consoleStatus === 'maintenance') {
      if (playerStatusEl) playerStatusEl.textContent = '🔧 Console em Manutenção';
      if (topStatusText) topStatusText.textContent = 'PS5 em Manutenção';
    } else {
      if (playerStatusEl) playerStatusEl.textContent = '🟢 Console Livre p/ Assumir Agora';
      if (topStatusText) topStatusText.textContent = 'PS5 Online • 14ms • Livre p/ Jogar';
    }

    // Atualizar atributos base dos cards caso o admin tenha alterado preços
    ['trial_10m', 'decoy_2h', 'combo_3h', 'pass_6h'].forEach((id) => {
      const el = document.getElementById(`card-price-${id}`);
      if (el && PACKAGES_CLIENT[id]) {
        el.setAttribute('data-base-price', String(PACKAGES_CLIENT[id].priceBRL));
      }
    });

    const bumpDisplay = document.getElementById('bump-price-display');
    if (bumpDisplay) bumpDisplay.textContent = '+ ' + formatBRL(state.bumpPriceBRL);
    const receiptBumpVal = document.getElementById('receipt-bump-val');
    if (receiptBumpVal) receiptBumpVal.textContent = '+ ' + formatBRL(state.bumpPriceBRL);
  }

  function loadSavedUser() {
    try {
      const raw = sessionStorage.getItem('vicecloud_user');
      if (raw) state.user = JSON.parse(raw);
    } catch (e) {}
  }

  function saveUser(provider, handle) {
    state.user = { provider, handle };
    try {
      sessionStorage.setItem('vicecloud_user', JSON.stringify(state.user));
    } catch (e) {}
    renderAuthUI();
  }

  function logoutUser() {
    state.user = null;
    try {
      sessionStorage.removeItem('vicecloud_user');
    } catch (e) {}
    renderAuthUI();
  }

  function computeCurrentSelection() {
    const p10 = PACKAGES_CLIENT.trial_10m.priceBRL;
    const p60 = PACKAGES_CLIENT.hour_1h.priceBRL;
    const p120 = PACKAGES_CLIENT.decoy_2h.priceBRL;
    const p180 = PACKAGES_CLIENT.combo_3h.priceBRL;
    const p360 = PACKAGES_CLIENT.pass_6h.priceBRL;

    let baseMinutes = 180;
    let basePrice = p180;
    let bonusMinutes = 15;
    let title = PACKAGES_CLIENT.combo_3h.name;

    if (state.selectedPackageId && PACKAGES_CLIENT[state.selectedPackageId]) {
      const pkg = PACKAGES_CLIENT[state.selectedPackageId];
      baseMinutes = pkg.minutes;
      basePrice = pkg.priceBRL;
      bonusMinutes = pkg.bonusMinutes;
      title = pkg.name;
    } else if (state.customMinutes) {
      const m = state.customMinutes;
      baseMinutes = m;

      if (m <= 60) {
        basePrice = (m / 10) * p10;
        bonusMinutes = 0;
      } else if (m <= 120) {
        basePrice = p60 + ((m - 60) / 60) * (p120 - p60);
        bonusMinutes = 0;
      } else if (m < 180) {
        basePrice = p120 + ((m - 120) / 60) * (p180 - p120);
        bonusMinutes = 0;
      } else if (m === 180) {
        basePrice = p180;
        bonusMinutes = 15;
      } else if (m < 360) {
        basePrice = p180 + ((m - 180) / 180) * (p360 - p180);
        bonusMinutes = 15;
      } else {
        basePrice = p360;
        bonusMinutes = 30;
      }
      basePrice = Math.round(basePrice * 100) / 100;
      title = `Sessão Personalizada (${m} min)`;
    }

    let upsellMessage = '';
    let upsellTargetPkg = null;

    if (baseMinutes < 120) {
      upsellMessage = `🍔 <strong>Gatilho de Economia:</strong> No avulso sai a ${formatBRL(p10)} / 10m. No <strong>Combo 3 Horas</strong> cai para <strong>${formatBRL(p180 / 19.5)} / 10m + 15 min grátis!</strong>`;
      upsellTargetPkg = 'combo_3h';
    } else if (baseMinutes >= 120 && baseMinutes < 180) {
      const diff = Math.max(0.40, p180 - basePrice);
      upsellMessage = `🍟 <strong>Efeito McDonald's:</strong> Por apenas <strong>+${formatBRL(diff)}</strong> você leva o <strong>Combo 3 Horas (195 min direto na sessão)</strong>!`;
      upsellTargetPkg = 'combo_3h';
    } else if (baseMinutes >= 180 && baseMinutes < 360) {
      upsellMessage = `🔥 <strong>Combo 3h Ativo (+15m grátis)!</strong> Quer dobrar para <strong>6 Horas + 30m grátis</strong> por só +${formatBRL(Math.max(1, p360 - basePrice))}?`;
      upsellTargetPkg = 'pass_6h';
    } else {
      upsellMessage = `👑 <strong>Maratona 6 Horas Ativa!</strong> Menor preço por minuto (+30 min grátis inclusos na mesma sessão).`;
      upsellTargetPkg = null;
    }

    const bumpPrice = state.includeBump ? state.bumpPriceBRL : 0;
    const bumpMinutes = state.includeBump ? BUMP_MINUTES : 0;
    const subtotal = Math.round((basePrice + bumpPrice) * 100) / 100;
    const isCrypto = ['usdt', 'btc', 'sol'].includes(state.paymentMethod);
    const cryptoDiscount = isCrypto ? Math.round(subtotal * state.cryptoDiscountRate * 100) / 100 : 0;
    const totalBRL = Math.round((subtotal - cryptoDiscount) * 100) / 100;
    const totalMinutes = baseMinutes + bonusMinutes + bumpMinutes;
    const effectiveRate10m = totalBRL / (totalMinutes / 10);

    return {
      title,
      baseMinutes,
      basePrice,
      bonusMinutes,
      bumpPrice,
      bumpMinutes,
      subtotal,
      isCrypto,
      cryptoDiscount,
      totalBRL,
      totalUSDT: (totalBRL / 5.0).toFixed(2),
      totalMinutes,
      effectiveRate10m,
      upsellMessage,
      upsellTargetPkg
    };
  }

  function renderPricingCards() {
    const priceEls = document.querySelectorAll('.price-main[data-base-price]');
    priceEls.forEach((el) => {
      const raw = parseFloat(el.getAttribute('data-base-price'));
      const val = state.showCryptoInCards ? Math.round(raw * (1 - state.cryptoDiscountRate) * 100) / 100 : raw;
      el.textContent = formatBRL(val);
    });

    document.getElementById('toggle-show-pix').classList.toggle('active', !state.showCryptoInCards);
    document.getElementById('toggle-show-crypto').classList.toggle('active', state.showCryptoInCards);

    document.querySelectorAll('.price-card[data-pkg]').forEach((card) => {
      const pkgId = card.getAttribute('data-pkg');
      const btn = card.querySelector('[data-select-pkg]');
      const isSelected = state.selectedPackageId === pkgId;
      card.classList.toggle('active-card', isSelected);
      if (btn) {
        if (isSelected) {
          btn.textContent = 'Selecionado ✓';
        } else {
          const labels = {
            trial_10m: 'Escolher 10 Min',
            decoy_2h: 'Escolher 2 Horas',
            combo_3h: 'Quero o Combo 3h',
            pass_6h: 'Escolher 6 Horas'
          };
          btn.textContent = labels[pkgId] || 'Escolher';
        }
      }
    });
  }

  function renderAuthUI() {
    const authArea = document.getElementById('auth-area');
    const userPill = document.getElementById('user-pill');
    const chkPrompt = document.getElementById('checkout-auth-prompt');
    const chkLogged = document.getElementById('checkout-auth-logged');

    if (state.user) {
      authArea.classList.add('hidden');
      userPill.classList.remove('hidden');
      chkPrompt.classList.add('hidden');
      chkLogged.classList.remove('hidden');

      const isDiscord = state.user.provider === 'discord';
      document.getElementById('user-avatar').textContent = isDiscord ? 'DC' : 'G';
      document.getElementById('user-name').textContent = state.user.handle;
      document.getElementById('user-provider').textContent = isDiscord ? 'Discord' : 'Google';
      document.getElementById('chk-user-label').textContent = `${state.user.handle} (${isDiscord ? 'Discord' : 'Google'})`;
    } else {
      authArea.classList.remove('hidden');
      userPill.classList.add('hidden');
      chkPrompt.classList.remove('hidden');
      chkLogged.classList.add('hidden');
    }
  }

  function renderCalculatorAndCheckout() {
    const calc = computeCurrentSelection();

    document.getElementById('time-slider').value = calc.baseMinutes;
    document.getElementById('slider-time-display').textContent = formatDuration(calc.baseMinutes);

    const bonusTag = document.getElementById('slider-bonus-display');
    if (calc.bonusMinutes > 0) {
      bonusTag.textContent = `+${calc.bonusMinutes} min grátis`;
      bonusTag.classList.remove('hidden');
    } else {
      bonusTag.classList.add('hidden');
    }

    document.getElementById('slider-rate-10m').textContent = formatBRL(calc.effectiveRate10m);
    document.getElementById('smart-upsell-text').innerHTML = calc.upsellMessage;

    const btnUpgrade = document.getElementById('btn-upsell-upgrade');
    if (calc.upsellTargetPkg) {
      btnUpgrade.classList.remove('hidden');
      btnUpgrade.textContent = calc.upsellTargetPkg === 'combo_3h' ? 'Pegar Combo 3h' : 'Pegar 6 Horas';
      btnUpgrade.onclick = () => {
        state.selectedPackageId = calc.upsellTargetPkg;
        state.customMinutes = null;
        renderAll();
      };
    } else {
      btnUpgrade.classList.add('hidden');
    }

    const isCrypto = calc.isCrypto;
    document.getElementById('lbl-pay-pix').classList.toggle('selected', !isCrypto);
    document.getElementById('lbl-pay-usdt').classList.toggle('selected', isCrypto);
    document.getElementById('crypto-coins-bar').classList.toggle('hidden', !isCrypto);

    document.getElementById('receipt-pkg-name').textContent = calc.title;
    document.getElementById('receipt-pkg-price').textContent = formatBRL(calc.basePrice);

    const bonusRow = document.getElementById('receipt-bonus-row');
    if (calc.bonusMinutes > 0) {
      bonusRow.classList.remove('hidden');
      bonusRow.querySelector('span:first-child').textContent = `Bônus do Combo (+${calc.bonusMinutes} min)`;
    } else {
      bonusRow.classList.add('hidden');
    }

    document.getElementById('receipt-bump-row').classList.toggle('hidden', !state.includeBump);

    const cryptoRow = document.getElementById('receipt-crypto-row');
    if (isCrypto) {
      cryptoRow.classList.remove('hidden');
      document.getElementById('receipt-crypto-discount').textContent = '- ' + formatBRL(calc.cryptoDiscount);
    } else {
      cryptoRow.classList.add('hidden');
    }

    document.getElementById('receipt-total-time').textContent = `${formatDuration(calc.totalMinutes)} (${calc.totalMinutes} min)`;
    document.getElementById('receipt-total-price').textContent = formatBRL(calc.totalBRL);

    const usdtEl = document.getElementById('receipt-total-usdt');
    if (isCrypto) {
      usdtEl.classList.remove('hidden');
      usdtEl.textContent = `≈ ${calc.totalUSDT} USDT (${state.cryptoCoin.toUpperCase()})`;
    } else {
      usdtEl.classList.add('hidden');
    }
  }

  function renderAll() {
    renderPricingCards();
    renderAuthUI();
    renderCalculatorAndCheckout();
  }

  function openAuthModal(provider, autoCheckout = false) {
    state.pendingCheckoutAfterAuth = autoCheckout;
    const modal = document.getElementById('auth-modal');
    document.getElementById('auth-provider-input').value = provider;
    document.getElementById('auth-modal-title').textContent =
      provider === 'discord' ? 'Entrar Rápido com Discord' : 'Entrar Rápido com Google';
    document.getElementById('auth-handle-label').textContent =
      provider === 'discord' ? 'Seu usuário do Discord:' : 'Seu e-mail Google:';
    const input = document.getElementById('auth-handle-input');
    input.placeholder = provider === 'discord' ? 'Ex: lucia_vice#0001' : 'Ex: voce@gmail.com';
    input.value = '';
    modal.classList.remove('hidden');
    input.focus();
  }

  async function handleCheckoutSubmit() {
    if (!state.user) {
      openAuthModal('discord', true);
      return;
    }

    const btn = document.getElementById('btn-submit-order');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Gerando seu acesso...';

    try {
      if (!state.csrfToken) {
        const cfgRes = await fetch('/api/config');
        if (cfgRes.ok) {
          const cfgData = await cfgRes.json();
          state.csrfToken = cfgData.csrfToken;
        }
      }

      const payload = {
        provider: state.user.provider,
        userHandle: state.user.handle,
        packageId: state.selectedPackageId,
        customMinutes: state.customMinutes,
        includeBump: state.includeBump,
        paymentMethod: state.paymentMethod
      };

      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': state.csrfToken || ''
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        alert(data.error || 'Erro ao gerar pedido.');
        return;
      }

      openOrderModal(data.order);
    } catch (err) {
      alert('Erro de conexão com o servidor.');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  function openOrderModal(order) {
    document.getElementById('order-modal-title').textContent = `Fatura #${order.orderId}`;
    document.getElementById('modal-pkg-name').textContent = order.packageName;
    document.getElementById('modal-total-time').textContent = `${order.totalMinutes} min`;
    document.getElementById('modal-final-price').textContent = order.isCrypto
      ? `${formatBRL(order.finalPriceBRL)} (${order.finalUSDT} USDT)`
      : formatBRL(order.finalPriceBRL);

    const payloadLabel = document.getElementById('modal-payload-label');
    const payloadInput = document.getElementById('modal-payload-input');

    if (order.isCrypto) {
      payloadLabel.textContent = `Carteira ${order.paymentMethod.toUpperCase()} (15% OFF Aplicado):`;
      payloadInput.value = order.cryptoWallet;
    } else {
      payloadLabel.textContent = 'Código PIX Copia e Cola:';
      payloadInput.value = order.pixPayload;
    }

    document.getElementById('modal-access-pin').textContent = '••••••';
    const parsecLink = document.getElementById('modal-parsec-link');
    parsecLink.classList.add('hidden');
    document.getElementById('modal-user-bound').textContent = `Conta: ${order.userHandle} (${order.userProvider.toUpperCase()})`;

    const btnSim = document.getElementById('btn-simulate-paid');
    btnSim.textContent = 'Simular Pagamento Confirmado e Assumir PS5';
    btnSim.disabled = false;
    btnSim.onclick = async () => {
      document.getElementById('modal-access-pin').textContent = order.accessPin;
      if (order.parsecInviteUrl) {
        parsecLink.href = order.parsecInviteUrl;
        parsecLink.classList.remove('hidden');
      }
      btnSim.textContent = '✓ Controle Liberado! Você está Ao Vivo no PS5!';
      btnSim.disabled = true;

      try {
        const actRes = await fetch('/api/activate-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: order.orderId })
        });
        if (actRes.ok) {
          initConfig();
        }
      } catch (e) {}
    };

    document.getElementById('order-modal').classList.remove('hidden');
  }

  document.addEventListener('DOMContentLoaded', () => {
    initConfig();

    // Atualizar status da Live Screen a cada 10s
    setInterval(initConfig, 10000);

    // Botão Tela Cheia da Transmissão do PS5
    const btnFs = document.getElementById('btn-fullscreen-stream');
    if (btnFs) {
      btnFs.addEventListener('click', () => {
        const viewport = document.getElementById('live-screen-viewport');
        if (viewport.requestFullscreen) viewport.requestFullscreen();
      });
    }

    document.getElementById('toggle-show-pix').addEventListener('click', () => {
      state.showCryptoInCards = false;
      state.paymentMethod = 'pix';
      document.querySelector('input[name="paymentMethod"][value="pix"]').checked = true;
      renderAll();
    });

    document.getElementById('toggle-show-crypto').addEventListener('click', () => {
      state.showCryptoInCards = true;
      state.paymentMethod = state.cryptoCoin;
      document.querySelector('input[name="paymentMethod"][value="usdt"]').checked = true;
      renderAll();
    });

    document.querySelectorAll('[data-select-pkg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedPackageId = btn.getAttribute('data-select-pkg');
        state.customMinutes = null;
        renderAll();
      });
    });

    document.getElementById('time-slider').addEventListener('input', (e) => {
      const mins = parseInt(e.target.value, 10);
      state.customMinutes = mins;
      if (mins === 10) state.selectedPackageId = 'trial_10m';
      else if (mins === 60) state.selectedPackageId = 'hour_1h';
      else if (mins === 120) state.selectedPackageId = 'decoy_2h';
      else if (mins === 180) state.selectedPackageId = 'combo_3h';
      else if (mins === 360) state.selectedPackageId = 'pass_6h';
      else state.selectedPackageId = null;
      renderAll();
    });

    document.getElementById('chk-order-bump').addEventListener('change', (e) => {
      state.includeBump = e.target.checked;
      renderCalculatorAndCheckout();
    });

    document.querySelectorAll('input[name="paymentMethod"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        if (e.target.value === 'pix') {
          state.paymentMethod = 'pix';
          state.showCryptoInCards = false;
        } else {
          state.paymentMethod = state.cryptoCoin;
          state.showCryptoInCards = true;
        }
        renderAll();
      });
    });

    document.querySelectorAll('.coin-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.coin-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.cryptoCoin = btn.getAttribute('data-coin');
        state.paymentMethod = state.cryptoCoin;
        renderCalculatorAndCheckout();
      });
    });

    document.getElementById('btn-login-discord').addEventListener('click', () => openAuthModal('discord', false));
    document.getElementById('btn-login-google').addEventListener('click', () => openAuthModal('google', false));
    document.getElementById('chk-btn-discord').addEventListener('click', () => openAuthModal('discord', false));
    document.getElementById('chk-btn-google').addEventListener('click', () => openAuthModal('google', false));
    document.getElementById('btn-logout').addEventListener('click', logoutUser);

    document.getElementById('btn-close-auth').addEventListener('click', () => {
      document.getElementById('auth-modal').classList.add('hidden');
      state.pendingCheckoutAfterAuth = false;
    });

    document.getElementById('auth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const provider = document.getElementById('auth-provider-input').value;
      const handle = document.getElementById('auth-handle-input').value.trim();
      if (handle) {
        saveUser(provider, handle);
        document.getElementById('auth-modal').classList.add('hidden');
        if (state.pendingCheckoutAfterAuth) {
          state.pendingCheckoutAfterAuth = false;
          handleCheckoutSubmit();
        }
      }
    });

    document.getElementById('btn-submit-order').addEventListener('click', handleCheckoutSubmit);

    document.getElementById('btn-close-order').addEventListener('click', () => {
      document.getElementById('order-modal').classList.add('hidden');
    });

    document.getElementById('btn-copy-payload').addEventListener('click', () => {
      const input = document.getElementById('modal-payload-input');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value);
      } else {
        input.select();
        document.execCommand('copy');
      }
      const btn = document.getElementById('btn-copy-payload');
      btn.textContent = 'Copiado!';
      setTimeout(() => (btn.textContent = 'Copiar'), 2000);
    });
  });
})();
