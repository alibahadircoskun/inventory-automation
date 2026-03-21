const OCR = {
  cameraStream: null,
  currentFacingMode: 'environment',
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
    return OCR.isMobileView() && OCR.supportsCameraApi();
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

  getResultKind(value) {
    return String(value || '').toLowerCase() === 'server_label' ? 'server_label' : 'component';
  },

  createEmptyFields(hardwareType) {
    return {
      hardwareType: OCR.normalizeHardwareType(hardwareType),
      serverLabel: '',
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
    return {
      ...fields,
      hardwareType: OCR.normalizeHardwareType(result?.hardwareType),
      serverLabel: OCR.normalizeServerLabel(result?.serverLabel),
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

    const overlay = document.getElementById('cameraOverlay');
    const input = document.getElementById('ocrFileInput');
    if (overlay) overlay.style.display = 'none';
    if (input) input.value = '';
  },

  stopCameraStream() {
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
    if (OCR.processingStatus === 'capturing') return 'Kare hazırlanıyor...';
    if (OCR.processingStatus === 'processing') return 'Metin tanıma sırasıyla işleniyor...';
    if (OCR.capturePreview) return 'Çekilen kare korunuyor. Kartları inceleyin veya canlı önizlemeye dönün.';
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
    return OCR.mode === 'single'
      ? 'Etiketi çerçeveye yaklaştırın, yazılar netleşince yakalayın. Sonuç yalnızca seçili satırı günceller.'
      : 'Telefonu dik tutun, etiketi mümkün olduğunca çerçeveye yaklaştırın. Her çekim ayrı bir inceleme kartı oluşturur.';
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
    OCR.source = source;
    OCR.permissionMessage = '';
    OCR.capturePreview = '';
    OCR.processingStatus = OCR.isProcessingQueue ? 'processing' : 'idle';

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
      OCR.permissionMessage = 'Bu tarayıcı kamerayı desteklemiyor. Galeri modunu kullanın.';
      OCR.processingStatus = 'error';
      OCR.renderWorkspace();
      return;
    }

    OCR.stopCameraStream();
    OCR.permissionMessage = '';
    OCR.processingStatus = 'opening-camera';
    OCR.videoReady = false;
    OCR.renderWorkspace();

    const video = document.getElementById('cameraVideo');
    if (!video) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: OCR.currentFacingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });

      if (token !== OCR.sessionToken || OCR.source !== 'camera' || !OCR.isOverlayOpen()) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      OCR.cameraStream = stream;
      video.dataset.facingMode = OCR.currentFacingMode;
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
    OCR.currentFacingMode = OCR.currentFacingMode === 'environment' ? 'user' : 'environment';
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

  buildImageFromSource(source, width, height) {
    const dims = OCR.getScaledDimensions(width, height, 1600);
    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, dims.width, dims.height);
    const imageData = canvas.toDataURL('image/jpeg', 0.84);
    return {
      imageData,
      previewUrl: imageData,
      width: dims.width,
      height: dims.height
    };
  },

  captureFrame() {
    if (OCR.source !== 'camera') return;
    if (!OCR.videoReady || OCR.capturePreview || OCR.processingStatus === 'opening-camera' || OCR.processingStatus === 'capturing') {
      return;
    }

    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('cameraCanvas');
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      OCR.permissionMessage = 'Canlı önizleme hazır olmadan çekim yapılamadı. Biraz daha bekleyin.';
      OCR.renderWorkspace();
      return;
    }

    OCR.processingStatus = 'capturing';
    OCR.renderWorkspace();

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(video, 0, 0);

    const prepared = OCR.buildImageFromSource(canvas, canvas.width, canvas.height);
    OCR.capturePreview = prepared.previewUrl;
    if (OCR.mode === 'single') {
      OCR.queueItems = [];
    }

    OCR.createQueueItem(prepared, 'camera', '');
    OCR.processingStatus = 'processing';
    OCR.renderWorkspace();
    OCR.processQueue();
  },

  retryCapture() {
    OCR.capturePreview = '';
    OCR.permissionMessage = '';
    if (OCR.source === 'camera') {
      OCR.processingStatus = OCR.videoReady ? 'ready' : 'opening-camera';
      if (!OCR.cameraStream) {
        OCR.startCamera();
        return;
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
      return OCR.buildImageFromSource(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
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

    try {
      let nextItem = OCR.queueItems.find(item => item.status === 'queued');
      while (nextItem && token === OCR.sessionToken) {
        await OCR.processItem(nextItem, token);
        nextItem = OCR.queueItems.find(item => item.status === 'queued');
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

  isWeakComponentResult(result) {
    return OCR.getComponentSignalCount(result) === 0;
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
      normalized.tag,
      normalized.serial,
      normalized.model,
      normalized.partNumber
    ]
      .map(value => OCR.normalizeServerLabel(value))
      .find(value => OCR.isValidServerLabel(value)) || '';
    normalized.serverLabel = OCR.isValidServerLabel(candidateServerLabel) ? candidateServerLabel : '';
    const weakComponent = OCR.isWeakComponentResult(normalized);
    normalized.resultKind = normalized.serverLabel && (declaredResultKind === 'server_label' || weakComponent)
      ? 'server_label'
      : 'component';
    return normalized;
  },

  shouldRunSmartRetry(result) {
    const normalized = OCR.normalizeResultPayload(result);
    if (normalized.resultKind === 'server_label') return false;
    if (OCR.isValidServerLabel(normalized.serverLabel)) return false;
    return OCR.isWeakComponentResult(normalized);
  },

  pickBetterResult(currentResult, candidateResult) {
    const current = OCR.normalizeResultPayload(currentResult);
    const candidate = OCR.normalizeResultPayload(candidateResult);
    if (candidate.resultKind === 'server_label' && OCR.isValidServerLabel(candidate.serverLabel)) return candidate;
    if (current.resultKind !== 'server_label' && OCR.getComponentSignalCount(candidate) > OCR.getComponentSignalCount(current)) {
      return candidate;
    }
    return current;
  },

  async callOcrApi(imageData) {
    const response = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Sunucu hatası: ${response.status}`);
    }

    return response.json();
  },

  async rotateImageData(imageData, degrees) {
    const rotation = ((degrees % 360) + 360) % 360;
    if (!rotation) return imageData;

    const img = await OCR.loadImageElement(imageData);
    const sourceWidth = img.naturalWidth || img.width;
    const sourceHeight = img.naturalHeight || img.height;
    if (!sourceWidth || !sourceHeight) return imageData;

    const swapSides = rotation === 90 || rotation === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swapSides ? sourceHeight : sourceWidth;
    canvas.height = swapSides ? sourceWidth : sourceHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return imageData;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (rotation === 90) {
      ctx.translate(canvas.width, 0);
    } else if (rotation === 180) {
      ctx.translate(canvas.width, canvas.height);
    } else if (rotation === 270) {
      ctx.translate(0, canvas.height);
    }
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(img, 0, 0);

    return canvas.toDataURL('image/jpeg', 0.84);
  },

  async buildRetryImageVariants(imageData) {
    const variants = [];
    for (const angle of [90, 270]) {
      try {
        const rotated = await OCR.rotateImageData(imageData, angle);
        if (rotated && rotated !== imageData) variants.push(rotated);
      } catch (error) {
        // Ignore rotation failure and continue with available variants.
      }
    }
    return variants;
  },

  async processItem(item, token) {
    item.status = 'processing';
    item.error = '';
    OCR.renderWorkspace();

    try {
      const firstResult = OCR.normalizeResultPayload(await OCR.callOcrApi(item.imageData));
      if (token !== OCR.sessionToken) return;

      let result = firstResult;
      if (OCR.shouldRunSmartRetry(firstResult)) {
        const retryImages = await OCR.buildRetryImageVariants(item.imageData);
        for (const retryImage of retryImages) {
          if (token !== OCR.sessionToken) return;
          try {
            const retryResult = await OCR.callOcrApi(retryImage);
            if (token !== OCR.sessionToken) return;
            result = OCR.pickBetterResult(result, retryResult);
            if (result.resultKind === 'server_label' && OCR.isValidServerLabel(result.serverLabel)) break;
            if (!OCR.isWeakComponentResult(result)) break;
          } catch (retryError) {
            // Keep the best successful result and continue trying the remaining variants.
          }
        }
      }

      item.result = result;
      item.fields = OCR.buildFieldsFromResult(result);
      item.status = 'ready';
      item.error = '';

      // Auto-open queue sheet on mobile when first item is ready
      if (OCR.isMobileSheet()) {
        const panel = document.getElementById('ocrQueuePanel') || document.querySelector('.ocr-queue-panel');
        if (panel) panel.classList.add('is-sheet-open');
      }
    } catch (error) {
      if (token !== OCR.sessionToken) return;
      item.status = 'error';
      item.error = error.message || 'Metin tanıma işlenemedi';
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
    if (item.source === 'camera') {
      OCR.capturePreview = item.previewUrl;
    }
    OCR.renderWorkspace();
    OCR.processQueue();
  },

  skipItem(id) {
    const item = OCR.getItemById(id);
    if (!item) return;

    if (OCR.mode === 'single') {
      OCR.queueItems = [];
      OCR.capturePreview = '';
      OCR.renderWorkspace();
      if (OCR.source === 'camera' && OCR.canUseCamera()) {
        OCR.retryCapture();
      }
      return;
    }

    item.status = 'skipped';

    // On mobile batch mode, close sheet and reset camera for next capture
    if (OCR.isMobileSheet()) {
      OCR.closeQueueSheet();
      if (OCR.source === 'camera' && OCR.capturePreview) {
        OCR.retryCapture();
      }
    }

    OCR.renderWorkspace();
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
    const rawText = [vals?.model, vals?.partNumber, ocrResult?.model, ocrResult?.partNumber, ocrResult?.raw]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
    if (!rawText) return '';
    if (/\bNVME\b|\bNVM-E\b/.test(rawText)) return 'NVME';
    if (/\bSATA\b/.test(rawText)) return 'SATA';
    if (/\bSAS\b/.test(rawText)) return 'SAS';
    if (/\bSSD\b/.test(rawText)) return 'SSD';
    return '';
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
      const serverLabel = OCR.normalizeServerLabel(vals.serverLabel || item.result?.serverLabel);
      if (!OCR.isValidServerLabel(serverLabel)) {
        App.showToast('Server etiketi geçerli değil. Lütfen 4-12 karakter harf/rakam girin.');
        return;
      }

      device.etiket = serverLabel;
      if (assetMatchByTag?.model) device.model = assetMatchByTag.model;
      if (assetMatchByTag?.serial) device.seri = assetMatchByTag.serial;
      needsDeviceRefresh = true;
      toastMessage = assetMatchByTag
        ? 'Server etiketi uygulandı ve envanterden model/seri güncellendi'
        : 'Server etiketi uygulandı';
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
    const fieldRows = showFields
      ? (isServerLabel
        ? `
      <div class="ocr-card-field full-width">
        <label>Server Etiketi</label>
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
        <button class="btn btn-ghost" onclick="OCR.skipItem(${item.id})">Atla</button>
      `;
    } else if (item.status === 'error') {
      actionsHtml = `
        <button class="btn btn-accent2" onclick="OCR.retryItem(${item.id})">Tekrar Dene</button>
        <button class="btn btn-ghost" onclick="OCR.skipItem(${item.id})">Atla</button>
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
                <button class="ocr-card-close" type="button" onclick="OCR.exitCardView()" title="Kartı kapat">
                  <span class="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>
            <div class="ocr-card-sub">${isServerLabel
              ? 'Uygulandığında cihaz ETİKET alanı güncellenir.'
              : (OCR.mode === 'single'
                ? 'Bu kart seçili satıra uygulanır.'
                : `Uygulandığında ${OCR.escapeHtml(OCR.getDestinationLabel(OCR.batchDestination))} listesine eklenir.`)}</div>
            <div class="ocr-badges">
              <span class="ocr-badge status-${item.status}">${statusTextMap[item.status]}</span>
              ${showFields ? `<span class="ocr-badge type">${isServerLabel ? 'Server Etiketi' : hardwareTypeLabels[hardwareType]}</span>` : ''}
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

    if (video) video.dataset.facingMode = OCR.currentFacingMode;
    if (still) {
      still.dataset.facingMode = OCR.currentFacingMode;
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
    panel.classList.toggle('is-sheet-open');
  },

  closeQueueSheet() {
    const panel = document.getElementById('ocrQueuePanel') || document.querySelector('.ocr-queue-panel');
    if (panel) panel.classList.remove('is-sheet-open');
  },

  updateQueueToggle() {
    const toggle = document.getElementById('ocrQueueToggle');
    const countEl = document.getElementById('ocrQueueToggleCount');
    const labelEl = document.getElementById('ocrQueueToggleLabel');
    if (!toggle) return;

    const counts = OCR.getQueueCounts();
    if (countEl) countEl.textContent = counts.total;
    if (labelEl) {
      labelEl.textContent = counts.ready ? `${counts.ready} hazır` : 'Kuyruk';
    }
    toggle.classList.toggle('has-ready', counts.ready > 0);
    toggle.style.display = counts.total > 0 ? 'flex' : 'none';
  }
};
