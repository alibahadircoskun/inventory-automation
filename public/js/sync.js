const Sync = {
  POLL_INTERVAL: 3000,
  lastUpdatedAt: null,
  pollTimer: null,
  saveTimeout: null,
  savePending: false,

  startPolling(sessionId) {
    Sync.stopPolling();
    Sync.pollTimer = setInterval(async () => {
      if (Sync.savePending || !App.currentSessionId) return;
      try {
        const res = await API.get(`/api/sessions/${sessionId}/check`);
        if (res && (res.updated_at !== Sync.lastUpdatedAt || res.status !== App.currentSession?.status)) {
          Sync.lastUpdatedAt = res.updated_at;
          const session = await API.get(`/api/sessions/${sessionId}`);
          if (session) App.loadSessionData(session, true);
        }
      } catch (_) {}
    }, Sync.POLL_INTERVAL);
  },

  stopPolling() {
    clearInterval(Sync.pollTimer);
    Sync.pollTimer = null;
  },

  scheduleAutoSave() {
    if (!App.canEditCurrentSession()) return;
    clearTimeout(Sync.saveTimeout);
    Sync.updateIndicator('saving');
    Sync.saveTimeout = setTimeout(async () => {
      if (!App.currentSessionId || !App.canEditCurrentSession()) return;
      Sync.savePending = true;
      try {
        const data = App.getFormData();
        const res = await API.post(`/api/sessions/${App.currentSessionId}/save-all`, data);
        if (res) {
          Sync.lastUpdatedAt = res.updated_at;
          Sync.updateIndicator('saved');
        }
      } catch (_) {
        Sync.updateIndicator('error');
      } finally {
        Sync.savePending = false;
      }
    }, 500);
  },

  updateIndicator(state) {
    const el = document.getElementById('saveIndicator');
    if (!el) return;
    el.className = `save-indicator ${state}`;
    if (state === 'saving') el.textContent = 'Kaydediliyor...';
    else if (state === 'saved') el.textContent = 'Kaydedildi';
    else if (state === 'error') el.textContent = 'Kayıt hatasi';
  }
};
