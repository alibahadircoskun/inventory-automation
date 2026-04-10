const App = {
  devices: [],
  ddState: {},
  currentUser: null,
  currentSession: null,
  currentSessionId: null,
  currentSessionTitle: '',
  currentView: 'sessions',
  editorIssues: [],
  snipeStatus: null,

  async init() {
    App.setPinChangeModalOpen(false);

    const authenticated = await App.syncCurrentUser();
    if (!authenticated) {
      return;
    }

    if (App.requiresPinChange()) {
      App.requirePinChange();
      return;
    }

    await App.showSessionList();
  },

  isManager() {
    return App.currentUser?.role === 'manager';
  },

  requiresPinChange(user = App.currentUser) {
    return !!(user && (user.must_change_pin || user.mustChangePin));
  },

  async syncCurrentUser() {
    try {
      const user = await API.get('/api/me');
      if (!user) {
        window.location.href = '/';
        return false;
      }

      user.must_change_pin = !!(user.must_change_pin || user.mustChangePin);
      user.mustChangePin = user.must_change_pin;
      App.currentUser = user;
      App.renderHeaderUser();

      if (App.requiresPinChange(user)) {
        App.requirePinChange();
      } else {
        App.setPinChangeModalOpen(false);
      }

      return true;
    } catch (_) {
      App.setPinChangeModalOpen(false);
      window.location.href = '/';
      return false;
    }
  },

  canEditCurrentSession() {
    return !!App.currentSession && App.currentSession.status === 'draft' && !App.requiresPinChange();
  },

  renderHeaderUser() {
    const userEl = document.getElementById('headerUser');
    if (!userEl || !App.currentUser) return;

    const initials = App.currentUser.display_name.slice(0, 2).toUpperCase();
    userEl.innerHTML = `
      <div class="header-user-avatar"><span>${initials}</span></div>
      <div class="header-user-copy">
        <span class="header-user-name">${App.currentUser.display_name}</span>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="App.logout()" title="Çıkış" style="padding:3px 10px;font-size:10px;color:var(--danger)">
        <span class="material-symbols-outlined sm">logout</span><span class="btn-label"> Çıkış</span>
      </button>
    `;
  },

  setHeaderMode(mode) {
    const editorActions = document.getElementById('headerEditorActions');
    const sessionsNav = document.getElementById('headerSessionsNav');
    const approvalNav = document.getElementById('headerApprovalNav');
    const saveIndicator = document.getElementById('saveIndicator');

    if (editorActions) {
      editorActions.hidden = mode !== 'editor';
    }
    if (sessionsNav) {
      sessionsNav.hidden = mode === 'editor';
      sessionsNav.classList.toggle('is-active', mode === 'sessions');
    }
    if (approvalNav) {
      approvalNav.hidden = !App.isManager();
      approvalNav.classList.toggle('is-active', mode === 'approval');
    }
    if (mode !== 'editor' && saveIndicator) {
      saveIndicator.textContent = '';
      saveIndicator.className = 'save-indicator';
    }
  },

  _switchView(showId) {
    ['sessionsView', 'editorView', 'approvalView'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === showId) {
        el.style.display = id === 'editorView' ? 'grid' : (id === 'approvalView' ? 'grid' : 'flex');
        el.classList.remove('view-fade');
        void el.offsetWidth;
        el.classList.add('view-fade');
      } else {
        el.style.display = 'none';
        el.classList.remove('view-fade');
      }
    });
  },

  async showSessionList() {
    App.setHeaderMode('sessions');
    App.currentView = 'sessions';
    App.editorIssues = [];
    App._switchView('sessionsView');
    Sync.stopPolling();
    const sessions = await API.get('/api/sessions');
    const list = document.getElementById('sessionList');
    if (!sessions || sessions.length === 0) {
      list.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">inventory_2</span><div class="empty-state-title">Henüz talep yok</div><div class="empty-state-desc">Yeni bir taslak oluşturun</div><button class="btn btn-accent2 btn-sm" onclick="App.createSession()" style="margin-top:8px"><span class="material-symbols-outlined sm">add</span> Yeni Taslak</button></div>';
      return;
    }

    list.innerHTML = sessions.map((session) => {
      const date = new Date(`${session.updated_at}Z`).toLocaleString('tr-TR');
      const title = session.title || session.description?.slice(0, 40) || 'Isimsiz Talep';
      const syncBadge = session.snipeit_sync_status
        ? `<span class="session-status sync ${session.snipeit_sync_status}">${App.getSyncStatusLabel(session.snipeit_sync_status)}</span>`
        : '';
      const sourceMeta = session.sourceSession
        ? `<div class="session-card-meta">Kaynak: ${session.sourceSession.title || 'Isimsiz Talep'} · ${App.getStatusLabel(session.sourceSession.status)}</div>`
        : '';
      const reopenButton = session.status === 'rejected'
        ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();App.reopenFromList('${session.id}')" title="Taslağı Yeniden Aç">
            <span class="material-symbols-outlined md">restart_alt</span>
          </button>`
        : '';
      const approvedActions = session.status === 'approved'
        ? `
            <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();App.editApprovedAsNew('${session.id}')" title="Yeni Talep Olarak Düzenle">
              <span class="material-symbols-outlined lg">content_copy</span>
            </button>
            <button class="btn btn-danger btn-xs" onclick="event.stopPropagation();App.archiveApprovedSession('${session.id}')" title="Listeden Kaldır">
              <span class="material-symbols-outlined lg">delete</span>
            </button>
          `
        : '';
      return `
        <div class="session-card" onclick="App.openSession('${session.id}')">
          <div class="session-card-info">
            <div class="session-card-title">${title}</div>
            <div class="session-card-meta">
              <span class="material-symbols-outlined sm" style="vertical-align:middle;margin-right:4px">calendar_today</span>${date}
            </div>
            ${sourceMeta}
          </div>
          <div class="session-card-actions">
            <span class="session-status ${session.status}">${App.getStatusLabel(session.status)}</span>
            ${syncBadge}
            ${reopenButton}
            ${approvedActions}
            ${session.status === 'draft' ? `
              <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();App.renameSession('${session.id}')" title="Adı Değiştir">
                <span class="material-symbols-outlined lg">edit</span>
              </button>
              <button class="btn btn-danger btn-xs" onclick="event.stopPropagation();App.deleteSession('${session.id}')" title="Sil">
                <span class="material-symbols-outlined lg">delete</span>
              </button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  },

  getStatusLabel(status) {
    return ({
      draft: 'Taslak',
      pending: 'Bekliyor',
      approved: 'Onaylandı',
      rejected: 'Reddedildi'
    })[status] || status;
  },

  getSyncStatusLabel(status) {
    return ({
      running: 'Senkron...',
      success: 'Eşitleme Başarılı',
      partial: 'Kısmi Hata',
      failed: 'Eşitleme Hatası'
    })[status] || status;
  },

  async createSession() {
    const session = await API.post('/api/sessions', { title: '' });
    if (session) App.openSession(session.id);
  },

  async openSession(sessionId) {
    App.currentSessionId = sessionId;
    const session = await API.get(`/api/sessions/${sessionId}`);
    if (!session) return;

    App.loadSessionData(session, false);
    App.setHeaderMode('editor');
    App.currentView = 'editor';
    App._switchView('editorView');

    Sync.lastUpdatedAt = session.updated_at;
    Sync.startPolling(sessionId);
  },

  mapUnit(unit) {
    return {
      id: unit.id || null,
      name: unit.name || '',
      serial: unit.serial || '',
      health: unit.health ?? '',
      snipeitComponentId: unit.snipeitComponentId ?? unit.snipeit_component_id ?? null,
      snipeitComponentSnapshot: unit.snipeitComponentSnapshot || unit.snipeit_component_snapshot || null,
      snipeitMatchStatus: unit.snipeitMatchStatus || unit.snipeit_match_status || 'unresolved',
      proposedNewComponentCategory: unit.proposedNewComponentCategory || unit.proposed_new_component_category || '',
      proposedNewComponentLocation: unit.proposedNewComponentLocation || unit.proposed_new_component_location || ''
    };
  },

  mapComponent(component) {
    return {
      id: component.id || null,
      type: component.type || 'CPU',
      qty: component.qty || 1,
      name: component.name || '',
      serial: component.serial || '',
      health: component.health ?? '',
      snipeitComponentId: component.snipeitComponentId ?? component.snipeit_component_id ?? null,
      snipeitComponentSnapshot: component.snipeitComponentSnapshot || component.snipeit_component_snapshot || null,
      snipeitMatchStatus: component.snipeitMatchStatus || component.snipeit_match_status || 'unresolved',
      proposedNewComponentCategory: component.proposedNewComponentCategory || component.proposed_new_component_category || '',
      proposedNewComponentLocation: component.proposedNewComponentLocation || component.proposed_new_component_location || '',
      units: (component.units || []).map(App.mapUnit)
    };
  },

  mapDevice(device) {
    return {
      id: device.id || null,
      model: device.model || '',
      etiket: device.etiket || '',
      seri: device.seri || '',
      not: device.not || device.not_text || '',
      componentsOnly: !!device.componentsOnly || !!device.components_only,
      assetResolutionMode: device.assetResolutionMode || device.asset_resolution_mode || 'unresolved',
      snipeitAssetId: device.snipeitAssetId ?? device.snipeit_asset_id ?? null,
      snipeitAssetSnapshot: device.snipeitAssetSnapshot || device.snipeit_asset_snapshot || null,
      snipeitValidatedAt: device.snipeitValidatedAt || device.snipeit_validated_at || null,
      currentStateSnapshot: device.currentStateSnapshot || device.current_state_snapshot || null,
      currentStateFetchedAt: device.currentStateFetchedAt || device.current_state_fetched_at || null,
      proposedNewAssetStatus: device.proposedNewAssetStatus || device.proposed_new_asset_status || '',
      proposedNewAssetLocation: device.proposedNewAssetLocation || device.proposed_new_asset_location || '',
      takilanComponents: (device.takilanComponents || []).map(App.mapComponent),
      components: (device.components || []).map(App.mapComponent)
    };
  },

  loadSessionData(session, isSync) {
    App.currentSession = session;
    App.currentSessionId = session.id;
    App.currentSessionTitle = session.title || '';
    App.devices = (session.devices || []).map(App.mapDevice);
    if (App.devices.length === 0) {
      App.devices = [Devices.makeDevice()];
    }

    App.ddState = {};
    App.devices.forEach((_, index) => {
      App.ddState[index] = { model: { selected: -1 }, etiket: { selected: -1 }, seri: { selected: -1 } };
    });

    const descEl = document.getElementById('f_description');
    if (descEl) descEl.value = session.description || '';
    App.renderSessionMeta();
    Devices.renderDeviceList();
    App.render();

    if (isSync) {
      App.showToast('Talep güncellendi');
    }
  },

  renderSessionMeta() {
    const metaEl = document.getElementById('editorMeta');
    if (!metaEl || !App.currentSession) return;

    const session = App.currentSession;
    const owner = session.owner?.display_name ? `Talep sahibi: ${session.owner.display_name}` : '';
    const sourceNote = session.sourceSession
      ? `<div class="session-source-note">Kaynak talep: ${session.sourceSession.title || 'Isimsiz Talep'} · ${App.getStatusLabel(session.sourceSession.status)}</div>`
      : '';
    const review = session.review_comment ? `<div class="session-note">${session.review_comment}</div>` : '';
    const syncSummary = session.snipeit_sync_summary?.counts
      ? `<div class="session-sync-summary">
          <span>Başarılı: ${session.snipeit_sync_summary.counts.success || 0}</span>
          <span>Hatalı: ${session.snipeit_sync_summary.counts.failed || 0}</span>
          <span>Atlanan: ${session.snipeit_sync_summary.counts.skipped || 0}</span>
        </div>`
      : '';
    const timeline = (session.events || []).map((event) => `
      <div class="timeline-item">
        <div class="timeline-label">${event.eventType}</div>
        <div class="timeline-meta">${event.actor?.display_name || 'Sistem'} · ${new Date(`${event.createdAt}Z`).toLocaleString('tr-TR')}</div>
      </div>
    `).join('');

    metaEl.innerHTML = `
      <div class="session-meta-card">
        <div class="session-meta-top">
          <div>
            <div class="session-meta-title">${session.title || 'Isimsiz Talep'}</div>
            <div class="session-meta-sub">${owner}</div>
          </div>
          <div class="session-meta-badges">
            <span class="session-status ${session.status}">${App.getStatusLabel(session.status)}</span>
            ${session.snipeit_sync_status ? `<span class="session-status sync ${session.snipeit_sync_status}">${App.getSyncStatusLabel(session.snipeit_sync_status)}</span>` : ''}
          </div>
        </div>
        ${sourceNote}
        ${review}
        ${syncSummary}
        <div class="timeline-list">${timeline || '<div class="timeline-empty">Henüz olay yok.</div>'}</div>
      </div>
    `;

    const submitBtn = document.getElementById('submitSessionBtn');
    const editAsNewBtn = document.getElementById('editAsNewSessionBtn');
    const archiveApprovedBtn = document.getElementById('archiveApprovedSessionBtn');
    const reopenBtn = document.getElementById('reopenSessionBtn');
    const resetBtn = document.getElementById('resetSessionBtn');
    const renameBtn = document.getElementById('renameSessionBtn');
    const addDeviceBtn = document.getElementById('addDeviceBtn');

    if (submitBtn) submitBtn.hidden = session.status !== 'draft';
    if (editAsNewBtn) editAsNewBtn.hidden = session.status !== 'approved';
    if (archiveApprovedBtn) archiveApprovedBtn.hidden = session.status !== 'approved';
    if (reopenBtn) reopenBtn.hidden = session.status !== 'rejected';
    if (resetBtn) resetBtn.disabled = !App.canEditCurrentSession();
    if (renameBtn) renameBtn.disabled = !App.canEditCurrentSession();
    if (addDeviceBtn) addDeviceBtn.disabled = !App.canEditCurrentSession();

    const banner = document.getElementById('editorStatusBanner');
    if (banner) {
      const lockIcon = session.status !== 'draft' ? ' <span class="readonly-badge"><span class="material-symbols-outlined sm">lock</span> Salt Okunur</span>' : '';
      banner.className = `editor-status-banner ${session.status}`;
      banner.innerHTML = (session.status === 'draft'
        ? 'Taslak modunda düzenleniyor.'
        : session.status === 'pending'
          ? 'Talep onay bekliyor. Düzenleme kilitli.'
          : session.status === 'approved'
            ? 'Talep onaylandı. Kayıtlar sadece okunabilir. Değişiklik için yeni talep olarak düzenleyin.'
            : 'Talep reddedildi. Düzenlemek için yeniden açın.') + lockIcon;
    }
  },

  renderIssues() {
    const alertEl = document.getElementById('editorAlerts');
    if (!alertEl) return;
    if (!App.editorIssues.length) {
      alertEl.innerHTML = '';
      alertEl.hidden = true;
      return;
    }

    alertEl.hidden = false;
    alertEl.innerHTML = `
      <div class="issue-card">
        <div class="issue-title">Doğrulama Sorunları</div>
        <ul>${App.editorIssues.map((issue) => `<li>${issue}</li>`).join('')}</ul>
      </div>
    `;
  },

  getFormData() {
    return {
      description: document.getElementById('f_description')?.value || '',
      devices: App.devices
    };
  },

  render() {
    const preview = document.getElementById('emailPreview');
    if (preview) {
      preview.innerHTML = Email.buildHTML(App.getFormData());
    }
    const currentStatePreview = document.getElementById('currentStatePreview');
    if (currentStatePreview) {
      currentStatePreview.innerHTML = CurrentState.buildPreviewHTML(App.devices, { allowRefresh: false });
    }
    App.renderSessionMeta();
    App.renderIssues();
  },

  onDescriptionChange() {
    App.render();
    App.scheduleAutoSave();
  },

  scheduleAutoSave() {
    if (!App.canEditCurrentSession()) return;
    Sync.scheduleAutoSave();
  },

  async deleteSession(sessionId) {
    const ok = await App.confirm('Bu taslagi silmek istediginizden emin misiniz?', { title: 'Silme Onayı', confirmText: 'Sil', danger: true });
    if (!ok) return;
    const result = await API.del(`/api/sessions/${sessionId}`);
    App.showToast(result?.archived ? 'Talep listenizden kaldırıldı' : 'Taslak silindi');
    await App.showSessionList();
  },

  async archiveApprovedSession(sessionId = App.currentSessionId) {
    if (!sessionId) return;
    const ok = await App.confirm('Bu onaylı talep envanter kayıtlarını etkilemeden sadece listenizden kaldırılacak. Devam edilsin mi?', { title: 'Kaldır', confirmText: 'Kaldır', danger: true });
    if (!ok) return;

    try {
      await API.del(`/api/sessions/${sessionId}`);
      Sync.stopPolling();
      App.currentSession = null;
      App.currentSessionId = null;
      App.currentSessionTitle = '';
      await App.showSessionList();
      App.showToast('Onaylı talep listenizden kaldırıldı');
    } catch (error) {
      App.showToast(error?.data?.error || error.message || 'Talep kaldırılamadı', 'error');
    }
  },

  async editApprovedAsNew(sessionId = App.currentSessionId) {
    if (!sessionId) return;

    try {
      const session = await API.post(`/api/sessions/${sessionId}/edit-as-new`, {});
      if (!session) return;

      Sync.stopPolling();
      App.editorIssues = [];
      App.loadSessionData(session, false);
      App.setHeaderMode('editor');
      App.currentView = 'editor';
      App._switchView('editorView');
      Sync.lastUpdatedAt = session.updated_at;
      Sync.startPolling(session.id);
      App.showToast('Onaylı talepten yeni taslak oluşturuldu');
    } catch (error) {
      App.showToast(error?.data?.error || error.message || 'Yeni taslak oluşturulamadi', 'error');
    }
  },

  backToSessions() {
    Sync.stopPolling();
    App.currentSession = null;
    App.currentSessionId = null;
    App.currentSessionTitle = '';
    App.showSessionList();
  },

  async renameSession(sessionId) {
    const session = await API.get(`/api/sessions/${sessionId}`);
    const existingTitle = String(session?.title || '');
    const nextTitle = await App.prompt('Taslak adını girin:', { title: 'Yeniden Adlandır', defaultValue: existingTitle });
    if (nextTitle === null) return;

    await API.put(`/api/sessions/${sessionId}`, { title: nextTitle.trim() });
    App.showToast('Talep adı güncellendi');
    if (App.currentSessionId === sessionId) {
      App.currentSessionTitle = nextTitle.trim();
      App.currentSession = await API.get(`/api/sessions/${sessionId}`);
      App.renderSessionMeta();
    }
    await App.showSessionList();
  },

  async renameCurrentSession() {
    if (!App.currentSessionId || !App.canEditCurrentSession()) return;

    const nextTitle = await App.prompt('Taslak adını girin:', { title: 'Yeniden Adlandır', defaultValue: App.currentSessionTitle || '' });
    if (nextTitle === null) return;

    const title = nextTitle.trim();
    await API.put(`/api/sessions/${App.currentSessionId}`, { title });
    App.currentSessionTitle = title;
    if (App.currentSession) App.currentSession.title = title;
    App.renderSessionMeta();
    App.showToast('Talep adı güncellendi');
  },

  resetForm() {
    if (!App.canEditCurrentSession()) return;

    document.getElementById('f_description').value = '';
    App.devices = [Devices.makeDevice()];
    App.ddState = { 0: { model: { selected: -1 }, etiket: { selected: -1 }, seri: { selected: -1 } } };
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  async submitCurrentSession() {
    if (!App.currentSessionId || !App.canEditCurrentSession()) return;
    try {
      const session = await API.post(`/api/sessions/${App.currentSessionId}/submit`, {});
      App.editorIssues = [];
      App.loadSessionData(session, false);
      App.showToast('Talep onaya gönderildi');
    } catch (error) {
      if (error.status === 422) {
        App.editorIssues = error.data?.issues || [error.message];
        App.renderIssues();
      } else {
        App.showToast(error.message || 'Onaya gönderme başarısız', 'error');
      }
    }
  },

  async reopenCurrentSession() {
    if (!App.currentSessionId || App.currentSession?.status !== 'rejected') return;
    const session = await API.post(`/api/sessions/${App.currentSessionId}/reopen`, {});
    App.loadSessionData(session, false);
    App.showToast('Talep tekrar taslak olarak açıldı');
  },

  async reopenFromList(sessionId) {
    const session = await API.post(`/api/sessions/${sessionId}/reopen`, {});
    if (App.currentSessionId === sessionId) {
      App.loadSessionData(session, false);
    } else {
      await App.showSessionList();
    }
    App.showToast('Talep tekrar taslak olarak açıldı');
  },

  async showApprovalView() {
    if (!App.isManager()) return;
    App.setHeaderMode('approval');
    App.currentView = 'approval';
    App._switchView('approvalView');
    Sync.stopPolling();
    await Approval.init();
  },

  setPinChangeModalOpen(open) {
    const modal = document.getElementById('pinChangeModal');
    if (!modal) return;
    modal.hidden = !open;
    modal.style.display = open ? 'flex' : 'none';
  },

  requirePinChange() {
    if (App.currentUser) {
      App.currentUser.must_change_pin = true;
      App.currentUser.mustChangePin = true;
    }
    const currentPin = document.getElementById('currentPin');
    const newPin = document.getElementById('newPin');
    const errorEl = document.getElementById('pinChangeError');
    if (currentPin) currentPin.value = '';
    if (newPin) newPin.value = '';
    if (errorEl) errorEl.textContent = '';
    App.setPinChangeModalOpen(true);
  },

  async submitPinChange() {
    const currentPin = document.getElementById('currentPin')?.value || '';
    const newPin = document.getElementById('newPin')?.value || '';
    const errorEl = document.getElementById('pinChangeError');
    try {
      const result = await API.post('/api/change-pin', { currentPin, newPin });
      const refreshedUser = await API.get('/api/me').catch(() => result?.user || null);
      App.currentUser = refreshedUser || result.user || App.currentUser;
      if (App.currentUser) {
        App.currentUser.must_change_pin = App.requiresPinChange(App.currentUser);
        App.currentUser.mustChangePin = App.currentUser.must_change_pin;
      }
      if (App.requiresPinChange()) {
        throw new Error('PIN değişikliği kaydedildi ama oturum henüz yenilenmedi. Lütfen sayfayı yenileyin.');
      }
      App.setPinChangeModalOpen(false);
      App.renderHeaderUser();
      App.showToast('PIN güncellendi');
      await App.showSessionList();
    } catch (error) {
      if (errorEl) errorEl.textContent = error.message || 'PIN güncellenemedi';
    }
  },

  async updateSnipeStatus(status) {
    App.snipeStatus = status;
    const banner = document.getElementById('snipeBanner');
    if (!banner) return;
    if (!status) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }

    banner.hidden = false;
    banner.className = `snipe-banner ${status.healthy ? 'healthy' : 'fallback'}`;
    banner.textContent = status.healthy
      ? 'Canlı envanter bağlantısı aktif.'
      : status.configured === false
        ? 'Envanter ayarlanmamış. Yerel arama kullanılabilir ancak submit/onay akışı çalışmaz.'
        : 'Canlı envanter bağlantısı kullanılamıyor. Arama yerel kopyaya düşebilir, ancak submit/onay için canlı doğrulama gerekir.';
  },

  _toastTimer: null,

  showToast(msg, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    if (App._toastTimer) clearTimeout(App._toastTimer);
    toast.textContent = msg;
    toast.className = 'toast show';
    if (type === 'error') toast.classList.add('toast--error');
    else if (type === 'warn') toast.classList.add('toast--warn');
    else if (type === 'info') toast.classList.add('toast--info');
    App._toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      App._toastTimer = null;
    }, 2800);
  },

  setLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('is-loading', loading);
    btn.disabled = loading;
  },

  confirm(message, opts = {}) {
    const title = opts.title || 'Onay';
    const confirmText = opts.confirmText || 'Tamam';
    const cancelText = opts.cancelText || 'İptal';
    const danger = opts.danger || false;
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      let onKeydown;
      backdrop.className = 'modal-backdrop confirm-backdrop';
      backdrop.innerHTML = `
        <div class="modal-card confirm-card">
          <h2>${title}</h2>
          <p>${message}</p>
          <div class="confirm-actions">
            <button class="btn btn-ghost" type="button" data-result="cancel">${cancelText}</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-accent2'}" type="button" data-result="confirm">${confirmText}</button>
          </div>
        </div>
      `;
      const close = (result) => {
        backdrop.remove();
        if (onKeydown) document.removeEventListener('keydown', onKeydown);
        resolve(result);
      };
      backdrop.querySelector('[data-result="confirm"]').onclick = () => close(true);
      backdrop.querySelector('[data-result="cancel"]').onclick = () => close(false);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
      onKeydown = (e) => {
        if (e.key === 'Escape') {
          close(false);
        }
      };
      document.addEventListener('keydown', onKeydown);
      document.body.appendChild(backdrop);
    });
  },

  prompt(message, opts = {}) {
    const title = opts.title || 'Giriş';
    const defaultValue = opts.defaultValue || '';
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      let onKeydown;
      backdrop.className = 'modal-backdrop confirm-backdrop';
      backdrop.innerHTML = `
        <div class="modal-card confirm-card">
          <h2>${title}</h2>
          <p>${message}</p>
          <input type="text" value="${defaultValue.replace(/"/g, '&quot;')}">
          <div class="confirm-actions">
            <button class="btn btn-ghost" type="button" data-result="cancel">İptal</button>
            <button class="btn btn-accent2" type="button" data-result="confirm">Tamam</button>
          </div>
        </div>
      `;
      const input = backdrop.querySelector('input');
      const close = (result) => {
        backdrop.remove();
        if (onKeydown) document.removeEventListener('keydown', onKeydown);
        resolve(result);
      };
      backdrop.querySelector('[data-result="confirm"]').onclick = () => close(input.value);
      backdrop.querySelector('[data-result="cancel"]').onclick = () => close(null);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
      onKeydown = (e) => {
        if (e.key === 'Escape') close(null);
      };
      document.addEventListener('keydown', onKeydown);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value); });
      document.body.appendChild(backdrop);
      input.focus();
      input.select();
    });
  },

  async logout() {
    await API.post('/api/logout', {});
    window.location.href = '/';
  }
};

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});

App.init();
