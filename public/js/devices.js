const Devices = {
  makeDevice() {
    return { model:'', etiket:'', seri:'', not:'', componentsOnly:false, takilanComponents:[], components:[] };
  },

  addDevice(data) {
    const d = data || Devices.makeDevice();
    App.devices.push(d);
    const di = App.devices.length - 1;
    App.ddState[di] = { model:{selected:-1}, etiket:{selected:-1}, seri:{selected:-1} };
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  duplicateDevice(di) {
    const src = App.devices[di];
    function clearComp(c) {
      const copy = JSON.parse(JSON.stringify(c));
      copy.name = ''; copy.serial = ''; copy.health = '';
      copy.units = copy.units.map(() => ({name:'', serial:'', health:''}));
      return copy;
    }
    const copy = {
      model: '', etiket: '', seri: '', not: '', componentsOnly: false,
      takilanComponents: src.takilanComponents.map(clearComp),
      components: src.components.map(clearComp)
    };
    App.devices.splice(di + 1, 0, copy);
    App.ddState = {};
    App.devices.forEach((_, i) => { App.ddState[i] = {model:{selected:-1},etiket:{selected:-1},seri:{selected:-1}}; });
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
    App.showToast('Cihaz ' + (di+1) + ' yapısı kopyalandı');
  },

  toggleComponentsOnly(di) {
    App.devices[di].componentsOnly = !App.devices[di].componentsOnly;
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  removeDevice(di) {
    App.devices.splice(di, 1);
    App.ddState = {};
    App.devices.forEach((_,i) => { App.ddState[i] = {model:{selected:-1},etiket:{selected:-1},seri:{selected:-1}}; });
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  updateDevice(di, key, val) {
    App.devices[di][key] = val;
    const lbl = document.getElementById('dv_label_'+di);
    if (lbl) lbl.textContent = App.devices[di].model || App.devices[di].etiket || ('Cihaz '+(di+1));
    App.render();
    App.scheduleAutoSave();
  },

  toggleDeviceBody(di) {
    const body = document.getElementById('dv_body_'+di);
    if (body) body.classList.toggle('open');
  },

  renderDeviceList() {
    const container = document.getElementById('deviceList');
    if (!container) return;
    container.innerHTML = App.devices.map((d, di) => {
      const label = d.model || d.etiket || `Cihaz ${di+1}`;
      const deleteBtn = App.devices.length > 1
        ? `<button class="btn btn-danger" style="padding:2px 6px" onclick="event.stopPropagation();Devices.removeDevice(${di})" title="Sil"><span class="material-symbols-outlined" style="font-size:16px">close</span></button>`
        : '';
      const dupBtn = `<button class="btn btn-ghost" style="padding:2px 6px;font-size:10px" onclick="event.stopPropagation();Devices.duplicateDevice(${di})" title="Kopyala"><span class="material-symbols-outlined" style="font-size:15px">content_copy</span></button>`;
      const coBtn  = `<button class="btn btn-ghost" style="padding:2px 6px;font-size:10px;${d.componentsOnly?'color:var(--accent2);':''}" onclick="event.stopPropagation();Devices.toggleComponentsOnly(${di})" title="Sadece bileşenler"><span class="material-symbols-outlined" style="font-size:15px">memory</span></button>`;
      const scanBtn = `<button class="btn btn-ghost" style="padding:2px 6px;font-size:10px" onclick="event.stopPropagation();OCR.openCamera(${di})" title="Metin Tanıma ile Tara"><span class="material-symbols-outlined" style="font-size:15px">photo_camera</span></button>`;
      const deviceFields = d.componentsOnly ? '' : `
          <div class="field"><label>MODEL</label>
            <div class="search-wrap">
              <input type="text" value="${d.model}" placeholder="Model"
                oninput="Devices.updateDevice(${di},'model',this.value);Search.onSearchInput(this,'model',${di})"
                onkeydown="Search.onSearchKey(event,'model',${di})"
                onblur="Search.closeDropdown('model',${di},150)" autocomplete="off">
              <div class="search-dropdown" id="dd_model_${di}"></div>
            </div>
          </div>
          <div class="row">
            <div class="field"><label>ETİKET</label>
              <div class="search-wrap">
                <input type="text" value="${d.etiket}" placeholder="Etiket"
                  oninput="Devices.updateDevice(${di},'etiket',this.value);Search.onSearchInput(this,'etiket',${di})"
                  onkeydown="Search.onSearchKey(event,'etiket',${di})"
                  onblur="Search.closeDropdown('etiket',${di},150)" autocomplete="off">
                <div class="search-dropdown" id="dd_etiket_${di}"></div>
              </div>
            </div>
            <div class="field"><label>SERİ NO</label>
              <div class="search-wrap">
                <input type="text" value="${d.seri}" placeholder="Seri No"
                  oninput="Devices.updateDevice(${di},'seri',this.value);Search.onSearchInput(this,'seri',${di})"
                  onkeydown="Search.onSearchKey(event,'seri',${di})"
                  onblur="Search.closeDropdown('seri',${di},150)" autocomplete="off">
                <div class="search-dropdown" id="dd_seri_${di}"></div>
              </div>
            </div>
          </div>
          <div class="field"><label>NOT</label>
            <textarea rows="2" placeholder="Açıklama veya not..."
              oninput="Devices.updateDevice(${di},'not',this.value)">${d.not}</textarea>
          </div>`;
      return `<div class="device-card">
        <div class="device-header" onclick="Devices.toggleDeviceBody(${di})">
          <div class="device-header-left">
            <span style="color:var(--accent2)">#${di+1}</span>
            <span id="dv_label_${di}">${label}</span>
          </div>
          <div class="device-header-right">${scanBtn}${coBtn}${dupBtn}${deleteBtn}<span class="material-symbols-outlined" style="font-size:18px;color:var(--text-muted)">expand_more</span></div>
        </div>
        <div class="device-body open" id="dv_body_${di}">
          ${deviceFields}
          ${d.componentsOnly ? `
          <div class="device-section-title">Donanım</div>
          <div class="comp-header"><span>Tip</span><span>Adet</span><span></span></div>
          <div id="compList_${di}">${Components.renderCompRows(d.components, di, 'comp')}</div>
          <div class="comp-add-row" style="margin-top:6px">
            <button class="btn btn-ghost btn-sm" onclick="Components.addComponent(${di})">+ Donanım Ekle</button>
          </div>
          ` : `
          <div class="device-section-title">Takılan Donanım</div>
          <div class="comp-header"><span>Tip</span><span>Adet</span><span></span></div>
          <div id="takilanList_${di}">${Components.renderCompRows(d.takilanComponents, di, 'takilan')}</div>
          <div class="comp-add-row" style="margin-top:6px">
            <button class="btn btn-ghost btn-sm" onclick="Components.addTakilan(${di})">+ Takılan Ekle</button>
          </div>
          <div class="device-section-title">Çıkarılan Donanım</div>
          <div class="comp-header"><span>Tip</span><span>Adet</span><span></span></div>
          <div id="compList_${di}">${Components.renderCompRows(d.components, di, 'comp')}</div>
          <div class="comp-add-row" style="margin-top:6px">
            <button class="btn btn-ghost btn-sm" onclick="Components.addComponent(${di})">+ Çıkarılan Ekle</button>
          </div>
          `}
        </div>
      </div>`;
    }).join('');
  }
};
