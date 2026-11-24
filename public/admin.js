(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('pg6_admin_token') || null;
  let toastTimer = null;

  function toast(msg, type) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast ${type || ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3800);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtSec(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }

  async function req(url, options) {
    const headers = { ...(options?.headers || {}) };
    if (token) headers['X-Admin-Token'] = token;
    const res = await fetch(url, { ...options, headers });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  function showLogin() {
    $('admin-login').classList.remove('hidden');
    $('admin-dashboard').classList.add('hidden');
    $('btn-admin-logout').classList.add('hidden');
  }

  function showDashboard() {
    $('admin-login').classList.add('hidden');
    $('admin-dashboard').classList.remove('hidden');
    $('btn-admin-logout').classList.remove('hidden');
  }

  async function loadState() {
    if (!token) return showLogin();
    const { ok, data } = await req('/api/admin/state');
    if (!ok) {
      sessionStorage.removeItem('pg6_admin_token');
      token = null;
      return showLogin();
    }
    fill(data);
    showDashboard();
  }

  function fill(data) {
    const c = data.ps5Config;
    const p = data.packagesConfig;

    $('cfg-stream-title').value = c.streamTitle || '';
    $('cfg-stream-mode').value = c.streamMode || 'youtube';
    $('cfg-stream-url').value = c.streamSourceUrl || '';

    $('cfg-status').value = c.consoleStatus || 'online';
    $('cfg-ip').value = c.ps5LocalIp || '';
    $('cfg-pin').value = c.remotePlayPin || '';
    $('cfg-mode').value = c.connectionMode || 'parsec_chiaki';
    $('cfg-parsec').value = c.parsecInviteUrl || '';

    $('p-10m').value = p.packages.trial_10m.priceBRL;
    $('p-1h').value = p.packages.hour_1h.priceBRL;
    $('p-2h').value = p.packages.combo_2h.priceBRL;
    $('p-4h').value = p.packages.pass_4h.priceBRL;
    $('p-bump').value = p.bumpPriceBRL;

    $('cfg-mp-public').value = data.mpPublicKey || '';
    $('cfg-mp-token').value = '';
    $('cfg-mp-token').placeholder = data.mercadoPago
      ? '•••••••••• (já configurado — digite só para trocar)'
      : 'APP_USR-... ou TEST-...';

    $('cfg-np-key').value = '';
    $('cfg-np-key').placeholder = data.nowPayments
      ? '•••••••••• (já configurado — digite só para trocar)'
      : 'API Key NOWPayments';

    $('cfg-np-ipn').value = '';
    $('cfg-np-ipn').placeholder = data.nowPaymentsIpnConfigured
      ? '•••••••••• (já configurado — digite só para trocar)'
      : 'IPN Secret Key (opcional)';

    $('cfg-pix').value = c.pixKey || '';
    $('cfg-pix-name').value = c.pixName || '';
    $('cfg-pix-city').value = c.pixCity || '';
    $('cfg-usdt').value = c.walletUsdt || '';
    $('cfg-btc').value = c.walletBtc || '';
    $('cfg-sol').value = c.walletSol || '';

    // Banner de emergência
    $('emergency-banner').classList.toggle('hidden', !c.emergencyOffline);

    // Status OAuth e Pagamento
    const oauthBox = $('oauth-status');
    oauthBox.replaceChildren(
      el('span', `pill ${data.providers?.discord ? 'pill-green' : 'pill-amber'}`, `Discord OAuth: ${data.providers?.discord ? 'ativo' : 'não configurado (.env)'}`),
      el('span', `pill ${data.providers?.google ? 'pill-green' : 'pill-amber'}`, `Google OAuth: ${data.providers?.google ? 'ativo' : 'não configurado (.env)'}`),
      el('span', `pill ${data.mercadoPago ? 'pill-green' : 'pill-amber'}`, `Mercado Pago PIX: ${data.mercadoPago ? 'ativo (automático)' : 'não configurado'}`),
      el('span', `pill ${data.nowPayments ? 'pill-green' : 'pill-amber'}`, `NOWPayments Crypto: ${data.nowPayments ? 'ativo (automático)' : 'não configurado'}`),
      el('span', `pill ${data.demoMode ? 'pill-cyan' : ''}`, `Modo teste: ${data.demoMode ? 'ligado' : 'desligado'}`)
    );

    // Sessão ativa e fila
    const ap = c.activePlayer;
    $('adm-active').textContent = ap ? `${ap.name} · ${fmtSec(ap.remainingSeconds)}` : 'Nenhum (livre)';
    const q = data.queueSummary || { queueOnlyCount: 0, estimatedWaitMinutesForNewPlayer: 0 };
    $('adm-queue').textContent = q.queueOnlyCount > 0 ? `${q.queueOnlyCount} esperando (~${q.estimatedWaitMinutesForNewPlayer}m)` : '0';

    // Pedidos
    const wrap = $('orders-list');
    wrap.replaceChildren();
    const list = data.orders || [];
    if (!list.length) {
      wrap.append(el('p', 'card-sub', 'Nenhum pedido ainda.'));
      return;
    }

    const labels = {
      pending: 'Aguardando pgto',
      queued: 'Na fila',
      active: 'Jogando',
      completed: 'Concluído',
      cancelled: 'Cancelado',
      expired: 'Expirado'
    };

    list.forEach((o) => {
      const row = el('div', 'order-row');
      row.append(
        el('div', '', `#${o.orderId} · ${o.userName} (${o.userProvider})`),
        el('div', '', `${o.packageName} (${o.totalMinutes}m)`),
        el('div', 'good', `R$ ${Number(o.finalPriceBRL).toFixed(2).replace('.', ',')} · ${o.paymentMethod.toUpperCase()}`),
        el('div', '', labels[o.status] || o.status)
      );

      const actions = el('div', 'order-row-actions');
      if (o.status === 'pending') {
        const confirmBtn = el('button', 'btn btn-primary btn-sm', 'Confirmar');
        confirmBtn.type = 'button';
        confirmBtn.addEventListener('click', () => runAction('confirm_order', o.orderId));
        actions.append(confirmBtn);
      }
      if (['pending', 'queued', 'active'].includes(o.status)) {
        const cancelBtn = el('button', 'btn btn-danger btn-sm', 'Cancelar');
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', () => runAction('cancel_order', o.orderId));
        actions.append(cancelBtn);
      }
      row.append(actions);
      wrap.append(row);
    });
  }

  async function saveConfig() {
    const payload = {
      ps5Config: {
        streamTitle: $('cfg-stream-title').value.trim(),
        streamMode: $('cfg-stream-mode').value,
        streamSourceUrl: $('cfg-stream-url').value.trim(),
        consoleStatus: $('cfg-status').value,
        ps5LocalIp: $('cfg-ip').value.trim(),
        remotePlayPin: $('cfg-pin').value.trim(),
        connectionMode: $('cfg-mode').value,
        parsecInviteUrl: $('cfg-parsec').value.trim(),
        pixKey: $('cfg-pix').value.trim(),
        pixName: $('cfg-pix-name').value.trim(),
        pixCity: $('cfg-pix-city').value.trim(),
        walletUsdt: $('cfg-usdt').value.trim(),
        walletBtc: $('cfg-btc').value.trim(),
        walletSol: $('cfg-sol').value.trim()
      },
      mercadoPago: {
        publicKey: $('cfg-mp-public').value.trim(),
        accessToken: $('cfg-mp-token').value.trim()
      },
      nowPayments: {
        apiKey: $('cfg-np-key').value.trim(),
        ipnSecret: $('cfg-np-ipn').value.trim()
      },
      prices: {
        trial_10m: parseFloat($('p-10m').value),
        hour_1h: parseFloat($('p-1h').value),
        combo_2h: parseFloat($('p-2h').value),
        pass_4h: parseFloat($('p-4h').value),
        bumpPriceBRL: parseFloat($('p-bump').value)
      }
    };

    const { ok, data } = await req('/api/admin/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (ok) {
      toast('Configurações salvas!', 'success');
      loadState();
    } else {
      toast(data.error || 'Erro ao salvar.', 'error');
    }
  }

  async function runAction(action, orderId, extra) {
    const { ok, data } = await req('/api/admin/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, orderId, ...(extra || {}) })
    });
    if (ok) {
      if (data.stoppingProcess) {
        toast('Servidor encerrado em modo de emergência.', 'error');
        return;
      }
      toast(
        action === 'emergency_shutdown'
          ? 'Sistema desligado em modo de emergência!'
          : action === 'emergency_restore'
          ? 'Sistema religado e online!'
          : 'Ação executada!',
        action === 'emergency_shutdown' ? 'error' : 'success'
      );
      loadState();
    } else {
      toast(data.error || 'Erro ao executar ação.', 'error');
    }
  }

  function openEmergencyModal() {
    $('emg-step-1').classList.remove('hidden');
    $('emg-step-2').classList.add('hidden');
    $('emg-confirm-input').value = '';
    $('emg-stop-process').checked = false;
    $('btn-emg-confirm').disabled = true;
    $('emergency-modal').classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closeEmergencyModal() {
    $('emergency-modal').classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadState();

    $('admin-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('admin-error').classList.add('hidden');
      const { ok, data } = await req('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('admin-user').value.trim(), password: $('admin-pass').value.trim() })
      });
      if (!ok || !data.adminToken) {
        $('admin-error').textContent = data.error || 'Usuário ou senha incorretos.';
        $('admin-error').classList.remove('hidden');
        return;
      }
      token = data.adminToken;
      sessionStorage.setItem('pg6_admin_token', token);
      loadState();
    });

    $('btn-admin-logout').addEventListener('click', () => {
      sessionStorage.removeItem('pg6_admin_token');
      token = null;
      showLogin();
    });

    $('btn-save').addEventListener('click', saveConfig);
    document.querySelectorAll('[data-action]').forEach((b) =>
      b.addEventListener('click', () => runAction(b.dataset.action))
    );

    // Dupla confirmação do Desligamento de Emergência
    $('btn-open-emergency').addEventListener('click', openEmergencyModal);
    $('btn-emg-close').addEventListener('click', closeEmergencyModal);
    $('btn-emg-cancel-1').addEventListener('click', closeEmergencyModal);
    $('emergency-modal').addEventListener('mousedown', (e) => {
      if (e.target === $('emergency-modal')) closeEmergencyModal();
    });
    $('btn-emg-next').addEventListener('click', () => {
      $('emg-step-1').classList.add('hidden');
      $('emg-step-2').classList.remove('hidden');
      $('emg-confirm-input').focus();
    });
    $('btn-emg-back').addEventListener('click', () => {
      $('emg-step-2').classList.add('hidden');
      $('emg-step-1').classList.remove('hidden');
    });
    $('emg-confirm-input').addEventListener('input', (e) => {
      $('btn-emg-confirm').disabled = e.target.value.trim().toUpperCase() !== 'DESLIGAR';
    });
    $('btn-emg-confirm').addEventListener('click', async () => {
      if ($('emg-confirm-input').value.trim().toUpperCase() !== 'DESLIGAR') return;
      const stopProcess = $('emg-stop-process').checked;
      closeEmergencyModal();
      await runAction('emergency_shutdown', null, { stopProcess });
    });

    setInterval(() => {
      if (token && !document.hidden) loadState();
    }, 6000);
  });
})();
