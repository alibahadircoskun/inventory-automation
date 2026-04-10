const Approval = {
  queueStatus: 'pending',
  queue: [],
  currentSession: null,
  dashboard: null,
  metaTimer: null,
  metaResults: new Map(),

  async init() {
    await Promise.all([
      Approval.loadDashboard(),
      Approval.loadQueue(Approval.queueStatus)
    ]);
  },

  async loadDashboard() {
    Approval.dashboard = await API.get('/api/approval/dashboard');
    Approval.renderDashboard();
  },

  renderDashboard() {
    const el = document.getElementById('approvalDashboard');
    if (!el || !Approval.dashboard) return;
    const counts = Approval.dashboard.counts || {};
    const snipe = Approval.dashboard.snipe || {};
    el.innerHTML = `
      <div class="dashboard-card"><span>Bekleyen</span><strong>${counts.pending || 0}</strong></div>
      <div class="dashboard-card"><span>Onaylı</span><strong>${counts.approved || 0}</strong></div>
      <div class="dashboard-card"><span>Reddedilen</span><strong>${counts.rejected || 0}</strong></div>
      <div class="dashboard-card ${snipe.healthy ? 'healthy' : 'warn'}">
        <span>Envanter</span>
        <strong>${snipe.healthy ? (snipe.dry_run ? 'Dry Run' : 'Canlı') : 'Bağlantı Sorunu'}</strong>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" onclick="Approval.refreshLocalInventoryCache()">Yerel Envanteri Yenile</button>
    `;
  },

  async loadQueue(status) {
    Approval.queueStatus = status;
    Approval.queue = await API.get(`/api/approval/queue?status=${encodeURIComponent(status)}`);
    Approval.renderQueue();

    if (Approval.queue.length > 0) {
      const currentInQueue = Approval.currentSession && Approval.queue.some((item) => item.id === Approval.currentSession.id);
      await Approval.openSession(currentInQueue ? Approval.currentSession.id : Approval.queue[0].id);
    } else {
      Approval.currentSession = null;
      Approval.renderDetail();
    }
  },

  renderQueue() {
    const list = document.getElementById('approvalQueueList');
    const filters = document.getElementById('approvalFilters');
    if (!list || !filters) return;

    filters.innerHTML = ['pending', 'approved', 'rejected'].map((status) => `
      <button class="btn btn-ghost btn-sm ${Approval.queueStatus === status ? 'is-active' : ''}" type="button" onclick="Approval.loadQueue('${status}')">
        ${App.getStatusLabel(status)}
      </button>
    `).join('');

    if (!Approval.queue.length) {
      list.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">checklist</span><div class="empty-state-title">Bu filtre için talep yok</div></div>';
      return;
    }

    list.innerHTML = Approval.queue.map((item) => `
      <button class="approval-queue-card ${Approval.currentSession?.id === item.id ? 'is-active' : ''}" type="button" onclick="Approval.openSession('${item.id}')">
        <div class="approval-queue-card-top">
          <div>
            <div class="approval-queue-title">${item.title || 'Isimsiz Talep'}</div>
            <div class="approval-queue-meta">${item.owner.display_name} · ${new Date(`${(item.submitted_at || item.updated_at)}Z`).toLocaleString('tr-TR')}</div>
            ${item.sourceSession ? `<div class="approval-queue-meta">Kaynak: ${item.sourceSession.title || 'Isimsiz Talep'} · ${App.getStatusLabel(item.sourceSession.status)}</div>` : ''}
          </div>
          <div class="approval-queue-badges">
            <span class="session-status ${item.status}">${App.getStatusLabel(item.status)}</span>
            ${item.snipeit_sync_status ? `<span class="session-status sync ${item.snipeit_sync_status}">${App.getSyncStatusLabel(item.snipeit_sync_status)}</span>` : ''}
          </div>
        </div>
      </button>
    `).join('');
  },

  async openSession(sessionId) {
    Approval.currentSession = await API.get(`/api/approval/${sessionId}`);
    Approval.renderQueue();
    Approval.renderDetail();
  },

  collectManagerOverrides() {
    const devices = Array.from(document.querySelectorAll('[data-manager-override]')).map((wrapper) => ({
      deviceId: Number(wrapper.dataset.deviceId),
      model: wrapper.querySelector('[data-field="model"]')?.value || '',
      proposedNewAssetStatus: wrapper.querySelector('[data-field="status"]')?.value || '',
      proposedNewAssetLocation: wrapper.querySelector('[data-field="location"]')?.value || ''
    }));

    const components = Array.from(document.querySelectorAll('[data-manager-component-override]')).map((wrapper) => ({
      deviceId: Number(wrapper.dataset.deviceId),
      targetType: wrapper.dataset.targetType || 'component',
      componentId: Number(wrapper.dataset.componentId || 0) || null,
      unitId: Number(wrapper.dataset.unitId || 0) || null,
      proposedNewComponentLocation: wrapper.querySelector('[data-field="component-location"]')?.value || ''
    }));

    return { devices, components };
  },

  async onMetaInput(input, field, deviceId) {
    const query = input.value.trim();
    const dropdown = document.getElementById(`approval_dd_${field}_${deviceId}`);
    if (!dropdown) return;
    if (!query || query.length < 1) {
      dropdown.classList.remove('open');
      return;
    }

    clearTimeout(Approval.metaTimer);
    Approval.metaTimer = setTimeout(async () => {
      const endpoint = field === 'status' ? 'statuslabels' : 'locations';
      const results = await API.get(`/api/snipeit/${endpoint}/search?q=${encodeURIComponent(query)}`);
      Approval.metaResults.set(`asset_${field}_${deviceId}`, results || []);
      if (!results?.length) {
        dropdown.innerHTML = '<div class="search-empty">Sonuc bulunamadı</div>';
        dropdown.classList.add('open');
        return;
      }

      dropdown.innerHTML = results.map((row, index) => `
        <div class="search-item" onmousedown="Approval.selectMeta('${field}', ${deviceId}, ${index})">
          <div class="search-item-main">${Search.highlight(row.name || '-', query)}</div>
        </div>
      `).join('');
      dropdown.classList.add('open');
    }, 220);
  },

  selectMeta(field, deviceId, index) {
    const rows = Approval.metaResults.get(`asset_${field}_${deviceId}`) || [];
    const selected = rows[index];
    if (!selected) return;
    const wrapper = document.querySelector(`[data-manager-override][data-device-id="${deviceId}"]`);
    if (!wrapper) return;
    const input = wrapper.querySelector(`[data-field="${field}"]`);
    if (input) input.value = selected.name || '';
    const dropdown = document.getElementById(`approval_dd_${field}_${deviceId}`);
    if (dropdown) dropdown.classList.remove('open');
  },

  closeMetaDropdown(field, deviceId, delay = 0) {
    setTimeout(() => {
      const dropdown = document.getElementById(`approval_dd_${field}_${deviceId}`);
      if (dropdown) dropdown.classList.remove('open');
    }, delay);
  },

  renderNewAssetReview(device) {
    if (device.assetResolutionMode !== 'create_new') return '';

    return `
      <div class="review-new-asset" data-manager-override data-device-id="${device.id}">
        <div class="review-new-asset-title">Yeni Sunucu Onayı</div>
        <div class="device-inline-fields">
          <div class="field">
            <label>Model</label>
            <input type="text" data-field="model" value="${device.model || ''}">
          </div>
          <div class="field">
            <label>Durum</label>
            <div class="search-wrap">
              <input type="text" data-field="status" value="${device.proposedNewAssetStatus || ''}"
                oninput="Approval.onMetaInput(this, 'status', ${device.id})"
                onblur="Approval.closeMetaDropdown('status', ${device.id}, 150)">
              <div class="search-dropdown" id="approval_dd_status_${device.id}"></div>
            </div>
          </div>
          <div class="field">
            <label>Lokasyon</label>
            <div class="search-wrap">
              <input type="text" data-field="location" value="${device.proposedNewAssetLocation || ''}"
                oninput="Approval.onMetaInput(this, 'location', ${device.id})"
                onblur="Approval.closeMetaDropdown('location', ${device.id}, 150)">
              <div class="search-dropdown" id="approval_dd_location_${device.id}"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  renderCreateNewComponentOverrides(device) {
    const rows = [];
    const pushLocationField = (title, item, targetType, componentId, unitId) => {
      rows.push(`
        <div class="review-new-asset" data-manager-component-override data-device-id="${device.id}" data-target-type="${targetType}" data-component-id="${componentId || ''}" data-unit-id="${unitId || ''}">
          <div class="review-new-asset-title">${title}</div>
          <div class="device-inline-fields">
            <div class="field">
              <label>Kategori</label>
              <input type="text" value="${item.proposedNewComponentCategory || ''}" disabled>
            </div>
            <div class="field">
              <label>Lokasyon</label>
              <input type="text" data-field="component-location" value="${item.proposedNewComponentLocation || ''}">
            </div>
          </div>
        </div>
      `);
    };

    for (const component of device.takilanComponents || []) {
      if (Array.isArray(component.units) && component.units.length > 0) {
        component.units.forEach((unit, index) => {
          if (unit.snipeitMatchStatus !== 'create_new') return;
          pushLocationField(`Takılan ${component.type} #${index + 1}`, unit, 'unit', component.id, unit.id);
        });
      } else if (component.snipeitMatchStatus === 'create_new') {
        pushLocationField(`Takılan ${component.type}`, component, 'component', component.id, null);
      }
    }

    for (const component of device.components || []) {
      if (Array.isArray(component.units) && component.units.length > 0) {
        component.units.forEach((unit, index) => {
          if (unit.snipeitMatchStatus !== 'create_new') return;
          pushLocationField(`Çıkarılan ${component.type} #${index + 1}`, unit, 'unit', component.id, unit.id);
        });
      } else if (component.snipeitMatchStatus === 'create_new') {
        pushLocationField(`Çıkarılan ${component.type}`, component, 'component', component.id, null);
      }
    }

    return rows.join('');
  },

  renderDetail() {
    const el = document.getElementById('approvalDetail');
    if (!el) return;
    if (!Approval.currentSession) {
      el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">task_alt</span><div class="empty-state-title">İncelemek için soldan bir talep seçin</div></div>';
      return;
    }

    const session = Approval.currentSession;
    const sourceNote = session.sourceSession
      ? `<div class="session-source-note">Kaynak talep: ${session.sourceSession.title || 'Isimsiz Talep'} · ${App.getStatusLabel(session.sourceSession.status)}</div>`
      : '';
    const devicesHtml = (session.devices || []).map((device, index) => `
      <div class="approval-device-card">
        <div class="approval-device-top">
          <div>
            <div class="approval-device-title">${device.model || device.etiket || `Cihaz ${index + 1}`}</div>
            <div class="approval-device-meta">${device.assetResolutionMode === 'matched' ? 'Eşleşen sunucu' : 'Yeni sunucu'} · ${device.etiket || '-'} · ${device.seri || '-'}</div>
          </div>
          <span class="device-match-pill ${device.assetResolutionMode === 'matched' ? 'matched' : 'new'}">
            ${device.assetResolutionMode === 'matched' ? 'Envanter doğrulandı' : 'Yeni sunucu'}
          </span>
        </div>
        ${Approval.renderNewAssetReview(device)}
        ${Approval.renderCreateNewComponentOverrides(device)}
      </div>
    `).join('');

    const auditHtml = (session.auditLog || []).map((row) => `
      <div class="audit-row ${row.success ? 'success' : 'error'}">
        <div class="audit-row-top">
          <strong>${row.operation}</strong>
          <span>${row.response_status || '-'}</span>
        </div>
        <div class="audit-row-meta">${row.endpoint}</div>
      </div>
    `).join('');

    el.innerHTML = `
      <div class="approval-detail-header">
        <div>
          <div class="approval-detail-title">${session.title || 'Isimsiz Talep'}</div>
          <div class="approval-detail-meta">${session.owner.display_name} · ${new Date(`${session.updated_at}Z`).toLocaleString('tr-TR')}</div>
        </div>
        <div class="approval-detail-badges">
          <span class="session-status ${session.status}">${App.getStatusLabel(session.status)}</span>
          ${session.snipeit_sync_status ? `<span class="session-status sync ${session.snipeit_sync_status}">${App.getSyncStatusLabel(session.snipeit_sync_status)}</span>` : ''}
        </div>
      </div>
      <div class="approval-detail-body">
        <div class="approval-main-column">
          ${sourceNote}
          <div class="session-note">${session.review_comment || 'Henüz yönetici notu yok.'}</div>
          ${devicesHtml}
          <div class="approval-actions-card">
            <label for="approvalComment">Yönetici Notu</label>
            <textarea id="approvalComment" rows="3" placeholder="Onay veya ret notu...">${session.review_comment || ''}</textarea>
            <div class="approval-actions-row">
              ${session.status === 'pending' ? `<button class="btn btn-success" type="button" onclick="Approval.approve()">Onayla ve Senkronize Et</button>` : ''}
              ${session.status === 'pending' ? `<button class="btn btn-danger btn-sm" type="button" onclick="Approval.reject()">Reddet</button>` : ''}
              ${session.status === 'approved' && session.snipeit_sync_status !== 'running' ? `<button class="btn btn-warn" type="button" onclick="Approval.unapprove()">Onayı Geri Al ve Geri Çevir</button>` : ''}
              ${['failed', 'partial'].includes(session.snipeit_sync_status) ? `<button class="btn btn-warn" type="button" onclick="Approval.retrySync()">Senkronu Tekrar Dene</button>` : ''}
            </div>
          </div>
          <div class="approval-preview-card">
            <div class="approval-preview-grid">
              <div>
                <div class="panel-title">HTML Önizleme</div>
                <div class="preview-content"><div>${Email.buildHTML({ description: session.description || '', devices: session.devices || [] })}</div></div>
              </div>
              <div>
                <div class="panel-title">Mevcut Cihaz Durumu</div>
                <div class="preview-content"><div>${CurrentState.buildPreviewHTML(session.devices || [], { allowRefresh: session.status === 'pending' || session.status === 'approved' })}</div></div>
              </div>
            </div>
          </div>
        </div>
        <div class="approval-side-column">
          <div class="panel-title">Senkron Logu</div>
          <div class="audit-log-list">${auditHtml || '<div class="empty-state"><span class="material-symbols-outlined">sync</span><div class="empty-state-title">Henüz senkron logu yok</div></div>'}</div>
        </div>
      </div>
    `;
  },

  async approve() {
    if (!Approval.currentSession) return;
    const comment = document.getElementById('approvalComment')?.value || '';
    const result = await API.post(`/api/approval/${Approval.currentSession.id}/approve`, {
      comment,
      managerOverrides: Approval.collectManagerOverrides()
    });
    Approval.currentSession = result.session;
    App.showToast(`Talep onaylandı (${App.getSyncStatusLabel(result.sync.status)})`);
    await Promise.all([Approval.loadDashboard(), Approval.loadQueue(Approval.queueStatus), App.refreshNotifications()]);
  },

  async reject() {
    if (!Approval.currentSession) return;
    const comment = document.getElementById('approvalComment')?.value || '';
    if (!comment.trim()) {
      App.showToast('Ret notu zorunlu', 'warn');
      return;
    }

    await API.post(`/api/approval/${Approval.currentSession.id}/reject`, { comment });
    App.showToast('Talep reddedildi');
    await Promise.all([Approval.loadDashboard(), Approval.loadQueue(Approval.queueStatus), App.refreshNotifications()]);
  },

  async unapprove() {
    if (!Approval.currentSession) return;
    const ok = await App.confirm('Bu işlem envanter değişikliklerini geri alıp talebi tekrar bekleyen duruma getirecek. Devam edilsin mi?', { title: 'Onayı Geri Al', confirmText: 'Geri Al', danger: true });
    if (!ok) return;

    try {
      const comment = document.getElementById('approvalComment')?.value || '';
      const result = await API.post(`/api/approval/${Approval.currentSession.id}/unapprove`, { comment });
      Approval.currentSession = result.session;
      App.showToast(`Onay geri alındı (${result.rollback.counts.success || 0} işlem geri çevrildi)`);
      await Promise.all([Approval.loadDashboard(), Approval.loadQueue('pending'), App.refreshNotifications()]);
    } catch (error) {
      App.showToast(error?.data?.error || error.message || 'Onay geri alınamadı', 'error');
    }
  },

  async retrySync() {
    if (!Approval.currentSession) return;
    const result = await API.post(`/api/approval/${Approval.currentSession.id}/retry-sync`, {});
    Approval.currentSession = result.session;
    App.showToast(`Senkron durumu: ${App.getSyncStatusLabel(result.sync.status)}`);
    await Promise.all([Approval.loadDashboard(), Approval.loadQueue(Approval.queueStatus), App.refreshNotifications()]);
  },

  async refreshLocalInventoryCache() {
    const result = await API.post('/api/snipeit/refresh-local-cache', {});
    App.showToast(`Yerel envanter yenilendi (${result.assets} sunucu, ${result.components} bileşen)`);
    await Approval.loadDashboard();
  },

  async refreshDeviceCurrentState(deviceId) {
    if (!Approval.currentSession?.id) return;
    try {
      const result = await API.post(`/api/approval/${Approval.currentSession.id}/devices/${deviceId}/current-state/refresh`, {});
      Approval.currentSession = result.session;
      Approval.renderQueue();
      Approval.renderDetail();
      App.showToast('Mevcut cihaz durumu yenilendi');
    } catch (error) {
      App.showToast(error?.data?.error || error.message || 'Mevcut durum yenilenemedi', 'warn');
    }
  }
};
