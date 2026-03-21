const App = {
  devices: [],
  ddState: {},
  currentUser: null,
  currentSessionId: null,
  currentSessionTitle: '',

  async init() {
    // Check auth
    try {
      App.currentUser = await API.get('/api/me');
      if (!App.currentUser) return;
    } catch(e) {
      window.location.href = '/';
      return;
    }

    // Show user in header
    const userEl = document.getElementById('headerUser');
    if (userEl) {
      const initials = App.currentUser.display_name.slice(0, 2).toUpperCase();
      userEl.innerHTML = `<div class="header-user-avatar"><span>${initials}</span></div>
        <span class="header-user-name">${App.currentUser.display_name}</span>
        <button class="btn btn-ghost btn-sm" onclick="App.logout()" title="Çıkış" style="padding:3px 10px;font-size:10px;color:var(--danger)">
          <span class="material-symbols-outlined" style="font-size:14px">logout</span><span class="btn-label"> Çıkış</span>
        </button>`;
    }

    App.showSessionList();
  },

  setHeaderMode(mode) {
    const editorActions = document.getElementById('headerEditorActions');
    const saveIndicator = document.getElementById('saveIndicator');
    const headerUser = document.getElementById('headerUser');

    if (editorActions) {
      editorActions.hidden = mode !== 'editor';
    }

    if (headerUser) {
      headerUser.style.display = mode === 'editor' ? 'none' : 'flex';
    }

    if (mode === 'sessions' && saveIndicator) {
      saveIndicator.textContent = '';
      saveIndicator.className = 'save-indicator';
    }
  },

  async showSessionList() {
    App.setHeaderMode('sessions');
    document.getElementById('sessionsView').style.display = 'flex';
    document.getElementById('editorView').style.display = 'none';
    Sync.stopPolling();

    const sessions = await API.get('/api/sessions');
    const list = document.getElementById('sessionList');
    if (!sessions || sessions.length === 0) {
      list.innerHTML = '<div class="empty-state">Henüz taslak yok. Yeni bir taslak oluşturun.</div>';
      return;
    }
    list.innerHTML = sessions.map(s => {
      const date = new Date(s.updated_at + 'Z').toLocaleString('tr-TR');
      const statusClass = s.status === 'completed' ? 'completed' : 'draft';
      const statusLabel = s.status === 'completed' ? 'Tamamlandı' : '';
      const title = s.title || s.description?.slice(0, 40) || 'İsimsiz Taslak';
      const statusHtml = statusLabel
        ? `<span class="session-status ${statusClass}">${statusLabel}</span>`
        : '';
      return `<div class="session-card" onclick="App.openSession('${s.id}')">
        <div class="session-card-info">
          <div class="session-card-title">${title}</div>
          <div class="session-card-meta">
            <span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle;margin-right:4px">calendar_today</span>${date}
          </div>
        </div>
        <div class="session-card-actions">
          ${statusHtml}
          <button class="btn btn-ghost" style="padding:6px 8px;font-size:12px;border-radius:8px" onclick="event.stopPropagation();App.renameSession('${s.id}')" title="Adı Değiştir">
            <span class="material-symbols-outlined" style="font-size:18px">edit</span>
          </button>
          <button class="btn btn-danger" style="padding:6px 8px;font-size:12px;border-radius:8px" onclick="event.stopPropagation();App.deleteSession('${s.id}')" title="Sil">
            <span class="material-symbols-outlined" style="font-size:18px">delete</span>
          </button>
        </div>
      </div>`;
    }).join('');
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

    document.getElementById('sessionsView').style.display = 'none';
    document.getElementById('editorView').style.display = 'grid';

    Sync.lastUpdatedAt = session.updated_at;
    Sync.startPolling(sessionId);
  },

  loadSessionData(session, isSync) {
    // Convert server format to in-memory format
    const devices = (session.devices || []).map(d => ({
      model: d.model || '',
      etiket: d.etiket || '',
      seri: d.seri || '',
      not: d.not_text || '',
      componentsOnly: !!d.components_only,
      takilanComponents: (d.takilanComponents || []).map(c => ({
        type: c.type || 'CPU',
        qty: c.qty || 1,
        name: c.name || '',
        serial: c.serial || '',
        health: c.health ?? '',
        units: (c.units || []).map(u => ({
          name: u.name || '',
          serial: u.serial || '',
          health: u.health ?? ''
        }))
      })),
      components: (d.components || []).map(c => ({
        type: c.type || 'CPU',
        qty: c.qty || 1,
        name: c.name || '',
        serial: c.serial || '',
        health: c.health ?? '',
        units: (c.units || []).map(u => ({
          name: u.name || '',
          serial: u.serial || '',
          health: u.health ?? ''
        }))
      }))
    }));

    App.devices = devices.length > 0 ? devices : [Devices.makeDevice()];
    App.currentSessionTitle = session.title || '';
    App.ddState = {};
    App.devices.forEach((_, i) => { App.ddState[i] = {model:{selected:-1},etiket:{selected:-1},seri:{selected:-1}}; });

    document.getElementById('f_description').value = session.description || '';
    Devices.renderDeviceList();
    App.render();
  },

  async deleteSession(sessionId) {
    if (!confirm('Bu taslağı silmek istediğinizden emin misiniz?')) return;
    await API.del(`/api/sessions/${sessionId}`);
    App.showSessionList();
  },

  backToSessions() {
    Sync.stopPolling();
    App.currentSessionId = null;
    App.currentSessionTitle = '';
    App.showSessionList();
  },

  async renameSession(sessionId) {
    const session = await API.get(`/api/sessions/${sessionId}`);
    const existingTitle = String(session?.title || '');
    const nextTitle = window.prompt('Taslak adını girin:', existingTitle);
    if (nextTitle === null) return;

    const title = nextTitle.trim();
    await API.put(`/api/sessions/${sessionId}`, { title });

    if (App.currentSessionId === sessionId) {
      App.currentSessionTitle = title;
    }

    App.showToast(title ? 'Taslak adı güncellendi' : 'Taslak adı temizlendi');
    App.showSessionList();
  },

  async renameCurrentSession() {
    if (!App.currentSessionId) return;

    const nextTitle = window.prompt('Taslak adını girin:', App.currentSessionTitle || '');
    if (nextTitle === null) return;

    const title = nextTitle.trim();
    await API.put(`/api/sessions/${App.currentSessionId}`, { title });
    App.currentSessionTitle = title;
    App.showToast(title ? 'Taslak adı güncellendi' : 'Taslak adı temizlendi');
  },

  getFormData() {
    return {
      description: document.getElementById('f_description')?.value || '',
      devices: App.devices
    };
  },

  render() {
    const data = App.getFormData();
    const preview = document.getElementById('emailPreview');
    if (preview) preview.innerHTML = Email.buildHTML(data);
  },

  onDescriptionChange() {
    App.render();
    App.scheduleAutoSave();
  },

  scheduleAutoSave() {
    Sync.scheduleAutoSave();
  },

  resetForm() {
    document.getElementById('f_description').value = '';
    App.devices = [Devices.makeDevice()];
    App.ddState = { 0: {model:{selected:-1},etiket:{selected:-1},seri:{selected:-1}} };
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2800);
  },

  async logout() {
    await API.post('/api/logout', {});
    window.location.href = '/';
  }
};

// Initialize on load
App.init();
