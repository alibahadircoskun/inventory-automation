const Devices = {
  makeDevice() {
    return {
      id: null,
      model: '',
      etiket: '',
      seri: '',
      not: '',
      componentsOnly: false,
      assetResolutionMode: 'unresolved',
      snipeitAssetId: null,
      snipeitAssetSnapshot: null,
      snipeitValidatedAt: null,
      currentStateSnapshot: null,
      currentStateFetchedAt: null,
      proposedNewAssetStatus: '',
      proposedNewAssetLocation: '',
      takilanComponents: [],
      components: []
    };
  },

  editableAttr() {
    return App.canEditCurrentSession() ? '' : 'disabled';
  },

  addDevice(data) {
    if (!App.canEditCurrentSession()) return;
    const device = data || Devices.makeDevice();
    App.devices.push(device);
    const index = App.devices.length - 1;
    App.ddState[index] = { model: { selected: -1 }, etiket: { selected: -1 }, seri: { selected: -1 } };
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  duplicateDevice(index) {
    if (!App.canEditCurrentSession()) return;
    const source = App.devices[index];
    const copied = JSON.parse(JSON.stringify(source));
    copied.id = null;
    copied.model = '';
    copied.etiket = '';
    copied.seri = '';
    copied.not = '';
    copied.assetResolutionMode = 'unresolved';
    copied.snipeitAssetId = null;
    copied.snipeitAssetSnapshot = null;
    copied.snipeitValidatedAt = null;
    copied.currentStateSnapshot = null;
    copied.currentStateFetchedAt = null;
    copied.takilanComponents = copied.takilanComponents.map(Components.resetComponentMatchState);
    copied.components = copied.components.map(Components.resetComponentMatchState);

    App.devices.splice(index + 1, 0, copied);
    App.ddState = {};
    App.devices.forEach((_, deviceIndex) => {
      App.ddState[deviceIndex] = { model: { selected: -1 }, etiket: { selected: -1 }, seri: { selected: -1 } };
    });
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
    App.showToast(`Cihaz ${index + 1} yapisi kopyalandi`);
  },

  toggleComponentsOnly(index) {
    if (!App.canEditCurrentSession()) return;
    App.devices[index].componentsOnly = !App.devices[index].componentsOnly;
    Devices.clearAssetResolution(index);
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  removeDevice(index) {
    if (!App.canEditCurrentSession()) return;
    App.devices.splice(index, 1);
    App.ddState = {};
    App.devices.forEach((_, deviceIndex) => {
      App.ddState[deviceIndex] = { model: { selected: -1 }, etiket: { selected: -1 }, seri: { selected: -1 } };
    });
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  clearAssetResolution(index) {
    const device = App.devices[index];
    if (!device) return;
    device.assetResolutionMode = 'unresolved';
    device.snipeitAssetId = null;
    device.snipeitAssetSnapshot = null;
    device.snipeitValidatedAt = null;
    device.currentStateSnapshot = null;
    device.currentStateFetchedAt = null;
  },

  setMatchedAsset(index, asset) {
    const device = App.devices[index];
    if (!device || !asset) return;

    device.model = asset.model || '';
    device.etiket = asset.asset_tag || '';
    device.seri = asset.serial || '';
    device.assetResolutionMode = 'matched';
    device.snipeitAssetId = asset.id;
    device.snipeitAssetSnapshot = asset;
    device.snipeitValidatedAt = new Date().toISOString();
    device.proposedNewAssetStatus = asset.status_label || device.proposedNewAssetStatus || '';
    device.proposedNewAssetLocation = asset.location || device.proposedNewAssetLocation || '';
  },

  markNewAsset(index) {
    if (!App.canEditCurrentSession()) return;
    const device = App.devices[index];
    if (!device) return;
    device.assetResolutionMode = 'create_new';
    device.snipeitAssetId = null;
    device.snipeitAssetSnapshot = null;
    device.snipeitValidatedAt = new Date().toISOString();
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  updateDevice(index, key, value) {
    const device = App.devices[index];
    if (!device || !App.canEditCurrentSession()) return;

    device[key] = value;
    if (['model', 'etiket', 'seri'].includes(key)) {
      Devices.clearAssetResolution(index);
    }

    const label = document.getElementById(`dv_label_${index}`);
    if (label) {
      label.textContent = device.model || device.etiket || `Cihaz ${index + 1}`;
    }
    App.render();
    App.scheduleAutoSave();
  },

  toggleDeviceBody(index) {
    const body = document.getElementById(`dv_body_${index}`);
    if (body) body.classList.toggle('open');
  },

  renderValidationBar(device, index) {
    if (device.assetResolutionMode === 'matched' && device.snipeitAssetSnapshot) {
      return `
        <div class="device-validation device-validation--matched">
          <div>
            <strong>Envanter doğrulandı</strong>
            <span>${device.snipeitAssetSnapshot.asset_tag} | ${device.snipeitAssetSnapshot.model} | ${device.snipeitAssetSnapshot.location}</span>
          </div>
          ${App.canEditCurrentSession() ? `<button class="btn btn-ghost btn-sm" type="button" onclick="Search.validateDevice(${index}, true)">Yenile</button>` : ''}
        </div>
      `;
    }

    if (device.assetResolutionMode === 'create_new') {
      return `
        <div class="device-validation device-validation--new">
          <div>
            <strong>Yeni sunucu olarak işaretlendi</strong>
            <span>Envanterde eşleşen kayıt bulunamadı. Model, durum ve lokasyon bilgilerini tamamlayın.</span>
          </div>
        </div>
      `;
    }

    return `
      <div class="device-validation device-validation--pending">
        <div>
          <strong>Canlı sunucu doğrulaması bekleniyor</strong>
          <span>Etiket veya seri numarasıyla envanter doğrulaması yapın ya da yeni sunucu olarak işaretleyin.</span>
        </div>
        ${App.canEditCurrentSession() ? `<button class="btn btn-ghost btn-sm" type="button" onclick="Search.validateDevice(${index}, true)">Canlı Doğrula</button>` : ''}
      </div>
    `;
  },

  renderNewAssetFields(device, index) {
    if (device.assetResolutionMode !== 'create_new') return '';

    return `
      <div class="device-inline-fields">
        <div class="field">
          <label>Yeni Sunucu Durumu</label>
          <div class="search-wrap">
            <input type="text" value="${device.proposedNewAssetStatus || ''}" placeholder="Durum etiketi seçin"
              ${Devices.editableAttr()}
              oninput="Devices.updateDevice(${index}, 'proposedNewAssetStatus', this.value); Search.onAssetMetaSearchInput(this, 'status', ${index})"
              onfocus="Search.onAssetMetaSearchInput(this, 'status', ${index})"
              onkeydown="Search.onSearchKey(event, 'meta_status', ${index})"
              onblur="Search.closeDropdown('meta_status', ${index}, 150)"
              autocomplete="off">
            <div class="search-dropdown" id="dd_meta_status_${index}"></div>
          </div>
        </div>
        <div class="field">
          <label>Yeni Sunucu Lokasyonu</label>
          <div class="search-wrap">
            <input type="text" value="${device.proposedNewAssetLocation || ''}" placeholder="Lokasyon seçin"
              ${Devices.editableAttr()}
              oninput="Devices.updateDevice(${index}, 'proposedNewAssetLocation', this.value); Search.onAssetMetaSearchInput(this, 'location', ${index})"
              onfocus="Search.onAssetMetaSearchInput(this, 'location', ${index})"
              onkeydown="Search.onSearchKey(event, 'meta_location', ${index})"
              onblur="Search.closeDropdown('meta_location', ${index}, 150)"
              autocomplete="off">
            <div class="search-dropdown" id="dd_meta_location_${index}"></div>
          </div>
        </div>
      </div>
    `;
  },

  renderDeviceList() {
    const container = document.getElementById('deviceList');
    if (!container) return;

    container.innerHTML = App.devices.map((device, index) => {
      const label = device.model || device.etiket || `Cihaz ${index + 1}`;
      const deleteBtn = App.devices.length > 1
        ? `<button class="btn btn-danger btn-icon" ${App.canEditCurrentSession() ? '' : 'disabled'} onclick="event.stopPropagation();Devices.removeDevice(${index})" title="Sil"><span class="material-symbols-outlined md">close</span></button>`
        : '';
      const duplicateBtn = `<button class="btn btn-ghost btn-icon" ${App.canEditCurrentSession() ? '' : 'disabled'} onclick="event.stopPropagation();Devices.duplicateDevice(${index})" title="Kopyala"><span class="material-symbols-outlined md">content_copy</span></button>`;
      const componentsOnlyBtn = `<button class="btn btn-ghost btn-icon${device.componentsOnly ? ' is-active' : ''}" ${App.canEditCurrentSession() ? '' : 'disabled'} onclick="event.stopPropagation();Devices.toggleComponentsOnly(${index})" title="Sadece bileşenler"><span class="material-symbols-outlined md">memory</span></button>`;
      const scanBtn = `<button class="btn btn-ghost btn-icon" ${App.canEditCurrentSession() ? '' : 'disabled'} onclick="event.stopPropagation();OCR.openCamera(${index})" title="Metin tanima ile tara"><span class="material-symbols-outlined md">photo_camera</span></button>`;
      const resolutionActions = App.canEditCurrentSession() ? `
        <div class="device-resolution-actions">
          <button class="btn btn-ghost btn-sm" type="button" onclick="Search.validateDevice(${index}, true)">Envanter Ara</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="Devices.markNewAsset(${index})">Yeni Sunucu</button>
        </div>` : '';

      return `
        <div class="device-card">
          <div class="device-header" onclick="Devices.toggleDeviceBody(${index})">
            <div class="device-header-left">
              <span class="device-index-accent">#${index + 1}</span>
              <span id="dv_label_${index}">${label}</span>
            </div>
            <div class="device-header-right">${scanBtn}${componentsOnlyBtn}${duplicateBtn}${deleteBtn}<span class="material-symbols-outlined lg text-muted">expand_more</span></div>
          </div>
          <div class="device-body open" id="dv_body_${index}">
            <div class="field"><label>MODEL</label>
              <div class="search-wrap">
                <input type="text" value="${device.model}" placeholder="Model"
                  ${Devices.editableAttr()}
                  oninput="Devices.updateDevice(${index}, 'model', this.value); Search.onSearchInput(this, 'model', ${index})"
                  onkeydown="Search.onSearchKey(event, 'model', ${index})"
                  onblur="Search.closeDropdown('model', ${index}, 150)" autocomplete="off">
                <div class="search-dropdown" id="dd_model_${index}"></div>
              </div>
            </div>
            <div class="row">
              <div class="field"><label>ETIKET</label>
                <div class="search-wrap">
                  <input type="text" value="${device.etiket}" placeholder="Etiket"
                    ${Devices.editableAttr()}
                    oninput="Devices.updateDevice(${index}, 'etiket', this.value); Search.onSearchInput(this, 'etiket', ${index})"
                    onkeydown="Search.onSearchKey(event, 'etiket', ${index})"
                    onblur="Search.closeDropdown('etiket', ${index}, 150)" autocomplete="off">
                  <div class="search-dropdown" id="dd_etiket_${index}"></div>
                </div>
              </div>
              <div class="field"><label>SERI NO</label>
                <div class="search-wrap">
                  <input type="text" value="${device.seri}" placeholder="Seri No"
                    ${Devices.editableAttr()}
                    oninput="Devices.updateDevice(${index}, 'seri', this.value); Search.onSearchInput(this, 'seri', ${index})"
                    onkeydown="Search.onSearchKey(event, 'seri', ${index})"
                    onblur="Search.closeDropdown('seri', ${index}, 150)" autocomplete="off">
                  <div class="search-dropdown" id="dd_seri_${index}"></div>
                </div>
              </div>
            </div>
            <div class="field"><label>NOT</label>
              <textarea rows="2" placeholder="Açıklama veya not..."
                ${Devices.editableAttr()}
                oninput="Devices.updateDevice(${index}, 'not', this.value)">${device.not || ''}</textarea>
            </div>
            ${Devices.renderValidationBar(device, index)}
            ${resolutionActions}
            ${Devices.renderNewAssetFields(device, index)}
            ${device.componentsOnly ? `
              <div class="device-section-title">Donanım</div>
              <div class="comp-header"><span></span><span>Tip</span><span>Adet</span><span></span></div>
              <div id="compList_${index}" class="comp-list"
                ondragover="Components.onDragOverList(event, ${index}, 'comp')"
                ondragleave="Components.onDragLeaveList(event)"
                ondrop="Components.onDropList(event, ${index}, 'comp')">${Components.renderCompRows(device.components, index, 'comp')}</div>
              <div class="comp-add-row" style="margin-top:6px">
                <button class="btn btn-ghost btn-sm" ${App.canEditCurrentSession() ? '' : 'disabled'} onclick="Components.addComponent(${index})">+ Donanım Ekle</button>
              </div>
            ` : `
              <div class="device-section-title">Takılan Donanım</div>
              <div class="comp-header"><span></span><span>Tip</span><span>Adet</span><span></span></div>
              <div id="takilanList_${index}" class="comp-list"
                ondragover="Components.onDragOverList(event, ${index}, 'takilan')"
                ondragleave="Components.onDragLeaveList(event)"
                ondrop="Components.onDropList(event, ${index}, 'takilan')">${Components.renderCompRows(device.takilanComponents, index, 'takilan')}</div>
              <div class="comp-add-row" style="margin-top:6px">
                <button class="btn btn-ghost btn-sm" ${App.canEditCurrentSession() ? '' : 'disabled'} onclick="Components.addTakilan(${index})">+ Takılan Ekle</button>
              </div>
              <div class="device-section-title">Çıkarılan Donanım</div>
              <div class="comp-header"><span></span><span>Tip</span><span>Adet</span><span></span></div>
              <div id="compList_${index}" class="comp-list"
                ondragover="Components.onDragOverList(event, ${index}, 'comp')"
                ondragleave="Components.onDragLeaveList(event)"
                ondrop="Components.onDropList(event, ${index}, 'comp')">${Components.renderCompRows(device.components, index, 'comp')}</div>
              <div class="comp-add-row" style="margin-top:6px">
                <button class="btn btn-ghost btn-sm" ${App.canEditCurrentSession() ? '' : 'disabled'} onclick="Components.addComponent(${index})">+ Çıkarılan Ekle</button>
              </div>
            `}
          </div>
        </div>
      `;
    }).join('');
  }
};
