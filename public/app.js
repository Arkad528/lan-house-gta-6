/**
 * viceplay.cloud - Frontend Principal + Fila em Tempo Real (FIFO) + Nova Tabela de Preços
 */

(function () {
  'use strict';

  const state = {
    csrfToken: null,
    selectedPackageId: 'combo_2h',
    customMinutes: null,
    includeBump: false,
    paymentMethod: 'pix', // 'pix' | 'usdt' | 'btc' | 'sol'
    cryptoCoin: 'usdt',
    showCryptoInCards: false,
    user: null,
    pendingCheckoutAfterAuth: false,
    bumpPriceBRL: 9.90,
    cryptoDiscountRate: 0.15,
    ps5Public: null
  };

  // Nova Tabela Oficial (Avulso R$ 22,75/h | R$ 3,80 por 10m)
  const PACKAGES_CLIENT = {
    trial_10m: {
      id: 'trial_10m',
      name: 'Teste Rápido (10 min)',
      minutes: 10,
      bonusMinutes: 0,
      priceBRL: 3.80,
      originalPriceBRL: 3.79,
      savingsBRL: 0,
      discountPct: '0,0%'
    },
    hour_1h: {
      id: 'hour_1h',
      name: 'Sessão 1 Hora (60m)',
      minutes: 60,
      bonusMinutes: 0,
      priceBRL: 22.75,
      originalPriceBRL: 22.75,
      savingsBRL: 0,
      discountPct: '0,0%'
    },
    combo_2h: {
      id: 'combo_2h',
      name: 'Combo Heist Leonida (2h10)',
      minutes: 120,
      bonusMinutes: 10,
      priceBRL: 44.90,
      originalPriceBRL: 49.29,
      savingsBRL: 4.39,
      discountPct: '8,9%'
    },
    pass_4h: {
      id: 'pass_4h',
      name: 'Passaporte Madrugada (4h25)',
      minutes: 240,
      bonusMinutes: 25,
      priceBRL: 86.90,
      originalPriceBRL: 100.48,
      savingsBRL: 13.58,
      discountPct: '13,5%'
    }
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

  function maskHandle(handle) {
    if (!handle) return 'Jogador';
    if (handle.length <= 4) return handle;
    return handle.slice(0, 4) + '***' + handle.slice(-2);
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
          renderLiveStageAndQueue(data.ps5Public);
        }
      }
    } catch (err) {}
    loadSavedUser();
    renderAll();
  }

  function renderLiveStageAndQueue(pub) {
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
    const qCountEl = document.getElementById('live-queue-count');
    const qBadgeStatus = document.getElementById('q-badge-status');
    const qHeadline = document.getElementById('q-now-headline');
    const qSub = document.getElementById('q-now-sub');
    const qWaitEstimate = document.getElementById('q-wait-estimate');
    const qWaitingList = document.getElementById('queue-waiting-list');
    const submitBtn = document.getElementById('btn-submit-order');

    const qSummary = pub.queueSummary || {
      peopleAheadCount: 0,
      queueOnlyCount: 0,
      estimatedWaitMinutesForNewPlayer: 0,
      items: []
    };

    if (qCountEl) qCountEl.textContent = String(qSummary.peopleAheadCount);

    if (pub.consoleStatus === 'maintenance') {
      if (playerStatusEl) playerStatusEl.textContent = '🔧 Console em Manutenção';
      if (qBadgeStatus) {
        qBadgeStatus.textContent = '🔧 MANUTENÇÃO';
        qBadgeStatus.className = 'q-badge-status q-badge-busy';
      }
      if (qHeadline) qHeadline.textContent = 'Console em manutenção rápida.';
      if (qWaitEstimate) qWaitEstimate.textContent = 'Pausado';
      if (qWaitingList) qWaitingList.classList.add('hidden');
    } else if (pub.activePlayer) {
      const minsLeftActive = Math.max(1, Math.ceil(pub.activePlayer.remainingSeconds / 60));
      if (playerStatusEl) {
        playerStatusEl.textContent = `🎮 No controle: ${maskHandle(pub.activePlayer.userHandle)} (${minsLeftActive}m restantes)`;
      }
      if (qBadgeStatus) {
        qBadgeStatus.textContent = `⏳ ${qSummary.peopleAheadCount} NA FRENTE`;
        qBadgeStatus.className = 'q-badge-status q-badge-busy';
      }
      if (qHeadline) {
        qHeadline.textContent =
          qSummary.queueOnlyCount > 0
            ? `1 jogando agora + ${qSummary.queueOnlyCount} na fila de espera. Garanta o próximo lugar!`
            : `1 jogador em sessão agora (termina em ~${minsLeftActive} min). Reserve para ser o próximo!`;
      }
      if (qSub) {
        qSub.textContent = 'Ordem 100% justa de chegada: seu tempo comprado só começa a contar quando o PS5 passar para você.';
      }
      if (qWaitEstimate) {
        qWaitEstimate.textContent = `~${qSummary.estimatedWaitMinutesForNewPlayer} min`;
      }
      if (submitBtn) {
        submitBtn.textContent = `Garantir Minha Vaga na Fila (#${qSummary.peopleAheadCount + 1})`;
      }

      // Renderizar os chips de quem está jogando + quem está na fila esperando
      if (qWaitingList) {
        qWaitingList.classList.remove('hidden');
        const activeChip = `
          <div class="queue-person-chip active-now-chip">
            <span class="qp-pos">🎮 JOGANDO AGORA</span>
            <strong class="qp-name">${maskHandle(pub.activePlayer.userHandle)}</strong>
            <span class="qp-time">Libera em ~${minsLeftActive} min</span>
          </div>
        `;
        const waitingChips = (qSummary.items || [])
          .map(
            (item) => `
          <div class="queue-person-chip">
            <span class="qp-pos">#${item.position} DA FILA</span>
            <strong class="qp-name">${maskHandle(item.userHandle)}</strong>
            <span class="qp-time">Sessão de ${item.totalMinutes}m (Entra em ~${item.estimatedWaitMinutes}m)</span>
          </div>
        `
          )
          .join('');
        qWaitingList.innerHTML = activeChip + waitingChips;
      }
    } else {
      if (playerStatusEl) playerStatusEl.textContent = '🟢 Console Livre p/ Assumir Agora';
      if (qBadgeStatus) {
        qBadgeStatus.textContent = '🟢 FILA ZERO • ENTRADA IMEDIATA';
        qBadgeStatus.className = 'q-badge-status q-badge-free';
      }
      if (qHeadline) qHeadline.textContent = 'Ninguém na frente! Pagou, assumiu o controle do PS5 na hora.';
      if (qSub) qSub.textContent = 'Seu cronômetro só começa a rodar no momento em que o seu acesso é liberado.';
      if (qWaitEstimate) qWaitEstimate.textContent = '0 min (Imediato)';
      if (qWaitingList) qWaitingList.classList.add('hidden');
      if (submitBtn) submitBtn.textContent = 'Gerar PIX / Crypto e Assumir o Controle Agora';
    }

    ['trial_10m', 'hour_1h', 'combo_2h', 'pass_4h'].forEach((id) => {
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
      const raw = sessionStorage.getItem('viceplay_user');
      if (raw) state.user = JSON.parse(raw);
    } catch (e) {}
  }

  function saveUser(provider, handle) {
    state.user = { provider, handle };
    try {
      sessionStorage.setItem('viceplay_user', JSON.stringify(state.user));
    } catch (e) {}
    renderAuthUI();
  }

  function logoutUser() {
    state.user = null;
    try {
      sessionStorage.removeItem('viceplay_user');
    } catch (e) {}
    renderAuthUI();
  }

  function computeCurrentSelection() {
    const p10 = PACKAGES_CLIENT.trial_10m.priceBRL;   // 3.80
    const p60 = PACKAGES_CLIENT.hour_1h.priceBRL;     // 22.75
    const p120 = PACKAGES_CLIENT.combo_2h.priceBRL;   // 44.90 (+10m grátis = 130m)
    const p240 = PACKAGES_CLIENT.pass_4h.priceBRL;    // 86.90 (+25m grátis = 265m)

    let baseMinutes = 120;
    let basePrice = p120;
    let bonusMinutes = 10;
    let title = PACKAGES_CLIENT.combo_2h.name;

    if (state.selectedPackageId && PACKAGES_CLIENT[state.selectedPackageId]) {
      const pkg = PACKAGES_CLIENT[state.selectedPackageId];
      baseMinutes = pkg.minutes;
      basePrice = pkg.priceBRL;
      bonusMinutes = pkg.bonusMinutes;
      title = pkg.name;
    } else if (state.customMinutes) {
      const m = state.customMinutes;
      baseMinutes = m;

      if (m === 10) {
        basePrice = p10;
        bonusMinutes = 0;
      } else if (m <= 60) {
        basePrice = p10 + ((m - 10) / 50) * (p60 - p10);
        bonusMinutes = 0;
      } else if (m < 120) {
        basePrice = p60 + ((m - 60) / 60) * (p120 - p60);
        bonusMinutes = 0;
      } else if (m === 120) {
        basePrice = p120;
        bonusMinutes = 10;
      } else if (m < 240) {
        basePrice = p120 + ((m - 120) / 120) * (p240 - p120);
        bonusMinutes = 10;
      } else {
        basePrice = p240;
        bonusMinutes = 25;
      }
      basePrice = Math.round(basePrice * 100) / 100;
      title = `Sessão Personalizada (${m} min)`;
    }

    // Gatilhos Mentais Fortes para Comprar Pacotes Maiores
    let upsellMessage = '';
    let upsellTargetPkg = null;

    if (baseMinutes < 60) {
      upsellMessage = `⚠️ <strong>10 min passam voando nas cutscenes!</strong> Suba para o <strong>Combo Heist 2h10</strong> para derrubar sua hora de R$ 22,80/h para <strong>R$ 20,72/h + 10 min grátis (R$ 4,39 de economia)</strong>!`;
      upsellTargetPkg = 'combo_2h';
    } else if (baseMinutes >= 60 && baseMinutes < 120) {
      upsellMessage = `🍟 <strong>Efeito Combo:</strong> Em 1 hora você paga o preço cheio (R$ 22,75/h e 0% de desconto). No <strong>Combo 2h10</strong> você ganha <strong>+10 min grátis</strong>, derruba a hora para <strong>R$ 20,72/h</strong> e economiza <strong>R$ 4,39</strong>!`;
      upsellTargetPkg = 'combo_2h';
    } else if (baseMinutes >= 120 && baseMinutes < 240) {
      upsellMessage = `🔥 <strong>Combo Heist 2h10 Ativo (R$ 4,39 de economia + 10m grátis)!</strong> Quer o maior desconto do site? No <strong>Passaporte 4h25</strong> a hora cai para <strong>R$ 19,68/h</strong> e você economiza <strong>R$ 13,58 (+25m grátis)</strong>!`;
      upsellTargetPkg = 'pass_4h';
    } else {
      upsellMessage = `👑 <strong>Passaporte Madrugada 4h25 Ativo!</strong> Você destravou <strong>13,5% OFF (R$ 13,58 de economia real)</strong> + <strong>25 minutos grátis</strong> (menor valor por hora: R$ 19,68/h).`;
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
    const effectiveRateHour = effectiveRate10m * 6;

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
      effectiveRateHour,
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
            hour_1h: 'Escolher 1 Hora',
            combo_2h: 'Quero o Combo 2h10',
            pass_4h: 'Escolher 4h25'
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

    document.getElementById('slider-rate-10m').textContent = `${formatBRL(calc.effectiveRate10m)} / 10m (${formatBRL(calc.effectiveRateHour)}/h)`;
    document.getElementById('smart-upsell-text').innerHTML = calc.upsellMessage;

    const btnUpgrade = document.getElementById('btn-upsell-upgrade');
    if (calc.upsellTargetPkg) {
      btnUpgrade.classList.remove('hidden');
      btnUpgrade.textContent = calc.upsellTargetPkg === 'combo_2h' ? 'Pegar Combo 2h10' : 'Pegar Passaporte 4h25';
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
      bonusRow.querySelector('span:first-child').textContent = `Bônus do Pacote (+${calc.bonusMinutes} min)`;
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
    const queueFeedback = document.getElementById('modal-queue-feedback');
    parsecLink.classList.add('hidden');
    queueFeedback.classList.add('hidden');
    document.getElementById('modal-user-bound').textContent = `Conta: ${order.userHandle} (${order.userProvider.toUpperCase()})`;

    const btnSim = document.getElementById('btn-simulate-paid');
    btnSim.textContent = 'Simular Pagamento Confirmado';
    btnSim.disabled = false;
    btnSim.onclick = async () => {
      btnSim.disabled = true;
      btnSim.textContent = 'Confirmando vaga no PS5...';

      try {
        const actRes = await fetch('/api/activate-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: order.orderId })
        });

        if (actRes.ok) {
          const actData = await actRes.json();
          if (actData.mode === 'active') {
            document.getElementById('modal-access-pin').textContent = order.accessPin;
            if (order.parsecInviteUrl) {
              parsecLink.href = order.parsecInviteUrl;
              parsecLink.classList.remove('hidden');
            }
            btnSim.textContent = '✓ Controle Liberado! Você está Ao Vivo no PS5!';
          } else if (actData.queueEntry) {
            document.getElementById('modal-access-pin').textContent = `FILA #${actData.queueEntry.position}`;
            queueFeedback.classList.remove('hidden');
            queueFeedback.innerHTML = `⏳ Há <strong>${actData.queueEntry.position} pessoa(s)</strong> concluindo a sessão na sua frente.<br>Previsão para liberar seu PIN Automaticamente: <strong>~${actData.queueEntry.estimatedWaitMinutes} min</strong>.`;
            btnSim.textContent = `✓ Vaga #${actData.queueEntry.position} Garantida na Fila!`;
          }
          initConfig();
        }
      } catch (e) {
        document.getElementById('modal-access-pin').textContent = order.accessPin;
        btnSim.textContent = '✓ Pagamento Confirmado!';
      }
    };

    document.getElementById('order-modal').classList.remove('hidden');
  }

  document.addEventListener('DOMContentLoaded', () => {
    initConfig();

    setInterval(initConfig, 6000);

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
      else if (mins === 120) state.selectedPackageId = 'combo_2h';
      else if (mins === 240) state.selectedPackageId = 'pass_4h';
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
