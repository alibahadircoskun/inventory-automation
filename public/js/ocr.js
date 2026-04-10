const OCR = {
  cameraStream: null,
  currentFaçıngMode: 'environment',
  mode: 'batch',
  target: null,
  batchDestination: 'comp',
  queueItems: [],
  videoReady: false,
  processingStatus: 'idle',
  source: 'camera',
  permissionMessage: '',
  capturePreview: '',
  isProcessingQueue: false,
  sessionToken: 0,
  nextQueueId: 1,
  lastErrorNoticeKey: '',
  lastErrorNoticeAt: 0,
  focusLockRequested: false,
  focusLockActive: false,
  focusSupported: false,
  focusPointSupported: false,
  focusTapSupported: false,
  lastFocusPoint: null,
  focusMarkerVisible: false,
  focusMarkerLocked: false,
  focusMarkerTimer: null,
  focusLongPressMs: 500,
  focusCaptureDelayMs: 280,
  longPressTimer: null,
  longPressTriggered: false,
  focusGestureState: null,
  focusGestureFrame: null,
  focusGestureHandlers: null,
  focusUnsupportedNotified: false,
  captureTimerId: null,
  captureDelayPending: false,
  queueSheetDismissed: false,

  escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  isMobileView() {
    return window.matchMedia('(max-width: 768px)').matches;
  },

  supportsCameraApi() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  },

  canUseCamera() {
    return OCR.isMobileView() && OCR.supportsCameraApi() && window.isSecureContext;
  },

  clampUnit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(1, Math.max(0, parsed));
  },

  clearFocusMarkerTimer() {
    if (OCR.focusMarkerTimer) {
      window.clearTimeout(OCR.focusMarkerTimer);
      OCR.focusMarkerTimer = null;
    }
  },

  hideFocusMarker() {
    OCR.clearFocusMarkerTimer();
    OCR.focusMarkerVisible = false;
    OCR.focusMarkerLocked = false;
  },

  showFocusMarker(point, options = {}) {
    const normalized = OCR.normalizeFocusPoint(point);
    if (!normalized) return;
    OCR.lastFocusPoint = normalized;
    OCR.focusMarkerVisible = true;
    OCR.focusMarkerLocked = options.locked === true;
    OCR.clearFocusMarkerTimer();
    if (!OCR.focusMarkerLocked && options.keepVisible !== true) {
      OCR.focusMarkerTimer = window.setTimeout(() => {
        OCR.focusMarkerTimer = null;
        if (!OCR.focusLockActive) {
          OCR.focusMarkerVisible = false;
          OCR.renderWorkspace();
        }
      }, 900);
    }
  },

  clearLongPressTimer() {
    if (OCR.longPressTimer) {
      window.clearTimeout(OCR.longPressTimer);
      OCR.longPressTimer = null;
    }
  },

  clearCaptureTimer(resetStatus = false) {
    if (!OCR.captureTimerId) {
      OCR.captureDelayPending = false;
      return;
    }
    window.clearTimeout(OCR.captureTimerId);
    OCR.captureTimerId = null;
    OCR.captureDelayPending = false;
    if (resetStatus && OCR.processingStatus === 'capturing') {
      OCR.processingStatus = OCR.isProcessingQueue ? 'processing' : (OCR.videoReady ? 'ready' : 'idle');
    }
  },

  clearFocusGestureState() {
    OCR.clearLongPressTimer();
    OCR.longPressTriggered = false;
    OCR.focusGestureState = null;
  },

  getCameraTrack(stream) {
    const activeStream = stream || OCR.cameraStream;
    if (!activeStream || typeof activeStream.getVideoTracks !== 'function') return null;
    const tracks = activeStream.getVideoTracks();
    return tracks && tracks.length ? tracks[0] : null;
  },

  normalizeFocusPoint(point) {
    if (!point || typeof point !== 'object') return null;
    return {
      x: OCR.clampUnit(point.x),
      y: OCR.clampUnit(point.y)
    };
  },

  getFrameFocusPointFromEvent(event, frame) {
    if (!event || !frame) return null;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: OCR.clampUnit((event.clientX - rect.left) / rect.width),
      y: OCR.clampUnit((event.clientY - rect.top) / rect.height)
    };
  },

  mapFocusPointForTrack(point) {
    const normalized = OCR.normalizeFocusPoint(point);
    if (!normalized) return null;
    if (OCR.currentFaçıngMode === 'user') {
      return {
        x: OCR.clampUnit(1 - normalized.x),
        y: normalized.y
      };
    }
    return normalized;
  },

  inspectFocusCapabilities(track) {
    const activeTrack = track || OCR.getCameraTrack();
    let capabilities = {};
    try {
      if (activeTrack && typeof activeTrack.getCapabilities === 'function') {
        capabilities = activeTrack.getCapabilities() || {};
      }
    } catch (error) {
      capabilities = {};
    }

    const focusModes = Array.isArray(capabilities.focusMode)
      ? capabilities.focusMode.slice()
      : [];
    const supportsManual = focusModes.includes('manual') || focusModes.includes('locked');
    const supportsSingleShot = focusModes.includes('single-shot');
    const supportsContinuous = focusModes.includes('continuous') || focusModes.includes('auto');
    const pointsCapability = capabilities.pointsOfInterest;
    const supportsPoint = pointsCapability !== undefined && pointsCapability !== null;
    const supportsLock = supportsManual || supportsSingleShot;
    const supportsTap = supportsPoint || supportsSingleShot || supportsContinuous;

    OCR.focusSupported = supportsLock;
    OCR.focusPointSupported = supportsPoint;
    OCR.focusTapSupported = supportsTap;

    if (!supportsLock) {
      OCR.focusLockActive = false;
      OCR.focusMarkerLocked = false;
      OCR.focusLockRequested = false;
    }

    return {
      track: activeTrack,
      focusModes,
      supportsManual,
      supportsSingleShot,
      supportsContinuous,
      supportsPoint,
      supportsLock,
      supportsTap
    };
  },

  buildFocusConstraint(mode, point) {
    const constraint = {};
    if (mode) constraint.focusMode = mode;
    if (point && OCR.focusPointSupported) {
      constraint.pointsOfInterest = [point];
    }
    if (!Object.keys(constraint).length) return null;
    return { advanced: [constraint] };
  },

  async tryApplyFocusConstraint(track, mode, point) {
    if (!track || typeof track.applyConstraints !== 'function') return false;
    const constraint = OCR.buildFocusConstraint(mode, point);
    if (!constraint) return false;
    try {
      await track.applyConstraints(constraint);
      return true;
    } catch (error) {
      return false;
    }
  },

  notifyFocusUnsupported(message) {
    if (OCR.focusUnsupportedNotified) return;
    OCR.focusUnsupportedNotified = true;
    App.showToast(message || 'Bu kamera dokunmatik odak veya odak kilidi desteklemiyor');
  },

  async focusAtPoint(point) {
    const normalized = OCR.normalizeFocusPoint(point);
    if (!normalized || OCR.source !== 'camera' || !OCR.videoReady || !!OCR.capturePreview) {
      return false;
    }

    if (OCR.focusLockActive) {
      return OCR.setFocusLock(true, normalized, {
        preserveRequested: true,
        suppressFailureToast: true
      });
    }

    OCR.showFocusMarker(normalized, { locked: false });

    const info = OCR.inspectFocusCapabilities();
    if (!info.track || !info.supportsTap) {
      OCR.notifyFocusUnsupported();
      OCR.renderWorkspace();
      return false;
    }

    const pointForTrack = OCR.mapFocusPointForTrack(normalized);
    const attempts = [];

    if (info.supportsSingleShot) {
      attempts.push({ mode: 'single-shot', point: pointForTrack });
    }
    if (info.supportsContinuous) {
      attempts.push({ mode: 'continuous', point: pointForTrack });
    }
    if (info.supportsSingleShot) {
      attempts.push({ mode: 'single-shot', point: null });
    }
    if (info.supportsContinuous) {
      attempts.push({ mode: 'continuous', point: null });
    }
    if (info.supportsPoint) {
      attempts.push({ mode: null, point: pointForTrack });
    }

    let applied = false;
    for (const attempt of attempts) {
      // eslint-disable-next-line no-await-in-loop
      applied = await OCR.tryApplyFocusConstraint(info.track, attempt.mode, attempt.point);
      if (applied) break;
    }

    OCR.renderWorkspace();
    return applied;
  },

  async setFocusLock(enabled, point, options = {}) {
    const normalized = OCR.normalizeFocusPoint(point) || OCR.lastFocusPoint || { x: 0.5, y: 0.5 };
    const info = OCR.inspectFocusCapabilities();
    const track = info.track;

    if (!enabled) {
      let released = true;
      if (track && info.supportsContinuous) {
        released = await OCR.tryApplyFocusConstraint(track, 'continuous', null);
      }
      OCR.focusLockRequested = false;
      OCR.focusLockActive = false;
      OCR.focusMarkerLocked = false;
      if (OCR.lastFocusPoint) {
        OCR.showFocusMarker(OCR.lastFocusPoint, { locked: false });
      } else {
        OCR.hideFocusMarker();
      }
      if (!released && options.suppressFailureToast !== true) {
        App.showToast('Odak kilidi kapatılamadı');
      }
      if (options.skipRender !== true) OCR.renderWorkspace();
      return released;
    }

    if (!track || !info.supportsLock) {
      OCR.focusLockRequested = false;
      OCR.focusLockActive = false;
      OCR.focusMarkerLocked = false;
      if (options.suppressUnsupportedToast !== true) {
        OCR.notifyFocusUnsupported();
      }
      if (options.skipRender !== true) OCR.renderWorkspace();
      return false;
    }

    const trackPoint = OCR.mapFocusPointForTrack(normalized);
    const modeOrder = [];

    // Prefer single-shot autofocus for lock because manual/locked often causes soft focus on mobile browsers.
    if (info.supportsSingleShot) modeOrder.push('single-shot');
    if (!modeOrder.length && info.focusModes.includes('locked')) modeOrder.push('locked');
    if (!modeOrder.length && info.focusModes.includes('manual')) modeOrder.push('manual');

    const attempts = [];
    for (const mode of modeOrder) {
      attempts.push({ mode, point: trackPoint });
      attempts.push({ mode, point: null });
    }
    if (info.supportsPoint) {
      attempts.push({ mode: null, point: trackPoint });
    }

    let locked = false;
    for (const attempt of attempts) {
      // eslint-disable-next-line no-await-in-loop
      locked = await OCR.tryApplyFocusConstraint(track, attempt.mode, attempt.point);
      if (locked) break;
    }

    if (locked) {
      OCR.focusLockRequested = true;
      OCR.focusLockActive = true;
      OCR.showFocusMarker(normalized, { locked: true, keepVisible: true });
    } else {
      OCR.focusLockActive = false;
      OCR.focusMarkerLocked = false;
      if (options.preserveRequested !== true) {
        OCR.focusLockRequested = false;
      }
      if (options.suppressFailureToast !== true) {
        App.showToast('Odak kilidi bu kamerada uygulanamadı');
      }
    }

    if (options.skipRender !== true) OCR.renderWorkspace();
    return locked;
  },

  async toggleFocusLock(point) {
    if (OCR.source !== 'camera' || !OCR.videoReady || OCR.processingStatus === 'opening-camera') {
      return;
    }

    if (OCR.focusLockActive || OCR.focusLockRequested) {
      await OCR.setFocusLock(false, point, { suppressFailureToast: true });
      return;
    }

    const lockPoint = OCR.normalizeFocusPoint(point) || OCR.lastFocusPoint || { x: 0.5, y: 0.5 };
    OCR.focusLockRequested = true;
    const locked = await OCR.setFocusLock(true, lockPoint, { preserveRequested: true });
    if (!locked) {
      OCR.focusLockRequested = false;
    }
    OCR.renderWorkspace();
  },

  shouldEnableFocusGestures() {
    return OCR.source === 'camera'
      && OCR.isOverlayOpen()
      && OCR.videoReady
      && !OCR.capturePreview
      && OCR.processingStatus !== 'opening-camera'
      && OCR.processingStatus !== 'capturing'
      && !OCR.getCameraPlaceholderText();
  },

  bindFocusGestures(frame) {
    if (!frame) return;
    if (OCR.focusGestureFrame === frame && OCR.focusGestureHandlers) return;

    OCR.unbindFocusGestures();

    OCR.focusGestureHandlers = {
      down: event => OCR.handleFocusPointerDown(event),
      move: event => OCR.handleFocusPointerMove(event),
      up: event => OCR.handleFocusPointerUp(event),
      cancel: event => OCR.handleFocusPointerCancel(event)
    };

    frame.addEventListener('pointerdown', OCR.focusGestureHandlers.down, { passive: false });
    frame.addEventListener('pointermove', OCR.focusGestureHandlers.move, { passive: true });
    frame.addEventListener('pointerup', OCR.focusGestureHandlers.up, { passive: false });
    frame.addEventListener('pointercancel', OCR.focusGestureHandlers.cancel, { passive: true });
    OCR.focusGestureFrame = frame;
  },

  unbindFocusGestures() {
    const frame = OCR.focusGestureFrame;
    const handlers = OCR.focusGestureHandlers;
    if (frame && handlers) {
      frame.removeEventListener('pointerdown', handlers.down);
      frame.removeEventListener('pointermove', handlers.move);
      frame.removeEventListener('pointerup', handlers.up);
      frame.removeEventListener('pointercancel', handlers.cancel);
    }
    OCR.focusGestureFrame = null;
    OCR.focusGestureHandlers = null;
    OCR.clearFocusGestureState();
  },

  handleFocusPointerDown(event) {
    if (!OCR.shouldEnableFocusGestures()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const frame = OCR.focusGestureFrame;
    const point = OCR.getFrameFocusPointFromEvent(event, frame);
    if (!point) return;

    event.preventDefault();

    OCR.clearFocusGestureState();
    OCR.focusGestureState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      point
    };

    if (frame && typeof frame.setPointerCapture === 'function') {
      try {
        frame.setPointerCapture(event.pointerId);
      } catch (error) {
        // ignore capture issues
      }
    }

    OCR.longPressTimer = window.setTimeout(() => {
      if (!OCR.focusGestureState || OCR.focusGestureState.pointerId !== event.pointerId) return;
      OCR.longPressTimer = null;
      OCR.longPressTriggered = true;
      OCR.toggleFocusLock(OCR.focusGestureState.point);
    }, OCR.focusLongPressMs);
  },

  handleFocusPointerMove(event) {
    const state = OCR.focusGestureState;
    if (!state || state.pointerId !== event.pointerId) return;

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.hypot(dx, dy) > 16) {
      state.moved = true;
      OCR.clearLongPressTimer();
    }
  },

  handleFocusPointerUp(event) {
    const state = OCR.focusGestureState;
    if (!state || state.pointerId !== event.pointerId) return;

    event.preventDefault();

    const frame = OCR.focusGestureFrame;
    if (frame && typeof frame.releasePointerCapture === 'function') {
      try {
        frame.releasePointerCapture(event.pointerId);
      } catch (error) {
        // ignore capture issues
      }
    }

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    const moved = state.moved || Math.hypot(dx, dy) > 16;
    const wasLongPress = OCR.longPressTriggered;
    const point = OCR.getFrameFocusPointFromEvent(event, frame) || state.point;

    OCR.clearLongPressTimer();
    OCR.longPressTriggered = false;
    OCR.focusGestureState = null;

    if (!wasLongPress && !moved && point) {
      if (OCR.focusLockActive) {
        OCR.setFocusLock(true, point, {
          preserveRequested: true,
          suppressFailureToast: true
        });
      } else {
        OCR.focusAtPoint(point);
      }
    }
  },

  handleFocusPointerCancel(event) {
    const state = OCR.focusGestureState;
    if (!state || state.pointerId !== event.pointerId) return;

    OCR.clearLongPressTimer();
    OCR.longPressTriggered = false;
    OCR.focusGestureState = null;
  },

  normalizeHardwareType(value) {
    const hardwareType = String(value || 'disk').toLowerCase();
    return ['disk', 'ram', 'nic', 'cpu'].includes(hardwareType) ? hardwareType : 'disk';
  },

  normalizeServerLabel(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  },

  isValidServerLabel(value) {
    return /^[A-Z0-9]{4,12}$/.test(String(value || ''));
  },

  isRackLabelTag(value) {
    const normalized = OCR.normalizeServerLabel(value);
    return !!normalized && normalized.length <= 6 && /^(PD|SH)/.test(normalized);
  },

  getResultKind(value) {
    return String(value || '').toLowerCase() === 'server_label' ? 'server_label' : 'component';
  },

  createEmptyFields(hardwareType) {
    return {
      hardwareType: OCR.normalizeHardwareType(hardwareType),
      serverLabel: '',
      serviceTag: '',
      manufacturer: '',
      model: '',
      capacity: '',
      serial: '',
      rpm: '',
      formFactor: '',
      memoryType: '',
      speed: '',
      rank: '',
      partNumber: '',
      frequency: '',
      cores: '',
      socket: '',
      ports: '',
      interface: ''
    };
  },

  buildFieldsFromResult(result) {
    const fields = OCR.createEmptyFields(result?.hardwareType);
    const normalizedServerLabel = OCR.normalizeServerLabel(result?.serverLabel);
    const normalizedServiceTag = OCR.normalizeServerLabel(result?.serviceTag);
    return {
      ...fields,
      hardwareType: OCR.normalizeHardwareType(result?.hardwareType),
      serverLabel: normalizedServerLabel || normalizedServiceTag,
      serviceTag: normalizedServiceTag,
      manufacturer: result?.manufacturer || '',
      model: result?.model || '',
      capacity: result?.capacity || '',
      serial: result?.serial || '',
      rpm: result?.rpm || '',
      formFactor: result?.formFactor || '',
      memoryType: result?.memoryType || '',
      speed: result?.speed || '',
      rank: result?.rank || '',
      partNumber: result?.partNumber || '',
      frequency: result?.frequency || '',
      cores: result?.cores || '',
      socket: result?.socket || '',
      ports: result?.ports || '',
      interface: result?.interface || ''
    };
  },

  openCamera(di, listType, rowIdx) {
    OCR.sessionToken += 1;
    OCR.target = {
      di,
      listType: listType || null,
      rowIdx: rowIdx === undefined ? null : rowIdx
    };
    OCR.mode = listType && rowIdx !== undefined ? 'single' : 'batch';
    OCR.batchDestination = OCR.normalizeDestination(di, OCR.mode === 'single'
      ? (listType || OCR.getDefaultDestination(di))
      : OCR.getDefaultDestination(di));
    OCR.queueItems = [];
    OCR.videoReady = false;
    OCR.processingStatus = 'idle';
    OCR.permissionMessage = '';
    OCR.capturePreview = '';
    OCR.isProcessingQueue = false;
    OCR.source = OCR.canUseCamera() ? 'camera' : 'gallery';
    OCR.focusLockRequested = false;
    OCR.focusLockActive = false;
    OCR.focusSupported = false;
    OCR.focusPointSupported = false;
    OCR.focusTapSupported = false;
    OCR.lastFocusPoint = null;
    OCR.focusMarkerVisible = false;
    OCR.focusMarkerLocked = false;
    OCR.focusUnsupportedNotified = false;
    OCR.captureDelayPending = false;
    OCR.queueSheetDismissed = false;
    OCR.clearCaptureTimer();
    OCR.clearFocusMarkerTimer();
    OCR.unbindFocusGestures();
    OCR.closeQueueSheet({ dismiss: false });

    const overlay = document.getElementById('cameraOverlay');
    const input = document.getElementById('ocrFileInput');
    if (overlay) overlay.style.display = 'flex';
    if (input) {
      input.value = '';
      input.multiple = OCR.mode !== 'single';
    }

    OCR.renderWorkspace();

    if (OCR.source === 'camera') {
      OCR.startCamera();
    } else if (!OCR.supportsCameraApi()) {
      OCR.renderWorkspace();
      App.showToast('Kamera kullanılamadı, galeri modu açıldı');
    }
  },

  closeCamera() {
    OCR.sessionToken += 1;
    OCR.stopCameraStream();
    OCR.mode = 'batch';
    OCR.target = null;
    OCR.batchDestination = 'comp';
    OCR.queueItems = [];
    OCR.videoReady = false;
    OCR.processingStatus = 'idle';
    OCR.source = 'camera';
    OCR.permissionMessage = '';
    OCR.capturePreview = '';
    OCR.isProcessingQueue = false;
    OCR.focusLockRequested = false;
    OCR.focusLockActive = false;
    OCR.focusSupported = false;
    OCR.focusPointSupported = false;
    OCR.focusTapSupported = false;
    OCR.lastFocusPoint = null;
    OCR.focusMarkerVisible = false;
    OCR.focusMarkerLocked = false;
    OCR.focusUnsupportedNotified = false;
    OCR.captureDelayPending = false;
    OCR.queueSheetDismissed = false;
    OCR.clearCaptureTimer();
    OCR.clearFocusMarkerTimer();
    OCR.unbindFocusGestures();
    OCR.closeQueueSheet({ dismiss: false });

    const overlay = document.getElementById('cameraOverlay');
    const input = document.getElementById('ocrFileInput');
    if (overlay) overlay.style.display = 'none';
    if (input) input.value = '';
  },

  stopCameraStream(options = {}) {
    const preserveFocusLock = options.preserveFocusLock === true;

    OCR.unbindFocusGestures();
    OCR.clearCaptureTimer(true);
    OCR.clearFocusMarkerTimer();

    if (OCR.cameraStream) {
      OCR.cameraStream.getTracks().forEach(track => track.stop());
      OCR.cameraStream = null;
    }
    const video = document.getElementById('cameraVideo');
    if (video) {
      video.pause();
      video.srcObject = null;
      video.onloadedmetadata = null;
      video.oncanplay = null;
    }

    OCR.videoReady = false;
    OCR.focusLockActive = false;
    OCR.focusSupported = false;
    OCR.focusPointSupported = false;
    OCR.focusTapSupported = false;
    OCR.focusMarkerVisible = false;
    OCR.focusMarkerLocked = false;
    OCR.captureDelayPending = false;
    OCR.focusUnsupportedNotified = false;
    if (!preserveFocusLock) {
      OCR.focusLockRequested = false;
      OCR.lastFocusPoint = null;
    }
  },

  isOverlayOpen() {

    return !!OCR.target && document.getElementById('cameraOverlay')?.style.display !== 'none';
  },

  isRowTargeted() {
    return !!(OCR.target && OCR.target.listType && OCR.target.rowIdx !== null && OCR.target.rowIdx !== undefined);
  },

  getDevice(di) {
    return App.devices?.[di] || null;
  },

  getDeviceLabel(di) {
    const device = OCR.getDevice(di);
    if (!device) return `Cihaz ${Number(di) + 1 || 1}`;
    const etiket = String(device.etiket || '').trim();
    if (etiket) return etiket;
    const model = String(device.model || '').trim();
    if (model) return model;
    return `Cihaz ${Number(di) + 1}`;
  },

  getDefaultDestination(di) {
    const device = OCR.getDevice(di);
    return device?.componentsOnly ? 'comp' : 'takilan';
  },

  normalizeDestination(di, value) {
    const device = OCR.getDevice(di);
    if (!device) return 'comp';
    if (device.componentsOnly) return 'comp';
    return value === 'takilan' ? 'takilan' : 'comp';
  },

  getDestinationOptions() {
    const device = OCR.getDevice(OCR.target?.di);
    if (!device) return [];
    if (device.componentsOnly) {
      return [{ value: 'comp', label: 'Donanım Listesi' }];
    }
    return [
      { value: 'takilan', label: 'Takılan Donanım' },
      { value: 'comp', label: 'Çıkarılan Donanım' }
    ];
  },

  getDestinationLabel(value) {
    const device = OCR.getDevice(OCR.target?.di);
    if (device?.componentsOnly) return 'Donanım Listesi';
    return OCR.normalizeDestination(OCR.target?.di, value) === 'takilan' ? 'Takılan Donanım' : 'Çıkarılan Donanım';
  },

  getTargetSummaryText() {
    if (!OCR.target) return '';
    const deviceLabel = OCR.getDeviceLabel(OCR.target.di);
    if (OCR.isRowTargeted()) {
      const rowLabel = OCR.target.listType === 'takilan' ? 'Takılan satırı' : 'Çıkarılan satırı';
      return `${deviceLabel} içindeki ${rowLabel} #${Number(OCR.target.rowIdx) + 1} düzenlenecek. Uygulama yeni satır eklemez.`;
    }
    return `${deviceLabel} için metin tanıma. Hazır kartlar seçilen listeye tek tek yeni bileşen olarak eklenir.`;
  },

  getQueueCounts() {
    return OCR.queueItems.reduce((counts, item) => {
      counts.total += 1;
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, { total: 0, queued: 0, processing: 0, ready: 0, error: 0, applied: 0, skipped: 0 });
  },

  getStageStatusText() {
    if (OCR.source !== 'camera') return '';
    if (OCR.permissionMessage) return OCR.permissionMessage;
    if (OCR.processingStatus === 'opening-camera') return 'Kamera açılıyor...';
    if (OCR.processingStatus === 'capturing' && OCR.captureDelayPending) return 'Odak sabitleniyor, çekim hazırlanıyor...';
    if (OCR.processingStatus === 'capturing') return 'Kare hazırlanıyor...';
    if (OCR.processingStatus === 'processing') return 'Metin tanıma sırasıyla işleniyor...';
    if (OCR.capturePreview) return 'Çekilen kare korunuyor. Kartları inceleyin veya canlı önizlemeye dönün.';
    if (OCR.videoReady && OCR.focusLockActive) return 'Canlı önizleme hazır · Odak kilitli';
    if (OCR.videoReady) return 'Canlı önizleme hazır';
    return 'Kamera hazırlanıyor...';
  },

  getCameraPlaceholderText() {

    if (OCR.source !== 'camera') return '';
    if (!OCR.canUseCamera()) return 'Bu tarayıcıda kamera desteklenmiyor. Galeri modunu kullanın.';
    if (OCR.permissionMessage) return OCR.permissionMessage;
    if (OCR.processingStatus === 'opening-camera') return 'Kamera bağlantısı kuruluyor...';
    if (!OCR.videoReady && !OCR.capturePreview) return 'Canlı görüntü yüklenene kadar bekleyin.';
    return '';
  },

  getStageHintText() {
    if (OCR.source === 'gallery') {
      return OCR.mode === 'single'
        ? 'Seçili satır için tek bir etiket fotoğrafı ekleyin. Metin tanıma sonucu geldikten sonra düzenleyip uygulayın.'
        : 'Birden fazla etiket fotoğrafını tek seferde seçin. Her biri sırayla metin tanıma kuyruğunda işlenir ve hazır oldukça inceleme kartına düşer.';
    }
    if (OCR.capturePreview) {
      return OCR.mode === 'single'
        ? 'Bu kare seçili satıra uygulanmaya hazır. Gerekirse yeniden metin tanıma deneyebilir veya yeni bir kare alabilirsiniz.'
        : 'Bu kare kuyruğa eklendi. Hazır kartları tek tek veya hepsini birden taslağa aktarabilirsiniz.';
    }
    if (OCR.mode === 'batch' && OCR.processingStatus === 'processing') {
      return 'Metin tanıma arka planda sürüyor. Kartları gizleyip yeni kareler çekmeye devam edebilirsiniz.';
    }
    if (OCR.focusLockActive) {
      return 'Odak kilitli. Dokunarak odak noktasını taşıyın, kilidi kapatmak için aynı noktaya basılı tutun.';
    }
    return OCR.mode === 'single'
      ? 'Etiketi çerçeveye yaklaştırın. Dokunarak odaklayın, odak kilidi için 500 ms basılı tutun. Sonuç yalnızca seçili satırı günceller.'
      : 'Telefonu dik tutun, etikete dokunarak odaklayın. Odak kilidi için 500 ms basılı tutun; her çekim ayrı bir inceleme kartı oluşturur.';
  },

  getFooterMetaText(counts) {

    const deviceLabel = OCR.target ? OCR.getDeviceLabel(OCR.target.di) : 'Hedef cihaz seçili değil';
    if (OCR.mode === 'single') {
      return `${deviceLabel} için tekli metin tanıma modu. Kart onaylanınca mevcut satır güncellenir.`;
    }
    const parts = [];
    if (counts.ready) parts.push(`${counts.ready} hazır`);
    if (counts.processing) parts.push(`${counts.processing} işleniyor`);
    if (counts.error) parts.push(`${counts.error} hata`);
    if (counts.applied) parts.push(`${counts.applied} uygulandı`);
    if (!parts.length) parts.push('Henüz kuyruk yok');
    return `${deviceLabel} -> ${OCR.getDestinationLabel(OCR.batchDestination)}. ${parts.join(' · ')}.`;
  },

  humanizeCameraError(error) {
    const name = error?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Kamera izni verilmedi. Tarayıcı izinlerini kontrol edin veya galeri modunu kullanın.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'Kullanılabilir kamera bulunamadı. Galeri modunu kullanabilirsiniz.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Kamera şu an kullanılamıyor. Başka bir uygulama kamerayı kullanıyor olabilir.';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return 'İstenen kamera ayarları açılamadı. Diğer kameraya geçmeyi deneyin.';
    }
    return `Kamera açılamadı: ${error?.message || 'Bilinmeyen hata'}`;
  },

  async setSource(source) {
    if (source !== 'camera' && source !== 'gallery') return;
    if (source === 'camera' && !OCR.canUseCamera()) {
      OCR.source = 'gallery';
      OCR.stopCameraStream();
      OCR.renderWorkspace();
      return;
    }

    const previousSource = OCR.source;
    OCR.source = source;
    OCR.permissionMessage = '';
    OCR.capturePreview = '';
    OCR.processingStatus = OCR.isProcessingQueue ? 'processing' : 'idle';
    OCR.clearCaptureTimer(true);

    if (source === 'camera' && previousSource !== 'camera') {
      OCR.focusLockRequested = false;
      OCR.focusLockActive = false;
      OCR.focusSupported = false;
      OCR.focusPointSupported = false;
      OCR.focusTapSupported = false;
      OCR.lastFocusPoint = null;
      OCR.focusMarkerVisible = false;
      OCR.focusMarkerLocked = false;
      OCR.focusUnsupportedNotified = false;
      OCR.clearFocusMarkerTimer();
      OCR.unbindFocusGestures();
    }

    if (source === 'camera') {
      OCR.renderWorkspace();
      await OCR.startCamera();
      return;
    }

    OCR.stopCameraStream();
    OCR.renderWorkspace();
  },

  async startCamera() {
    const token = OCR.sessionToken;
    if (!OCR.canUseCamera()) {
      OCR.permissionMessage = window.isSecureContext
        ? 'Bu tarayıcı kamerayı desteklemiyor. Galeri modunu kullanın.'
        : 'Kamera için güvenli bağlantı gerekiyor. HTTPS adresini açın veya galeri modunu kullanın.';
      OCR.processingStatus = 'error';
      OCR.renderWorkspace();
      return;
    }

    OCR.stopCameraStream({ preserveFocusLock: true });
    OCR.permissionMessage = '';
    OCR.processingStatus = 'opening-camera';
    OCR.videoReady = false;
    OCR.focusUnsupportedNotified = false;
    OCR.renderWorkspace();

    const video = document.getElementById('cameraVideo');
    if (!video) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          façıngMode: { ideal: OCR.currentFaçıngMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });

      if (token !== OCR.sessionToken || OCR.source !== 'camera' || !OCR.isOverlayOpen()) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      OCR.cameraStream = stream;
      OCR.inspectFocusCapabilities(OCR.getCameraTrack(stream));
      video.dataset.façıngMode = OCR.currentFaçıngMode;
      video.srcObject = stream;

      let markedReady = false;
      const markReady = async () => {
        if (markedReady || token !== OCR.sessionToken || OCR.source !== 'camera') return;
        markedReady = true;
        try {
          await video.play();
        } catch (error) {
          // iOS may reject play() silently even though stream is usable.
        }
        OCR.videoReady = true;
        OCR.processingStatus = OCR.isProcessingQueue ? 'processing' : 'ready';
        OCR.permissionMessage = '';

        OCR.inspectFocusCapabilities(OCR.getCameraTrack());
        if (OCR.focusLockRequested && OCR.focusSupported) {
          await OCR.setFocusLock(true, OCR.lastFocusPoint || { x: 0.5, y: 0.5 }, {
            preserveRequested: true,
            suppressUnsupportedToast: true,
            suppressFailureToast: true,
            skipRender: true
          });
        }

        OCR.renderWorkspace();
      };

      video.onloadedmetadata = markReady;
      video.oncanplay = markReady;

      if (video.readyState >= 1) {
        markReady();
      }
    } catch (error) {
      if (token !== OCR.sessionToken) return;
      OCR.permissionMessage = OCR.humanizeCameraError(error);
      OCR.processingStatus = 'error';
      OCR.videoReady = false;
      OCR.renderWorkspace();
    }
  },

  async switchCamera() {

    OCR.currentFaçıngMode = OCR.currentFaçıngMode === 'environment' ? 'user' : 'environment';
    if (OCR.source === 'camera') {
      OCR.capturePreview = '';
      await OCR.startCamera();
    }
  },

  getScaledDimensions(width, height, maxSide) {
    if (!width || !height) return { width: 0, height: 0 };
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  },

  getMaxOcrImageDataLength() {
    return 8 * 1024 * 1024;
  },

  normalizeJpegQuality(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(0.95, Math.max(0.5, parsed));
  },

  isWithinOcrPayloadBudget(imageData, maxLength) {
    return String(imageData || '').length <= maxLength;
  },

  encodeCanvasAsJpeg(canvas, quality) {
    return canvas.toDataURL('image/jpeg', OCR.normalizeJpegQuality(quality, 0.84));
  },

  downscaleCanvas(sourceCanvas, scaleFactor) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceCanvas.width * scaleFactor));
    canvas.height = Math.max(1, Math.round(sourceCanvas.height * scaleFactor));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return sourceCanvas;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
    return canvas;
  },

  encodeCanvasWithPayloadBudget(baseCanvas, options) {
    const config = options || {};
    const maxLength = Number(config.maxPayloadLength) || OCR.getMaxOcrImageDataLength();
    const minQuality = OCR.normalizeJpegQuality(config.minQuality, 0.62);
    const qualityStep = 0.08;
    const minSide = 640;
    const scaleFactor = 0.86;

    let workingCanvas = baseCanvas;
    let fallbackImageData = OCR.encodeCanvasAsJpeg(workingCanvas, minQuality);

    while (true) {
      let quality = OCR.normalizeJpegQuality(config.jpegQuality, 0.84);
      while (quality >= minQuality - 0.0001) {
        const imageData = OCR.encodeCanvasAsJpeg(workingCanvas, quality);
        fallbackImageData = imageData;
        if (OCR.isWithinOcrPayloadBudget(imageData, maxLength)) {
          return {
            imageData,
            width: workingCanvas.width,
            height: workingCanvas.height
          };
        }
        quality = Number((quality - qualityStep).toFixed(2));
      }

      if (Math.max(workingCanvas.width, workingCanvas.height) <= minSide) {
        return {
          imageData: fallbackImageData,
          width: workingCanvas.width,
          height: workingCanvas.height
        };
      }

      const nextCanvas = OCR.downscaleCanvas(workingCanvas, scaleFactor);
      if (nextCanvas === workingCanvas) {
        return {
          imageData: fallbackImageData,
          width: workingCanvas.width,
          height: workingCanvas.height
        };
      }
      workingCanvas = nextCanvas;
    }
  },

  getImageProfile(sourceType) {
    if (sourceType === 'gallery') {
      return {
        maxSide: 1600,
        jpegQuality: 0.78,
        payloadGuard: true
      };
    }
    return {
      maxSide: 1600,
      jpegQuality: 0.78,
      payloadGuard: false
    };
  },

  buildImageFromSource(source, width, height, options) {
    const profile = options || {};
    const maxSide = Number(profile.maxSide) || 1600;
    const jpegQuality = OCR.normalizeJpegQuality(profile.jpegQuality, 0.84);
    const payloadGuard = profile.payloadGuard === true;
    const maxPayloadLength = Number(profile.maxPayloadLength) || OCR.getMaxOcrImageDataLength();
    const dims = OCR.getScaledDimensions(width, height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, dims.width, dims.height);
    const encoded = payloadGuard
      ? OCR.encodeCanvasWithPayloadBudget(canvas, { jpegQuality, maxPayloadLength })
      : { imageData: OCR.encodeCanvasAsJpeg(canvas, jpegQuality), width: dims.width, height: dims.height };
    const imageData = encoded.imageData;
    return {
      imageData,
      previewUrl: imageData,
      width: encoded.width,
      height: encoded.height
    };
  },

  captureFrame() {
    if (OCR.source !== 'camera') return;
    if (!OCR.videoReady || (OCR.mode === 'single' && OCR.capturePreview) || OCR.processingStatus === 'opening-camera' || OCR.processingStatus === 'capturing') {
      return;
    }

    OCR.clearCaptureTimer(false);
    OCR.processingStatus = 'capturing';
    OCR.captureDelayPending = OCR.focusLockActive;
    OCR.renderWorkspace();

    const executeCapture = async () => {
      OCR.captureTimerId = null;
      OCR.captureDelayPending = false;

      if (OCR.source !== 'camera' || OCR.processingStatus !== 'capturing' || (OCR.mode === 'single' && OCR.capturePreview)) {
        OCR.processingStatus = OCR.videoReady ? 'ready' : 'opening-camera';
        OCR.renderWorkspace();
        return;
      }

      if (OCR.focusLockActive && OCR.lastFocusPoint) {
        await OCR.setFocusLock(true, OCR.lastFocusPoint, {
          preserveRequested: true,
          suppressFailureToast: true,
          skipRender: true
        });
        await OCR.delay(120);

        if (OCR.source !== 'camera' || OCR.processingStatus !== 'capturing' || (OCR.mode === 'single' && OCR.capturePreview)) {
          OCR.processingStatus = OCR.videoReady ? 'ready' : 'opening-camera';
          OCR.renderWorkspace();
          return;
        }
      }

      const video = document.getElementById('cameraVideo');
      const canvas = document.getElementById('cameraCanvas');
      if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
        OCR.permissionMessage = 'Canlı önizleme hazır olmadan çekim yapılamadı. Biraz daha bekleyin.';
        OCR.processingStatus = OCR.videoReady ? 'ready' : 'opening-camera';
        OCR.renderWorkspace();
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(video, 0, 0);

      const prepared = OCR.buildImageFromSource(canvas, canvas.width, canvas.height, OCR.getImageProfile('camera'));
      if (OCR.mode === 'single') {
        OCR.capturePreview = prepared.previewUrl;
        OCR.queueItems = [];
      } else {
        OCR.capturePreview = '';
      }

      OCR.createQueueItem(prepared, 'camera', '');
      OCR.processingStatus = 'processing';
      OCR.renderWorkspace();
      OCR.processQueue();
    };

    if (OCR.focusLockActive) {
      OCR.captureTimerId = window.setTimeout(() => {
        void executeCapture();
      }, OCR.focusCaptureDelayMs);
      return;
    }

    void executeCapture();
  },

  retryCapture() {
    OCR.clearCaptureTimer(true);
    OCR.capturePreview = '';
    OCR.permissionMessage = '';
    if (OCR.source === 'camera') {
      OCR.processingStatus = OCR.videoReady ? 'ready' : 'opening-camera';
      if (!OCR.cameraStream) {
        OCR.startCamera();
        return;
      }
      if (OCR.focusLockRequested && OCR.focusSupported) {
        OCR.setFocusLock(true, OCR.lastFocusPoint || { x: 0.5, y: 0.5 }, {
          preserveRequested: true,
          suppressFailureToast: true
        });
      }
    }
    OCR.renderWorkspace();
  },

  openFilePicker() {

    const input = document.getElementById('ocrFileInput');
    if (!input) return;
    input.multiple = OCR.mode !== 'single';
    input.click();
  },

  loadImageElement(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Fotoğraf yüklenemedi'));
      img.src = url;
    });
  },

  async prepareFileImage(file) {
    if (!file.type.startsWith('image/')) {
      throw new Error('Yalnızca görsel dosyaları destekleniyor');
    }
    if (file.size > 25 * 1024 * 1024) {
      throw new Error('Dosya çok büyük. Lütfen daha küçük bir fotoğraf seçin');
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await OCR.loadImageElement(objectUrl);
      return OCR.buildImageFromSource(
        img,
        img.naturalWidth || img.width,
        img.naturalHeight || img.height,
        OCR.getImageProfile('gallery')
      );
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  },

  async handleFileInput(event) {
    const input = event?.target;
    const token = OCR.sessionToken;
    const files = Array.from(input?.files || []);
    if (input) input.value = '';
    if (!files.length) return;

    let selectedFiles = files;
    if (OCR.mode === 'single') {
      selectedFiles = files.slice(0, 1);
      if (files.length > 1) {
        App.showToast('Tekli metin tanıma modunda yalnızca ilk fotoğraf kullanıldı');
      }
    } else if (files.length > 12) {
      selectedFiles = files.slice(0, 12);
      App.showToast('Performans için ilk 12 fotoğraf kuyruğa alındı');
    }

    if (OCR.mode === 'single') {
      OCR.queueItems = [];
      OCR.capturePreview = '';
    }

    let addedCount = 0;
    OCR.processingStatus = OCR.isProcessingQueue ? 'processing' : OCR.processingStatus;

    for (const file of selectedFiles) {
      if (token !== OCR.sessionToken) return;
      try {
        const prepared = await OCR.prepareFileImage(file);
        OCR.createQueueItem(prepared, 'gallery', file.name || '');
        addedCount += 1;
      } catch (error) {
        App.showToast(error.message || 'Fotoğraf hazırlanamadı');
      }
    }

    OCR.renderWorkspace();

    if (addedCount) {
      OCR.processQueue();
      App.showToast(`${addedCount} fotoğraf metin tanıma kuyruğuna eklendi`);
    }
  },

  createQueueItem(prepared, source, fileName) {
    const item = {
      id: OCR.nextQueueId++,
      source,
      fileName: fileName || '',
      previewUrl: prepared.previewUrl,
      imageData: prepared.imageData,
      qty: 1,
      collapsed: false,
      status: 'queued',
      error: '',
      result: null,
      fields: OCR.createEmptyFields('disk')
    };
    OCR.queueItems.push(item);
    return item;
  },

  async processQueue() {
    if (OCR.isProcessingQueue) return;
    OCR.isProcessingQueue = true;
    OCR.processingStatus = 'processing';
    OCR.renderWorkspace();

    const token = OCR.sessionToken;

    const QUEUE_CONCURRENCY = 3;

    try {
      while (token === OCR.sessionToken) {
        const queued = OCR.queueItems.filter(item => item.status === 'queued');
        if (!queued.length) break;
        const batch = queued.slice(0, QUEUE_CONCURRENCY);
        await Promise.all(batch.map(item => OCR.processItem(item, token)));
      }
    } finally {
      if (token === OCR.sessionToken) {
        OCR.isProcessingQueue = false;
        OCR.processingStatus = OCR.capturePreview
          ? 'captured'
          : (OCR.videoReady ? 'ready' : 'idle');
        OCR.renderWorkspace();
      }
    }
  },

  getMeaningfulKeysForType(hardwareType) {
    const type = OCR.normalizeHardwareType(hardwareType);
    if (type === 'ram') return ['manufacturer', 'capacity', 'memoryType', 'speed', 'rank', 'partNumber'];
    if (type === 'nic') return ['manufacturer', 'model', 'speed', 'ports', 'interface', 'serial', 'partNumber'];
    if (type === 'cpu') return ['manufacturer', 'model', 'frequency', 'cores', 'socket', 'partNumber'];
    return ['manufacturer', 'model', 'capacity', 'serial', 'rpm', 'formFactor'];
  },

  getComponentSignalCount(result) {
    const keys = OCR.getMeaningfulKeysForType(result?.hardwareType);
    return keys.reduce((total, key) => total + (String(result?.[key] || '').trim() ? 1 : 0), 0);
  },

  getRetrySignalThreshold(hardwareType) {
    const type = OCR.normalizeHardwareType(hardwareType);
    if (type === 'nic') return 3;
    if (type === 'cpu') return 3;
    if (type === 'ram') return 3;
    return 3;
  },

  getServerLabelOverrideSignalThreshold(hardwareType) {
    const type = OCR.normalizeHardwareType(hardwareType);
    if (type === 'nic') return 4;
    if (type === 'cpu') return 4;
    if (type === 'ram') return 4;
    return 4;
  },

  isWeakComponentResult(result) {
    return OCR.getComponentSignalCount(result) === 0;
  },

  isLowConfidenceComponentResult(result) {
    return OCR.getComponentSignalCount(result) < OCR.getRetrySignalThreshold(result?.hardwareType);
  },

  isConfidentComponentResult(result) {
    return !OCR.isLowConfidenceComponentResult(result);
  },

  normalizeResultPayload(result) {
    const normalized = { ...(result || {}) };
    normalized.hardwareType = OCR.normalizeHardwareType(normalized.hardwareType);
    const declaredResultKind = OCR.getResultKind(normalized.resultKind || normalized.result_kind);
    const candidateServerLabel = [
      normalized.serverLabel,
      normalized.server_label,
      normalized.serverTag,
      normalized.server_tag,
      normalized.assetTag,
      normalized.asset_tag,
      normalized.label,
      normalized.tag
    ]
      .map(value => OCR.normalizeServerLabel(value))
      .find(value => OCR.isValidServerLabel(value)) || '';
    const candidateServiceTag = [
      normalized.serviceTag,
      normalized.service_tag,
      normalized.servicetag
    ]
      .map(value => OCR.normalizeServerLabel(value))
      .find(value => OCR.isValidServerLabel(value)) || '';
    normalized.serverLabel = OCR.isValidServerLabel(candidateServerLabel) ? candidateServerLabel : '';
    normalized.serviceTag = OCR.isValidServerLabel(candidateServiceTag) ? candidateServiceTag : '';
    const weakComponent = OCR.isWeakComponentResult(normalized);
    const hasServerLabel = !!normalized.serverLabel;
    const hasServiceTag = !!normalized.serviceTag;
    const shouldTreatAsServerLabel = hasServiceTag || (hasServerLabel && (declaredResultKind === 'server_label' || weakComponent));
    normalized.resultKind = shouldTreatAsServerLabel
      ? 'server_label'
      : 'component';
    return normalized;
  },

  shouldRunSmartRetry(result) {
    const normalized = OCR.normalizeResultPayload(result);
    return OCR.isLowConfidenceComponentResult(normalized);
  },

  pickBetterResult(currentResult, candidateResult) {
    const current = OCR.normalizeResultPayload(currentResult);
    const candidate = OCR.normalizeResultPayload(candidateResult);
    const currentSignalCount = OCR.getComponentSignalCount(current);
    const candidateSignalCount = OCR.getComponentSignalCount(candidate);
    const currentHasDeviceTag = OCR.isValidServerLabel(current.serverLabel) || OCR.isValidServerLabel(current.serviceTag);
    const candidateHasDeviceTag = OCR.isValidServerLabel(candidate.serverLabel) || OCR.isValidServerLabel(candidate.serviceTag);
    const currentIsServerLabel = OCR.getResultKind(current.resultKind) === 'server_label' && currentHasDeviceTag;
    const candidateIsServerLabel = OCR.getResultKind(candidate.resultKind) === 'server_label' && candidateHasDeviceTag;
    if (candidateIsServerLabel && !currentIsServerLabel) {
      const overrideThreshold = OCR.getServerLabelOverrideSignalThreshold(current.hardwareType);
      if (currentSignalCount >= overrideThreshold) return current;
      return candidate;
    }
    if (currentIsServerLabel && !candidateIsServerLabel) {
      const overrideThreshold = OCR.getServerLabelOverrideSignalThreshold(candidate.hardwareType);
      if (candidateSignalCount >= overrideThreshold) return candidate;
      return current;
    }

    if (candidateSignalCount > currentSignalCount) {
      return candidate;
    }
    return current;
  },

  isTransientOcrError(error) {
    const status = Number(error?.status);
    if (Number.isFinite(status)) {
      return status === 429 || status >= 500;
    }

    if (error?.name === 'AbortError') return true;
    if (error instanceof TypeError) return true;

    const message = String(error?.message || '').toLowerCase();
    return message.includes('network')
      || message.includes('fetch')
      || message.includes('timeout')
      || message.includes('failed to');
  },

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  getOcrErrorCode(error) {
    return String(error?.code || '').trim();
  },

  humanizeOcrError(error, context) {
    const mode = context || 'card';
    const code = OCR.getOcrErrorCode(error);
    const providerStatus = Number(error?.providerStatus);
    const rawMessage = String(error?.message || '').trim();
    const lower = rawMessage.toLowerCase();

    const isRateLimit = code === 'ocr_provider_rate_limited'
      || providerStatus === 429
      || lower.includes('429')
      || lower.includes('kota')
      || lower.includes('quota')
      || lower.includes('rate limit');
    if (isRateLimit) {
      return mode === 'toast'
        ? 'OCR kotası doldu (429). API limitine ulaşıldı, biraz sonra tekrar deneyin.'
        : 'OCR kotası doldu (429). Biraz sonra tekrar deneyin.';
    }

    const isProviderUnreachable = code === 'ocr_provider_unreachable'
      || lower.includes('network')
      || lower.includes('fetch')
      || lower.includes('timeout');
    if (isProviderUnreachable) {
      return mode === 'toast'
        ? 'OCR servisine ulaşılamadı. İnternet/proxy bağlantısını kontrol edin ve tekrar deneyin.'
        : 'OCR servisine ulaşılamadı. İnternet/proxy bağlantısını kontrol edin.';
    }

    const isProviderError = code === 'ocr_provider_error'
      || Number.isFinite(providerStatus)
      || lower.includes('ai api hatası');
    if (isProviderError) {
      const statusText = Number.isFinite(providerStatus)
        ? ` (${providerStatus})`
        : '';
      return mode === 'toast'
        ? `OCR sağlayıcısı hata verdi${statusText}. Biraz sonra tekrar deneyin.`
        : `OCR sağlayıcısı hata verdi${statusText}.`;
    }

    if (code === 'ocr_config_missing') {
      return mode === 'toast'
        ? 'OCR yapılandırması eksik. AI API anahtarları tanımlı değil.'
        : 'OCR yapılandırması eksik (API anahtarı tanımlı değil).';
    }

    if (code === 'ocr_request_invalid') {
      return 'OCR isteği geçersiz görsel verisi içeriyor.';
    }

    return rawMessage || 'Metin tanıma işlenemedi';
  },

  notifyOcrError(error) {
    const message = OCR.humanizeOcrError(error, 'toast');
    if (!message) return;
    const code = OCR.getOcrErrorCode(error) || 'generic';
    const now = Date.now();
    const key = `${code}:${message}`;
    const isDuplicate = OCR.lastErrorNoticeKey === key && (now - OCR.lastErrorNoticeAt) < 12000;
    if (isDuplicate) return;
    OCR.lastErrorNoticeKey = key;
    OCR.lastErrorNoticeAt = now;
    App.showToast(message);
  },

  async callOcrApiOnce(imageData) {
    const t0 = performance.now();
    const response = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const error = new Error(err.error || `Sunucu hatası: ${response.status}`);
      error.status = response.status;
      error.code = err.code || '';
      error.providerStatus = Number(err.providerStatus || err.provider_status || NaN);
      throw error;
    }

    const result = await response.json();
    console.log(`[OCR] API call: ${Math.round(performance.now() - t0)}ms`);
    return result;
  },

  async callOcrApi(imageData) {
    const safeImageData = await OCR.ensureImageDataWithinPayloadBudget(imageData);
    const maxAttempts = 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await OCR.callOcrApiOnce(safeImageData);
      } catch (error) {
        if (OCR.getOcrErrorCode(error) === 'ocr_provider_rate_limited') {
          throw error;
        }
        const isLastAttempt = attempt >= maxAttempts - 1;
        if (isLastAttempt || !OCR.isTransientOcrError(error)) throw error;
        await OCR.delay(350 * (attempt + 1));
      }
    }
    throw new Error('Metin tanıma isteği tamamlanamadı');
  },

  normalizeRotation(value) {
    const rotation = ((Number(value) % 360) + 360) % 360;
    return [0, 90, 180, 270].includes(rotation) ? rotation : 0;
  },

  createTransformedCanvasFromImage(img, options) {
    const config = options || {};
    const sourceWidth = img.naturalWidth || img.width;
    const sourceHeight = img.naturalHeight || img.height;
    if (!sourceWidth || !sourceHeight) return null;

    const rotation = OCR.normalizeRotation(config.rotation || 0);
    const swapSides = rotation === 90 || rotation === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swapSides ? sourceHeight : sourceWidth;
    canvas.height = swapSides ? sourceWidth : sourceHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (config.enhance) {
      ctx.filter = 'grayscale(100%) contrast(165%) brightness(112%)';
    }

    if (rotation === 90) {
      ctx.translate(canvas.width, 0);
    } else if (rotation === 180) {
      ctx.translate(canvas.width, canvas.height);
    } else if (rotation === 270) {
      ctx.translate(0, canvas.height);
    }
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(img, 0, 0);
    ctx.filter = 'none';
    return canvas;
  },

  buildImageDataFromElement(img, options) {
    const config = options || {};
    const canvas = OCR.createTransformedCanvasFromImage(img, config);
    if (!canvas) return '';
    if (config.payloadGuard) {
      return OCR.encodeCanvasWithPayloadBudget(canvas, {
        jpegQuality: OCR.normalizeJpegQuality(config.jpegQuality, 0.86),
        maxPayloadLength: Number(config.maxPayloadLength) || OCR.getMaxOcrImageDataLength()
      }).imageData;
    }
    return OCR.encodeCanvasAsJpeg(canvas, OCR.normalizeJpegQuality(config.jpegQuality, 0.86));
  },

  async ensureImageDataWithinPayloadBudget(imageData) {
    const maxPayloadLength = OCR.getMaxOcrImageDataLength();
    if (OCR.isWithinOcrPayloadBudget(imageData, maxPayloadLength)) return imageData;

    try {
      const img = await OCR.loadImageElement(imageData);
      const compressed = OCR.buildImageDataFromElement(img, {
        rotation: 0,
        enhance: false,
        jpegQuality: 0.86,
        payloadGuard: true,
        maxPayloadLength
      });
      return compressed || imageData;
    } catch (error) {
      return imageData;
    }
  },

  async buildRetryImageVariants(imageData) {
    const variants = [];
    const seen = new Set([imageData]);
    const maxPayloadLength = OCR.getMaxOcrImageDataLength();
    const steps = [
      { enhance: true, rotation: 0 },
      { enhance: true, rotation: 90 }
    ];

    try {
      const img = await OCR.loadImageElement(imageData);
      for (const step of steps) {
        const variant = OCR.buildImageDataFromElement(img, {
          ...step,
          jpegQuality: 0.88,
          payloadGuard: true,
          maxPayloadLength
        });
        if (!variant || seen.has(variant)) continue;
        seen.add(variant);
        variants.push(variant);
      }
    } catch (error) {
      // Ignore preprocessing failure and continue with original image retry.
    }

    return variants;
  },

  async processItem(item, token) {
    item.status = 'processing';
    item.error = '';
    OCR.renderWorkspace();
    const itemStart = performance.now();
    const readyCountBefore = OCR.queueItems.reduce((total, queuedItem) => (
      total + (queuedItem.status === 'ready' ? 1 : 0)
    ), 0);

    try {
      const firstResult = OCR.normalizeResultPayload(await OCR.callOcrApi(item.imageData));
      if (token !== OCR.sessionToken) return;

      let result = firstResult;

      if (OCR.shouldRunSmartRetry(firstResult)) {
        if (token !== OCR.sessionToken) return;
        const retryImages = await OCR.buildRetryImageVariants(item.imageData);
        // Fire retry variants in parallel (no duplicate of original image)
        const retryResults = await Promise.allSettled(
          retryImages.map(img => OCR.callOcrApi(img))
        );
        if (token !== OCR.sessionToken) return;
        for (const settled of retryResults) {
          if (settled.status === 'fulfilled') {
            result = OCR.pickBetterResult(result, settled.value);
          }
        }
      }

      const retried = result !== firstResult;
      console.log(`[OCR] processItem done: ${Math.round(performance.now() - itemStart)}ms (retried=${retried}, signals=${OCR.getComponentSignalCount(result)})`);

      item.result = result;
      item.fields = OCR.buildFieldsFromResult(result);
      item.status = 'ready';
      item.error = '';

      // Auto-open queue sheet on mobile when first item is ready
      if (OCR.isMobileSheet() && readyCountBefore === 0 && !OCR.queueSheetDismissed) {
        const panel = document.getElementById('ocrQueuePanel') || document.querySelector('.ocr-queue-panel');
        if (panel) panel.classList.add('is-sheet-open');
      }
    } catch (error) {
      if (token !== OCR.sessionToken) return;
      item.status = 'error';
      item.error = OCR.humanizeOcrError(error, 'card');
      OCR.notifyOcrError(error);
    }

    OCR.renderWorkspace();
  },

  getFieldDefinitions(hardwareType) {
    const type = OCR.normalizeHardwareType(hardwareType);
    if (type === 'ram') {
      return [
        ['Üretici', 'manufacturer'],
        ['Kapasite', 'capacity'],
        ['Bellek Tipi', 'memoryType'],
        ['Hız', 'speed'],
        ['Rank', 'rank'],
        ['Parça No', 'partNumber']
      ];
    }
    if (type === 'nic') {
      return [
        ['Üretici', 'manufacturer'],
        ['Model', 'model'],
        ['Hız', 'speed'],
        ['Port', 'ports'],
        ['Arayüz', 'interface'],
        ['Seri No', 'serial'],
        ['Parça No', 'partNumber']
      ];
    }
    if (type === 'cpu') {
      return [
        ['Üretici', 'manufacturer'],
        ['Model', 'model'],
        ['Frekans', 'frequency'],
        ['Çekirdek', 'cores'],
        ['Soket', 'socket'],
        ['Parça No', 'partNumber']
      ];
    }
    return [
      ['Üretici', 'manufacturer'],
      ['Model', 'model'],
      ['Kapasite', 'capacity'],
      ['Seri No', 'serial'],
      ['RPM', 'rpm'],
      ['Form Faktörü', 'formFactor']
    ];
  },

  getItemById(id) {
    return OCR.queueItems.find(item => item.id === Number(id));
  },

  updateItemField(id, key, value) {
    const item = OCR.getItemById(id);
    if (!item || !item.fields) return;
    if (key === 'hardwareType') {
      item.fields.hardwareType = OCR.normalizeHardwareType(value);
    } else if (key === 'serverLabel') {
      item.fields.serverLabel = OCR.normalizeServerLabel(value);
    } else {
      item.fields[key] = value;
    }
    OCR.renderWorkspace();
  },

  updateItemQty(id, value) {
    const item = OCR.getItemById(id);
    if (!item) return;
    item.qty = OCR.normalizeQty(value);
    OCR.renderWorkspace();
  },

  toggleItemCollapse(id) {
    const item = OCR.getItemById(id);
    if (!item) return;
    item.collapsed = !item.collapsed;
    OCR.renderWorkspace();
  },

  retryItem(id) {
    const item = OCR.getItemById(id);
    if (!item || item.status === 'processing') return;
    item.status = 'queued';
    item.qty = OCR.normalizeQty(item.qty);
    item.collapsed = false;
    item.error = '';
    item.result = null;
    item.fields = OCR.createEmptyFields(item.fields?.hardwareType || 'disk');
    if (item.source === 'camera' && OCR.mode === 'single') {
      OCR.capturePreview = item.previewUrl;
    }
    OCR.renderWorkspace();
    OCR.processQueue();
  },

  deleteItem(id) {
    const item = OCR.getItemById(id);
    if (!item || item.status === 'processing') return;

    if (OCR.mode === 'single') {
      OCR.queueItems = [];
      OCR.capturePreview = '';
      OCR.renderWorkspace();
      if (OCR.source === 'camera' && OCR.canUseCamera()) {
        OCR.retryCapture();
      }
      return;
    }

    OCR.queueItems = OCR.queueItems.filter(queueItem => queueItem.id !== item.id);

    if (OCR.source === 'camera' && OCR.capturePreview && item.previewUrl === OCR.capturePreview) {
      OCR.retryCapture();
      return;
    }

    OCR.renderWorkspace();
  },

  skipItem(id) {
    OCR.deleteItem(id);
  },

  exitCardView() {
    OCR.closeQueueSheet();
    if (OCR.mode === 'batch' && OCR.source === 'camera' && OCR.capturePreview) {
      OCR.retryCapture();
    }
  },

  getItemValues(item) {
    const fields = item?.fields || OCR.createEmptyFields('disk');
    return {
      hardwareType: OCR.normalizeHardwareType(fields.hardwareType),
      serverLabel: OCR.normalizeServerLabel(fields.serverLabel),
      serviceTag: OCR.normalizeServerLabel(fields.serviceTag),
      manufacturer: fields.manufacturer?.trim() || '',
      model: fields.model?.trim() || '',
      capacity: fields.capacity?.trim() || '',
      serial: fields.serial?.trim() || '',
      rpm: fields.rpm?.trim() || '',
      formFactor: fields.formFactor?.trim() || '',
      memoryType: fields.memoryType?.trim() || '',
      speed: fields.speed?.trim() || '',
      rank: fields.rank?.trim() || '',
      partNumber: fields.partNumber?.trim() || '',
      frequency: fields.frequency?.trim() || '',
      cores: fields.cores?.trim() || '',
      socket: fields.socket?.trim() || '',
      ports: fields.ports?.trim() || '',
      interface: fields.interface?.trim() || ''
    };
  },

  inventoryMatchCompatible(match, hardwareType) {
    if (!match?.category) return true;
    const category = String(match.category).toUpperCase();
    if (hardwareType === 'disk') return category.includes('DISK') || category.includes('SSD') || category.includes('HDD') || category.includes('NVME') || category.includes('SAS');
    if (hardwareType === 'ram') return category.includes('RAM') || category.includes('MEMORY') || category.includes('DIMM');
    if (hardwareType === 'nic') return category.includes('NIC') || category.includes('NETWORK') || category.includes('ETHERNET') || category.includes('ADAPTER');
    if (hardwareType === 'cpu') return category.includes('CPU') || category.includes('PROCESSOR') || category.includes('XEON');
    return true;
  },

  normalizeNameWhitespace(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  },

  decodeHtmlEntities(value) {
    return String(value || '')
      .replace(/&quot;|&#34;/gi, '"')
      .replace(/&apos;|&#39;/gi, '\'')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
  },

  formatCompactNumber(value, maxDecimals = 1) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    const fixed = numeric.toFixed(maxDecimals);
    return fixed.replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
  },

  normalizeCapacityToken(value) {
    const text = OCR.normalizeNameWhitespace(value).toUpperCase().replace(',', '.');
    const match = text.match(/(\d+(?:\.\d+)?)\s*(TB|GB)/);
    if (!match) return '';
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return '';
    return `${OCR.formatCompactNumber(amount, 2)}${match[2]}`;
  },

  normalizeDiskRpmToken(value) {
    const text = OCR.normalizeNameWhitespace(value).toUpperCase().replace(',', '.');
    if (!text) return '';

    const kMatch = text.match(/(\d+(?:\.\d+)?)\s*K(?:\s*RPM)?\b/);
    if (kMatch) {
      return `${OCR.formatCompactNumber(kMatch[1], 1)}K`;
    }

    const rpmMatch = text.match(/(\d{4,5})(?:\s*RPM)?\b/);
    if (!rpmMatch) return '';

    const rpm = Number(rpmMatch[1]);
    if (!Number.isFinite(rpm) || rpm < 3600 || rpm > 20000) return '';
    return `${OCR.formatCompactNumber(rpm / 1000, 1)}K`;
  },

  normalizeDiskFormFactorToken(value) {
    const text = OCR.normalizeNameWhitespace(value).toUpperCase().replace(/&QUOT;/g, '"');
    if (/2(?:[.,]5)/.test(text)) return '2.5"';
    if (/3(?:[.,]5)/.test(text)) return '3.5"';
    return '';
  },

  normalizeDiskBusToken(value) {
    const text = OCR.normalizeNameWhitespace(value).toUpperCase();
    if (!text) return '';
    if (/\bNVME\b|\bNVM[\s-]?E\b/.test(text)) return 'NVME';
    if (/\bSATA\b/.test(text)) return 'SATA';
    if (/\bSAS\b/.test(text)) return 'SAS';
    if (/\bSSD\b/.test(text)) return 'SSD';
    return '';
  },

  inferDiskBusFromModelCode(value) {
    const model = OCR.normalizeNameWhitespace(value);
    if (!model || !OCR.looksOpaquePartCode(model)) return '';
    const compact = model.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (!compact) return '';
    return compact.endsWith('SS') ? 'SAS' : '';
  },

  looksOpaquePartCode(value) {
    const text = OCR.normalizeNameWhitespace(value);
    if (!text) return false;

    const compact = text.replace(/[^A-Z0-9]/gi, '');
    if (compact.length < 8) return false;

    const hasLetters = /[A-Z]/i.test(compact);
    const hasDigits = /\d/.test(compact);
    if (!hasLetters || !hasDigits) return false;

    const words = text.split(/\s+/);
    if (words.length === 1) return true;
    return words.length <= 2 && /[-_/]/.test(text) && compact.length >= 10;
  },

  joinUniqueTokens(tokens) {
    const seen = new Set();
    const parts = [];
    tokens.forEach((token) => {
      const value = OCR.normalizeNameWhitespace(token);
      if (!value) return;
      const key = value.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      parts.push(value);
    });
    return parts;
  },

  extractDiskBusToken(vals, ocrResult) {
    const directBus = [vals?.interface, ocrResult?.interface]
      .map(value => OCR.normalizeDiskBusToken(value))
      .find(Boolean);
    if (directBus) return directBus;

    const rawText = [vals?.model, vals?.partNumber, ocrResult?.model, ocrResult?.partNumber, ocrResult?.raw]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
    if (rawText) {
      const tokenizedBus = OCR.normalizeDiskBusToken(rawText);
      if (tokenizedBus) return tokenizedBus;
    }

    return OCR.inferDiskBusFromModelCode(vals?.model)
      || OCR.inferDiskBusFromModelCode(ocrResult?.model)
      || '';
  },

  cleanDiskModelForFallback(model, capacityToken) {
    let text = OCR.normalizeNameWhitespace(model);
    if (!text || OCR.looksOpaquePartCode(text)) return '';
    text = text
      .replace(/\b(NVME|NVM-E|SATA|SAS|SSD|HDD)\b/gi, ' ')
      .replace(/\b\d+(?:[.,]\d+)?\s*(TB|GB)\b/gi, ' ')
      .replace(/\b[23](?:[.,]5)"?\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    if (capacityToken && text.toUpperCase().includes(capacityToken.toUpperCase())) {
      return '';
    }
    return text;
  },

  normalizeRamRankToken(value) {
    const raw = OCR.normalizeNameWhitespace(value).replace(/\s+/g, '');
    if (!raw) return '';
    const dualMatch = raw.match(/^(\d+)DR[Xx](\d+)$/i);
    if (dualMatch) return `${dualMatch[1]}DRx${dualMatch[2]}`;
    const rankMatch = raw.match(/^(\d+)R[Xx](\d+)$/i);
    if (rankMatch) return `${rankMatch[1]}Rx${rankMatch[2]}`;
    return raw.toUpperCase();
  },

  buildDiskFallbackName(vals, ocrResult) {
    const manufacturer = OCR.normalizeNameWhitespace(vals.manufacturer);
    const capacity = OCR.normalizeCapacityToken(vals.capacity);
    const rpm = OCR.normalizeDiskRpmToken(vals.rpm);
    const bus = OCR.extractDiskBusToken(vals, ocrResult);
    const formFactor = OCR.normalizeDiskFormFactorToken(vals.formFactor);
    const rawModel = OCR.normalizeNameWhitespace(vals.model);
    const descriptiveModel = OCR.cleanDiskModelForFallback(rawModel, capacity);
    const fallbackModel = rawModel || OCR.normalizeNameWhitespace(vals.partNumber);

    const parts = OCR.joinUniqueTokens([manufacturer, capacity, rpm, bus, formFactor]);
    if (descriptiveModel && !parts.some(part => part.toUpperCase() === descriptiveModel.toUpperCase())) {
      parts.push(descriptiveModel);
    }

    const name = OCR.normalizeNameWhitespace(parts.join(' '));
    return name || fallbackModel;
  },

  buildRamFallbackName(vals) {
    const capacity = OCR.normalizeCapacityToken(vals.capacity);
    const memoryType = OCR.normalizeNameWhitespace(vals.memoryType).toUpperCase();
    const rank = OCR.normalizeRamRankToken(vals.rank);
    const speed = OCR.normalizeNameWhitespace(vals.speed).replace(/\s+/g, '').toUpperCase();
    const structured = OCR.normalizeNameWhitespace([capacity, memoryType, rank, speed].filter(Boolean).join(' '));
    if (structured) return structured;

    const manufacturer = OCR.normalizeNameWhitespace(vals.manufacturer);
    const model = OCR.normalizeNameWhitespace(vals.model);
    const partNumber = OCR.normalizeNameWhitespace(vals.partNumber);
    const preferredCode = (!OCR.looksOpaquePartCode(model) && model) || partNumber || model;
    return OCR.normalizeNameWhitespace([manufacturer, preferredCode].filter(Boolean).join(' '));
  },

  buildNicFallbackName(vals) {
    const manufacturer = OCR.normalizeNameWhitespace(vals.manufacturer);
    const model = OCR.normalizeNameWhitespace(vals.model);
    const speed = OCR.normalizeNameWhitespace(vals.speed);
    const ports = OCR.normalizeNameWhitespace(vals.ports);
    const interfaceLabel = OCR.normalizeNameWhitespace(vals.interface);
    const partNumber = OCR.normalizeNameWhitespace(vals.partNumber);

    let name = OCR.normalizeNameWhitespace([manufacturer, model, speed, ports].filter(Boolean).join(' '));
    if (!name) {
      name = OCR.normalizeNameWhitespace([manufacturer, model, interfaceLabel, partNumber].filter(Boolean).join(' '));
    }
    if (!name) return '';
    if (!/\b(NIC|ADAPTER)\b/i.test(name)) {
      name = OCR.normalizeNameWhitespace(`${name} NIC`);
    }
    return name;
  },

  buildCpuFallbackName(vals) {
    const manufacturer = OCR.normalizeNameWhitespace(vals.manufacturer);
    const model = OCR.normalizeNameWhitespace(vals.model);
    if (model && manufacturer) {
      if (model.toUpperCase().includes(manufacturer.toUpperCase())) return model;
      return OCR.normalizeNameWhitespace(`${manufacturer} ${model}`);
    }
    if (model) return model;
    return OCR.normalizeNameWhitespace(
      [manufacturer, OCR.normalizeNameWhitespace(vals.frequency), OCR.normalizeNameWhitespace(vals.cores), OCR.normalizeNameWhitespace(vals.partNumber)]
        .filter(Boolean)
        .join(' ')
    );
  },

  buildComponentName(hardwareType, vals, inventoryMatch, ocrResult) {
    if (inventoryMatch?.source === 'components' && inventoryMatch.name && OCR.inventoryMatchCompatible(inventoryMatch, hardwareType)) {
      return OCR.normalizeNameWhitespace(OCR.decodeHtmlEntities(inventoryMatch.name));
    }

    if (hardwareType === 'ram') {
      return OCR.buildRamFallbackName(vals);
    }

    if (hardwareType === 'nic') {
      return OCR.buildNicFallbackName(vals);
    }

    if (hardwareType === 'cpu') {
      return OCR.buildCpuFallbackName(vals);
    }

    return OCR.buildDiskFallbackName(vals, ocrResult);
  },

  normalizeQty(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return parsed;
  },

  normalizeMergeName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
  },

  getComponentMergeName(component) {
    if (!component) return '';
    if (component.name) return OCR.normalizeMergeName(component.name);
    if (Array.isArray(component.units) && component.units.length > 0) {
      return OCR.normalizeMergeName(component.units[0]?.name || '');
    }
    return '';
  },

  resolveDestinationBucket(di, destination) {
    const device = OCR.getDevice(di);
    if (!device) return null;
    const normalizedDestination = OCR.normalizeDestination(di, destination);
    if (normalizedDestination === 'takilan' && !device.componentsOnly) {
      return { destination: 'takilan', list: device.takilanComponents };
    }
    return { destination: 'comp', list: device.components };
  },

  buildUnitsForMulti(name, serial, qty) {
    const normalizedQty = OCR.normalizeQty(qty);
    return Array.from({ length: normalizedQty }, (_, index) => ({
      name: name || '',
      serial: index === 0 ? (serial || '') : '',
      health: ''
    }));
  },

  upsertBatchComponent(di, destination, componentData) {
    const bucket = OCR.resolveDestinationBucket(di, destination);
    if (!bucket) return;

    const list = bucket.list;
    const qty = OCR.normalizeQty(componentData?.qty);
    const type = componentData?.type || 'DISK';
    const name = (componentData?.name || '').trim();
    const serial = (componentData?.serial || '').trim();
    const mergeName = OCR.normalizeMergeName(name);

    let mergeIndex = -1;
    if (mergeName) {
      mergeIndex = list.findIndex((component) =>
        component?.type === type && OCR.getComponentMergeName(component) === mergeName
      );
    }

    if (mergeIndex < 0) {
      list.push(Components.makeComp({ type, qty, name, serial }));
    } else {
      const target = list[mergeIndex];
      const currentQty = OCR.normalizeQty(target.qty || (Array.isArray(target.units) ? target.units.length : 1));
      target.qty = currentQty + qty;

      if (!target.name && name) target.name = name;
      if (!target.serial && serial) target.serial = serial;

      if (MULTI_TYPES.has(target.type)) {
        if (!Array.isArray(target.units)) target.units = [];
        target.units.push(...OCR.buildUnitsForMulti(name || target.name, serial, qty));

        while (target.units.length < target.qty) {
          target.units.push({ name: name || target.name || '', serial: '', health: '' });
        }
        if (target.units.length > target.qty) {
          target.units = target.units.slice(0, target.qty);
        }
      }
    }

    if (bucket.destination === 'takilan') {
      Components.renderTakilanListFor(di);
    } else {
      Components.renderCompListFor(di);
    }
  },

  applyItem(id, options) {
    const item = OCR.getItemById(id);
    if (!item || item.status !== 'ready' || !OCR.target) return;

    const vals = OCR.getItemValues(item);
    const resultKind = OCR.getResultKind(item.result?.resultKind);
    const assetMatchByTag = item.result?.assetMatchByTag;
    const hardwareType = vals.hardwareType;
    const inventoryMatch = item.result?.inventoryMatch;
    const { di, listType, rowIdx } = OCR.target;
    const device = App.devices[di];
    if (!device) return;

    let needsDeviceRefresh = false;
    let toastMessage = '';

    if (resultKind === 'server_label') {
      const serverTagValue = OCR.normalizeServerLabel(
        vals.serverLabel || item.result?.serverLabel || vals.serviceTag || item.result?.serviceTag
      );
      if (!OCR.isValidServerLabel(serverTagValue)) {
        App.showToast('Tag değeri geçerli değil. Lütfen 4-12 karakter harf/rakam girin.');
        return;
      }

      const rackLabel = OCR.isRackLabelTag(serverTagValue);
      const inventoryModel = OCR.normalizeNameWhitespace(assetMatchByTag?.model || '');
      const ocrModel = OCR.normalizeNameWhitespace(vals.model || item.result?.model || '');
      const inventorySerial = String(assetMatchByTag?.serial || '').trim();

      if (rackLabel) {
        device.etiket = serverTagValue;
        if (!device.seri && inventorySerial) device.seri = inventorySerial;
      } else {
        device.seri = serverTagValue;
      }

      if (!device.model && inventoryModel) {
        device.model = inventoryModel;
      } else if (!device.model && ocrModel) {
        device.model = ocrModel;
      }

      needsDeviceRefresh = true;
      if (rackLabel) {
        toastMessage = assetMatchByTag
          ? 'Rack etiketi ETIKET alanına uygulandı, model/seri envanterden doğrulandı'
          : 'Rack etiketi ETIKET alanına uygulandı';
      } else {
        toastMessage = assetMatchByTag
          ? 'Uyarı: Tag değeri SERI NO alanına uygulandı, model envanterden doğrulandı'
          : 'Uyarı: Tag değeri SERI NO alanına uygulandı (PD/SH öneki yok)';
      }
    } else {
      const qty = OCR.normalizeQty(item.qty);
      const typeMap = { ram: 'RAM', disk: 'DISK', nic: 'NIC', cpu: 'CPU' };
      const componentType = typeMap[hardwareType] || 'DISK';
      const serial = (hardwareType === 'disk' || hardwareType === 'nic') ? vals.serial : '';
      const name = OCR.buildComponentName(hardwareType, vals, inventoryMatch, item.result);

      if (hardwareType === 'disk' && inventoryMatch?.source === 'assets') {
        if (!device.model && inventoryMatch.model) device.model = inventoryMatch.model;
        if (!device.etiket && inventoryMatch.assetTag) device.etiket = inventoryMatch.assetTag;
        if (!device.seri && inventoryMatch.serial) device.seri = inventoryMatch.serial;
        needsDeviceRefresh = true;
      }

      if (OCR.isRowTargeted() && listType && rowIdx !== null) {
        const arr = listType === 'comp' ? device.components : device.takilanComponents;
        if (arr[rowIdx]) {
          if (MULTI_TYPES.has(arr[rowIdx].type) && arr[rowIdx].units.length > 0) {
            let targetUnit = arr[rowIdx].units.find(unit => !unit.name && !unit.serial);
            if (!targetUnit) targetUnit = arr[rowIdx].units[arr[rowIdx].units.length - 1];
            targetUnit.name = name;
            targetUnit.serial = serial;
          } else {
            arr[rowIdx].name = name;
            arr[rowIdx].serial = serial;
          }
        }
        if (listType === 'comp') {
          Components.renderCompListFor(di);
        } else {
          Components.renderTakilanListFor(di);
        }
      } else {
        const destination = OCR.normalizeDestination(di, OCR.batchDestination);
        OCR.upsertBatchComponent(di, destination, { type: componentType, qty, name, serial });
      }

      toastMessage = inventoryMatch
        ? 'Metin tanıma sonucu ve envanter eşleşmesi uygulandı'
        : 'Metin tanıma sonucu uygulandı';
    }

    if (needsDeviceRefresh) {
      Devices.renderDeviceList();
    }
    App.render();
    App.scheduleAutoSave();

    item.status = 'applied';

    // On mobile batch mode, close sheet and reset camera for next capture
    if (OCR.mode !== 'single' && OCR.isMobileSheet()) {
      OCR.closeQueueSheet();
      if (OCR.source === 'camera' && OCR.capturePreview) {
        OCR.retryCapture();
      }
    }

    OCR.renderWorkspace();

    if (OCR.mode === 'single') {
      OCR.closeCamera();
    }

    if (!options?.silentToast) {
      App.showToast(toastMessage || 'Metin tanıma sonucu uygulandı');
    }
  },

  applyResult(id) {
    if (id !== undefined) {
      OCR.applyItem(id);
      return;
    }
    const firstReady = OCR.queueItems.find(item => item.status === 'ready');
    if (firstReady) OCR.applyItem(firstReady.id);
  },

  applyAllReady() {
    if (OCR.mode !== 'batch') return;
    const readyItems = OCR.queueItems.filter(item => item.status === 'ready');
    if (!readyItems.length) return;
    readyItems.forEach(item => OCR.applyItem(item.id, { silentToast: true }));
    App.showToast(`${readyItems.length} metin tanıma kartı taslağa eklendi`);
  },

  renderInventoryMatch(match) {
    if (!match) return '';
    if (match.source === 'assets' || match.assetTag) {
      return `<div class="ocr-inventory-match">
        <strong>Envanter Eşleşmesi (Asset)</strong>
        <div>Etiket: ${OCR.escapeHtml(match.assetTag || '')} | Model: ${OCR.escapeHtml(match.model || '')}</div>
        <div>Durum: ${OCR.escapeHtml(match.status || '')} | Konum: ${OCR.escapeHtml(match.location || '')}</div>
      </div>`;
    }
    return `<div class="ocr-inventory-match">
      <strong>Envanter Eşleşmesi (Bileşen)</strong>
      <div>Ad: ${OCR.escapeHtml(match.name)}</div>
      <div>Kategori: ${OCR.escapeHtml(match.category)} | Konum: ${OCR.escapeHtml(match.location)}</div>
    </div>`;
  },

  renderQueueList() {
    if (!OCR.queueItems.length) {
      return '';
    }
    return OCR.queueItems.map((item, index) => OCR.renderQueueItem(item, index)).join('');
  },

  renderQueueItem(item, index) {
    const statusTextMap = {
      queued: 'Sırada',
      processing: 'İşleniyor',
      ready: 'Hazır',
      error: 'Hata',
      applied: 'Uygulandı',
      skipped: 'Atlandı'
    };
    const hardwareTypeLabels = {
      disk: 'Disk',
      ram: 'RAM',
      nic: 'NIC',
      cpu: 'CPU'
    };
    const canEdit = item.status === 'ready';
    const showFields = ['ready', 'applied', 'skipped'].includes(item.status) && item.fields;
    const resultKind = OCR.getResultKind(item.result?.resultKind);
    const isServerLabel = resultKind === 'server_label';
    const isCollapsible = showFields || !!item.result?.raw || item.status === 'error';
    const isCollapsed = !!item.collapsed && isCollapsible;
    const showQtyField = showFields && OCR.mode === 'batch' && !isServerLabel;
    const hardwareType = OCR.normalizeHardwareType(item.fields?.hardwareType);
    const qtyValue = OCR.normalizeQty(item.qty);
    const canDelete = item.status !== 'processing';
    const fieldRows = showFields
      ? (isServerLabel
        ? `
      <div class="ocr-card-field full-width">
        <label>Server Tag / Service Tag</label>
        <input type="text" value="${OCR.escapeHtml(item.fields.serverLabel)}" ${canEdit ? '' : 'disabled'}
          oninput="OCR.updateItemField(${item.id},'serverLabel',this.value)">
      </div>
    `
        : OCR.getFieldDefinitions(hardwareType).map(([label, key]) => `
      <div class="ocr-card-field">
        <label>${label}</label>
        <input type="text" value="${OCR.escapeHtml(item.fields[key])}" ${canEdit ? '' : 'disabled'}
          oninput="OCR.updateItemField(${item.id},'${key}',this.value)">
      </div>
    `).join(''))
      : '';

    const typeOptions = ['disk', 'ram', 'nic', 'cpu'].map(type => `
      <option value="${type}"${hardwareType === type ? ' selected' : ''}>${hardwareTypeLabels[type]}</option>
    `).join('');

    let actionsHtml = '';
    if (item.status === 'ready') {
      actionsHtml = `
        <button class="btn btn-success" onclick="OCR.applyItem(${item.id})">Uygula</button>
        <button class="btn btn-ghost" onclick="OCR.retryItem(${item.id})">Tekrar Metin Tanıma</button>
        <button class="btn btn-danger" onclick="OCR.deleteItem(${item.id})">Sil</button>
      `;
    } else if (item.status === 'error') {
      actionsHtml = `
        <button class="btn btn-accent2" onclick="OCR.retryItem(${item.id})">Tekrar Dene</button>
        <button class="btn btn-danger" onclick="OCR.deleteItem(${item.id})">Sil</button>
      `;
    } else if (item.status === 'processing' || item.status === 'queued') {
      actionsHtml = `<button class="btn btn-ghost" disabled>${statusTextMap[item.status]}</button>`;
    } else if (item.status === 'applied') {
      actionsHtml = `<div class="ocr-card-note success">Bu kart taslağa eklendi.</div>`;
    } else if (item.status === 'skipped') {
      actionsHtml = `
        <div class="ocr-card-note warn">Bu kart atlandı.</div>
        <button class="btn btn-ghost" onclick="OCR.retryItem(${item.id})">Yeniden Metin Tanıma</button>
      `;
    }

    const sourceLabel = item.fileName || (item.source === 'camera' ? `Kamera çekimi #${index + 1}` : `Galeri görseli #${index + 1}`);
    const rawHtml = item.result?.raw && !isCollapsed ? `
      <details class="ocr-raw-details">
        <summary>Ham Metin Tanıma Metni</summary>
        <pre>${OCR.escapeHtml(item.result.raw)}</pre>
      </details>
    ` : '';

    return `
      <div class="ocr-card status-${item.status}${isCollapsed ? ' is-collapsed' : ''}">
        <div class="ocr-card-top">
          <div class="ocr-card-thumb">
            <img src="${item.previewUrl}" alt="${OCR.escapeHtml(sourceLabel)}">
          </div>
          <div>
            <div class="ocr-card-title-row">
              <div class="ocr-card-title">${OCR.escapeHtml(sourceLabel)}</div>
              <div class="ocr-card-controls">
                ${isCollapsible ? `
                <button class="ocr-card-collapse" type="button" onclick="OCR.toggleItemCollapse(${item.id})" title="${isCollapsed ? 'Kartı genişlet' : 'Kartı daralt'}" aria-expanded="${isCollapsed ? 'false' : 'true'}">
                  <span class="material-symbols-outlined">${isCollapsed ? 'expand_more' : 'expand_less'}</span>
                </button>` : ''}
                <button class="ocr-card-close${canDelete ? '' : ' is-disabled'}" type="button" onclick="OCR.deleteItem(${item.id})" title="${canDelete ? 'Kartı sil' : 'Kart işlenirken silinemez'}" aria-label="${canDelete ? 'Kartı sil' : 'Kart işlenirken silinemez'}" ${canDelete ? '' : 'disabled'}>
                  <span class="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>
            <div class="ocr-card-sub">${isServerLabel
              ? 'Uygulandığında tag değeri kurala göre ETIKET veya SERI NO alanına yazılır.'
              : (OCR.mode === 'single'
                ? 'Bu kart seçili satıra uygulanır.'
                : `Uygulandığında ${OCR.escapeHtml(OCR.getDestinationLabel(OCR.batchDestination))} listesine eklenir.`)}</div>
            <div class="ocr-badges">
              <span class="ocr-badge status-${item.status}">${statusTextMap[item.status]}</span>
              ${showFields ? `<span class="ocr-badge type">${isServerLabel ? 'Server Tag' : hardwareTypeLabels[hardwareType]}</span>` : ''}
            </div>
            ${item.error ? `<div class="ocr-card-error">${OCR.escapeHtml(item.error)}</div>` : ''}
          </div>
        </div>

        ${showFields && !isCollapsed ? `
          <div class="ocr-card-fields">
            ${!isServerLabel ? `
            <div class="ocr-card-field full-width">
              <label>Donanım Tipi</label>
              <select ${canEdit ? '' : 'disabled'} onchange="OCR.updateItemField(${item.id},'hardwareType',this.value)">
                ${typeOptions}
              </select>
            </div>` : ''}
            ${showQtyField ? `
            <div class="ocr-card-field">
              <label>Adet</label>
              <input type="number" min="1" step="1" value="${qtyValue}" ${canEdit ? '' : 'disabled'}
                onchange="OCR.updateItemQty(${item.id},this.value)">
            </div>` : ''}
            ${fieldRows}
          </div>
        ` : ''}

        ${showFields && !isCollapsed ? OCR.renderInventoryMatch(item.result?.assetMatchByTag || item.result?.inventoryMatch) : ''}

        ${!isCollapsed ? `<div class="ocr-card-actions">
          ${actionsHtml}
        </div>` : ''}

        ${rawHtml}
      </div>
    `;
  },

  renderWorkspace() {
    const overlay = document.getElementById('cameraOverlay');
    if (!overlay) return;

    const headerKicker = document.getElementById('ocrHeaderKicker');
    const headerTitle = document.getElementById('ocrHeaderTitle');
    const targetSummary = document.getElementById('ocrTargetSummary');
    const batchControls = document.getElementById('ocrBatchControls');
    const destinationSelect = document.getElementById('ocrDestinationSelect');
    const sourceCameraBtn = document.getElementById('ocrSourceCamera');
    const sourceGalleryBtn = document.getElementById('ocrSourceGallery');
    const cameraStage = document.getElementById('ocrCameraStage');
    const galleryStage = document.getElementById('ocrGalleryStage');
    const cameraFrame = document.getElementById('ocrCameraFrame');
    const stagePlaceholder = document.getElementById('ocrStagePlaceholder');
    const stageStatus = document.getElementById('ocrStageStatus');
    const stageHints = document.getElementById('ocrStageHints');
    const galleryHelp = document.getElementById('ocrGalleryHelp');
    const queueTitle = document.getElementById('ocrQueueTitle');
    const queueStats = document.getElementById('ocrQueueStats');
    const queueList = document.getElementById('ocrQueueList');
    const footerMeta = document.getElementById('ocrFooterMeta');
    const captureBtn = document.getElementById('ocrCaptureBtn');
    const switchCameraBtn = document.getElementById('ocrSwitchCameraBtn');
    const resetPreviewBtn = document.getElementById('ocrResetPreviewBtn');
    const applyAllBtn = document.getElementById('ocrApplyAllBtn');
    const galleryActionBtn = document.getElementById('ocrGalleryActionBtn');
    const focusLockBtn = document.getElementById('ocrFocusLockBtn');
    const focusMarker = document.getElementById('ocrFocusMarker');
    const video = document.getElementById('cameraVideo');
    const still = document.getElementById('cameraStillPreview');

    const counts = OCR.getQueueCounts();
    const isOpen = OCR.isOverlayOpen();
    const cameraAllowed = OCR.canUseCamera();

    if (!cameraAllowed && OCR.source === 'camera') {
      OCR.source = 'gallery';
      OCR.stopCameraStream();
    }

    if (headerKicker) {
      headerKicker.textContent = '';
      headerKicker.style.display = 'none';
    }
    if (headerTitle) headerTitle.textContent = 'Metin Tanıma';
    if (targetSummary) {
      targetSummary.textContent = '';
      targetSummary.style.display = 'none';
    }

    if (batchControls) {
      batchControls.style.display = OCR.mode === 'batch' ? 'block' : 'none';
    }
    if (destinationSelect) {
      OCR.batchDestination = OCR.normalizeDestination(OCR.target?.di, OCR.batchDestination);
      const options = OCR.getDestinationOptions();
      destinationSelect.innerHTML = options.map(option => `
        <option value="${option.value}"${OCR.batchDestination === option.value ? ' selected' : ''}>${option.label}</option>
      `).join('');
      destinationSelect.value = OCR.batchDestination;
    }

    if (sourceCameraBtn) {
      sourceCameraBtn.style.display = cameraAllowed ? 'inline-flex' : 'none';
      sourceCameraBtn.classList.toggle('is-active', OCR.source === 'camera');
      sourceCameraBtn.disabled = !cameraAllowed;
    }
    if (sourceGalleryBtn) {
      sourceGalleryBtn.classList.toggle('is-active', OCR.source === 'gallery');
    }
    const sourceSwitch = sourceCameraBtn?.closest('.ocr-source-switch') || sourceGalleryBtn?.closest('.ocr-source-switch');
    if (sourceSwitch) {
      sourceSwitch.style.display = cameraAllowed ? 'inline-flex' : 'none';
    }

    cameraStage?.classList.toggle('is-active', OCR.source === 'camera');
    galleryStage?.classList.toggle('is-active', OCR.source === 'gallery');

    if (cameraFrame) {
      cameraFrame.classList.toggle('is-frozen', !!OCR.capturePreview);
      cameraFrame.classList.toggle('is-blocked', !!OCR.getCameraPlaceholderText());
      cameraFrame.classList.toggle('is-focus-locked', !!OCR.focusLockActive);
    }
    if (focusMarker) {
      if (OCR.lastFocusPoint) {
        focusMarker.style.left = (OCR.lastFocusPoint.x * 100).toFixed(2) + '%';
        focusMarker.style.top = (OCR.lastFocusPoint.y * 100).toFixed(2) + '%';
      }
      const showMarker = OCR.source === 'camera' && !!OCR.lastFocusPoint && OCR.focusMarkerVisible && !OCR.capturePreview;
      focusMarker.classList.toggle('is-visible', showMarker);
      focusMarker.classList.toggle('is-locked', showMarker && OCR.focusLockActive);
    }
    if (stagePlaceholder) {
      stagePlaceholder.textContent = OCR.getCameraPlaceholderText();
    }
    if (stageStatus) {
      const text = OCR.getStageStatusText();
      stageStatus.innerHTML = text ? `<span>${OCR.escapeHtml(text)}</span>` : '';
    }
    if (stageHints) {
      stageHints.textContent = OCR.getStageHintText();
    }
    if (galleryHelp) {
      galleryHelp.textContent = '';
      galleryHelp.style.display = 'none';
    }

    if (video) video.dataset.façıngMode = OCR.currentFaçıngMode;
    if (still) {
      still.dataset.façıngMode = OCR.currentFaçıngMode;
      if (OCR.capturePreview) {
        still.src = OCR.capturePreview;
      } else {
        still.removeAttribute('src');
      }
    }

    if (queueTitle) {
      queueTitle.textContent = counts.total ? `${counts.total} fotoğraf kartı` : 'Henüz fotoğraf yok';
    }
    if (queueStats) {
      const stats = [];
      if (counts.ready) stats.push(`${counts.ready} hazır`);
      if (counts.processing) stats.push(`${counts.processing} işleniyor`);
      if (counts.error) stats.push(`${counts.error} hata`);
      if (counts.applied) stats.push(`${counts.applied} uygulandı`);
      if (counts.skipped) stats.push(`${counts.skipped} atlandı`);
      queueStats.textContent = stats.join(' · ');
    }
    if (queueList) {
      queueList.innerHTML = OCR.renderQueueList();
    }
    if (footerMeta) {
      footerMeta.textContent = OCR.getFooterMetaText(counts);
    }

    OCR.updateQueueToggle();

    if (galleryActionBtn) {
      const galleryLabel = galleryActionBtn.querySelector('.ocr-btn-label');
      if (galleryLabel) galleryLabel.textContent = 'Fotoğraf Seç';
    }
    if (focusLockBtn) {
      const focusLockLabel = focusLockBtn.querySelector('.ocr-btn-label');
      const focusLockIcon = focusLockBtn.querySelector('.ocr-btn-icon');
      const showFocusLockBtn = OCR.source === 'camera' && cameraAllowed && OCR.focusSupported;
      focusLockBtn.style.display = showFocusLockBtn ? 'inline-flex' : 'none';
      focusLockBtn.classList.toggle('is-active', OCR.focusLockActive);
      if (focusLockLabel) {
        focusLockLabel.textContent = OCR.focusLockActive ? 'Odak Kilitli' : 'Odak Kilidi';
      }
      if (focusLockIcon) {
        focusLockIcon.textContent = OCR.focusLockActive ? 'lock' : 'center_focus_strong';
      }
      focusLockBtn.disabled = !isOpen
        || OCR.source !== 'camera'
        || !OCR.videoReady
        || OCR.processingStatus === 'opening-camera'
        || OCR.processingStatus === 'capturing';
      focusLockBtn.title = OCR.focusLockActive ? 'Odak kilidini kapat' : 'Odak kilidini aç';
    }
    if (captureBtn) {
      captureBtn.style.display = OCR.source === 'camera' ? 'inline-flex' : 'none';
      const captureLabel = captureBtn.querySelector('.ocr-btn-label');
      if (captureLabel) {
        captureLabel.textContent = OCR.processingStatus === 'opening-camera'
          ? 'Hazırlanıyor'
          : OCR.processingStatus === 'capturing'
            ? 'İşleniyor'
            : 'Yakala';
      }
      captureBtn.disabled = !isOpen
        || OCR.source !== 'camera'
        || !OCR.videoReady
        || !!OCR.capturePreview
        || OCR.processingStatus === 'opening-camera'
        || OCR.processingStatus === 'capturing';
    }
    if (switchCameraBtn) {
      switchCameraBtn.style.display = OCR.source === 'camera' && cameraAllowed ? 'inline-flex' : 'none';
      switchCameraBtn.disabled = OCR.processingStatus === 'opening-camera';
    }
    if (resetPreviewBtn) {
      resetPreviewBtn.style.display = OCR.source === 'camera' && !!OCR.capturePreview ? 'inline-flex' : 'none';
      resetPreviewBtn.disabled = OCR.processingStatus === 'capturing';
    }
    if (applyAllBtn) {
      applyAllBtn.style.display = OCR.mode === 'batch' && counts.ready ? 'inline-flex' : 'none';
      applyAllBtn.disabled = !counts.ready;
    }

    if (OCR.shouldEnableFocusGestures()) {
      OCR.bindFocusGestures(cameraFrame);
    } else {
      OCR.unbindFocusGestures();
    }
  },

  setBatchDestination(value) {
    OCR.batchDestination = OCR.normalizeDestination(OCR.target?.di, value);
    OCR.renderWorkspace();
  },

  isMobileSheet() {
    return OCR.isMobileView();
  },

  toggleQueueSheet() {
    const panel = document.getElementById('ocrQueuePanel') || document.querySelector('.ocr-queue-panel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('is-sheet-open');
    OCR.queueSheetDismissed = !isOpen;
  },

  closeQueueSheet(options = {}) {
    const panel = document.getElementById('ocrQueuePanel') || document.querySelector('.ocr-queue-panel');
    if (panel) panel.classList.remove('is-sheet-open');
    if (options.dismiss !== false) {
      OCR.queueSheetDismissed = true;
    }
  },

  updateQueueToggle() {
    const toggle = document.getElementById('ocrQueueToggle');
    const iconEl = document.getElementById('ocrQueueToggleIcon');
    const countEl = document.getElementById('ocrQueueToggleCount');
    const labelEl = document.getElementById('ocrQueueToggleLabel');
    if (!toggle) return;

    const counts = OCR.getQueueCounts();
    const showToggle = OCR.isMobileSheet() && counts.total > 0;
    const panel = document.getElementById('ocrQueuePanel') || document.querySelector('.ocr-queue-panel');
    const isSheetOpen = !!panel?.classList.contains('is-sheet-open');
    if (countEl) countEl.textContent = counts.total;
    if (iconEl) iconEl.textContent = isSheetOpen ? 'expand_more' : 'inventory_2';
    if (labelEl) {
      labelEl.textContent = isSheetOpen
        ? 'Kartları Gizle'
        : (counts.ready ? `${counts.ready} hazır` : 'Kuyruk');
    }
    toggle.classList.toggle('is-open', isSheetOpen);
    toggle.classList.toggle('has-ready', counts.ready > 0);
    toggle.style.display = showToggle ? 'flex' : 'none';
    if (!showToggle) {
      OCR.closeQueueSheet({ dismiss: false });
      OCR.queueSheetDismissed = false;
    }
  }
};
