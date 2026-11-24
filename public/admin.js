/**
 * viceplay.cloud - Painel de Administração (/admin)
 * Acesso: Usuário 5288 | Senha 5288
 */

(function () {
  'use strict';

  let adminToken = sessionStorage.getItem('vicecloud_admin_token') || null;

  const loginSection = document.getElementById('admin-login-section');
  const dashboardSection = document.getElementById('admin-dashboard-section');
  const logoutBtn = document.getElementById('btn-admin-logout');
  const loginError = document.getElementById('admin-login-error');
  const toastEl = document.getElementById('admin-toast');

  function formatDurationSeconds(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s < 10 ? '0' : ''}${s}s restantes`;
  }

  async function checkAuthAndLoad() {
    if (!adminToken) {
      showLogin();
      return;
    }

    try {
      const res = await fetch('/api/admin/state', {
        headers: { 'X-Admin-Token': adminToken }
      });
      if (!res.ok) {
        sessionStorage.removeItem('vicecloud_admin_token');
        adminToken = null;
        showLogin();
        return;
      }
      const data = await res.json();
      populateDashboard(data);
      showDashboard();
    } catch (e) {
      showLogin();
    }
  }

  function showLogin() {
    loginSection.classList.remove('hidden');
    dashboardSection.classList.add('hidden');
    logoutBtn.classList.add('hidden');
  }

  function showDashboard() {
    loginSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
  }

  function populateDashboard(data) {
    const c = data.ps5Config;
    const p = data.packagesConfig;

    document.getElementById('cfg-stream-title').value = c.streamTitle || '';
    document.getElementById('cfg-stream-mode').value = c.streamMode || 'youtube';
    document.getElementById('cfg-stream-url').value = c.streamSourceUrl || '';

    document.getElementById('cfg-console-status').value = c.consoleStatus || 'online';
    document.getElementById('cfg-ps5-ip').value = c.ps5LocalIp || '';
    document.getElementById('cfg-remote-pin').value = c.remotePlayPin || '';
    document.getElementById('cfg-connection-mode').value = c.connectionMode || 'parsec_chiaki';
    document.getElementById('cfg-parsec-url').value = c.parsecInviteUrl || '';

    document.getElementById('cfg-pix-key').value = c.pixKey || '';
    document.getElementById('cfg-wallet-usdt').value = c.walletUsdt || '';
    document.getElementById('cfg-wallet-btc').value = c.walletBtc || '';
    document.getElementById('cfg-wallet-sol').value = c.walletSol || '';

    document.getElementById('cfg-price-10m').value = p.packages.trial_10m.priceBRL;
    document.getElementById('cfg-price-1h').value = p.packages.hour_1h.priceBRL;
    document.getElementById('cfg-price-2h').value = p.packages.combo_2h.priceBRL;
    document.getElementById('cfg-price-4h').value = p.packages.pass_4h.priceBRL;
    document.getElementById('cfg-price-bump').value = p.bumpPriceBRL;

    renderActivePlayerAndQueue(c.activePlayer, data.queueSummary);
    renderOrdersList(data.ordersList || []);
  }

  function renderActivePlayerAndQueue(activePlayer, queueSummary) {
    const lbl = document.getElementById('admin-active-player-label');
    if (activePlayer) {
      lbl.textContent = `${activePlayer.userHandle} (${activePlayer.provider.toUpperCase()}) • ${formatDurationSeconds(activePlayer.remainingSeconds)}`;
    } else {
      lbl.textContent = 'Nenhum (Console Livre)';
    }

    const qLbl = document.getElementById('admin-queue-count-label');
    if (qLbl && queueSummary) {
      qLbl.textContent =
        queueSummary.queueOnlyCount > 0
          ? `${queueSummary.queueOnlyCount} esperando na fila (~${queueSummary.estimatedWaitMinutesForNewPlayer}m total)`
          : '0 esperando na fila';
    }
  }

  function renderOrdersList(orders) {
    const wrap = document.getElementById('admin-orders-list');
    if (!orders.length) {
      wrap.innerHTML = '<p class="modal-desc">Nenhum pedido registrado ainda nesta sessão.</p>';
      return;
    }

    const statusMap = {
      active: '🟢 Jogando Agora',
      queued: '⏳ Na Fila',
      completed: '✓ Concluído',
      pending: 'Aguardando Pgto'
    };

    const rows = orders
      .map(
        (o) => `
      <div class="admin-order-row">
        <div><strong>#${o.orderId}</strong> • ${o.userHandle} (${o.userProvider})</div>
        <div>${o.packageName} (${o.totalMinutes} min)</div>
        <div class="text-green">R$ ${o.finalPriceBRL.toFixed(2)} (${o.paymentMethod.toUpperCase()})</div>
        <div>Status: <strong>${statusMap[o.status] || o.status}</strong></div>
      </div>
    `
      )
      .join('');

    wrap.innerHTML = rows;
  }

  async function saveAllConfig(extraAction = null) {
    const payload = {
      ps5Config: {
        streamTitle: document.getElementById('cfg-stream-title').value.trim(),
        streamMode: document.getElementById('cfg-stream-mode').value,
        streamSourceUrl: document.getElementById('cfg-stream-url').value.trim(),
        consoleStatus: document.getElementById('cfg-console-status').value,
        ps5LocalIp: document.getElementById('cfg-ps5-ip').value.trim(),
        remotePlayPin: document.getElementById('cfg-remote-pin').value.trim(),
        connectionMode: document.getElementById('cfg-connection-mode').value,
        parsecInviteUrl: document.getElementById('cfg-parsec-url').value.trim(),
        pixKey: document.getElementById('cfg-pix-key').value.trim(),
        walletUsdt: document.getElementById('cfg-wallet-usdt').value.trim(),
        walletBtc: document.getElementById('cfg-wallet-btc').value.trim(),
        walletSol: document.getElementById('cfg-wallet-sol').value.trim()
      },
      prices: {
        trial_10m: parseFloat(document.getElementById('cfg-price-10m').value),
        hour_1h: parseFloat(document.getElementById('cfg-price-1h').value),
        combo_2h: parseFloat(document.getElementById('cfg-price-2h').value),
        pass_4h: parseFloat(document.getElementById('cfg-price-4h').value),
        bumpPriceBRL: parseFloat(document.getElementById('cfg-price-bump').value)
      },
      action: extraAction
    };

    try {
      const res = await fetch('/api/admin/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': adminToken
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        renderActivePlayerAndQueue(data.ps5Config.activePlayer, data.queueSummary);
        document.getElementById('cfg-console-status').value = data.ps5Config.consoleStatus;
        toastEl.classList.remove('hidden');
        setTimeout(() => toastEl.classList.add('hidden'), 3500);
      }
    } catch (e) {
      alert('Erro ao salvar configurações.');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    checkAuthAndLoad();

    document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.classList.add('hidden');
      const username = document.getElementById('admin-user-input').value.trim();
      const password = document.getElementById('admin-pass-input').value.trim();

      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          loginError.classList.remove('hidden');
          return;
        }
        adminToken = data.adminToken;
        sessionStorage.setItem('vicecloud_admin_token', adminToken);
        checkAuthAndLoad();
      } catch (err) {
        loginError.classList.remove('hidden');
      }
    });

    logoutBtn.addEventListener('click', () => {
      sessionStorage.removeItem('vicecloud_admin_token');
      adminToken = null;
      showLogin();
    });

    document.getElementById('btn-save-all').addEventListener('click', () => saveAllConfig(null));
    document.getElementById('btn-admin-kick').addEventListener('click', () => saveAllConfig('kick_player'));
    document.getElementById('btn-admin-clear-queue').addEventListener('click', () => saveAllConfig('clear_queue'));
    document.getElementById('btn-admin-add15').addEventListener('click', () => saveAllConfig('add_15m'));
  });
})();
