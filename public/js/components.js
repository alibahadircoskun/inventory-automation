const MULTI_TYPES = new Set(['DISK', 'NIC']);
const NON_SERIAL_TYPES = new Set(['CPU', 'RAM']);
const TYPES = ['CPU', 'RAM', 'DISK', 'NIC'];

const Components = {
  supportsHealth(type) {
    return type === 'DISK';
  },

  supportsSerial(type) {
    return !NON_SERIAL_TYPES.has(type);
  },

  resetUnitMatchState(unit) {
    return {
      ...unit,
      id: null,
      snipeitComponentId: null,
      snipeitComponentSnapshot: null,
      snipeitMatchStatus: 'unresolved',
      proposedNewComponentCategory: '',
      proposedNewComponentLocation: ''
    };
  },

  resetComponentMatchState(component) {
    return {
      ...component,
      id: null,
      serial: Components.supportsSerial(component.type) ? (component.serial || '') : '',
      snipeitComponentId: null,
      snipeitComponentSnapshot: null,
      snipeitMatchStatus: 'unresolved',
      proposedNewComponentCategory: '',
      proposedNewComponentLocation: '',
      units: (component.units || []).map(Components.resetUnitMatchState)
    };
  },

  clearComponentMatch(component) {
    if (!component) return;
    component.snipeitComponentId = null;
    component.snipeitComponentSnapshot = null;
    component.snipeitMatchStatus = 'unresolved';
    component.proposedNewComponentCategory = '';
    component.proposedNewComponentLocation = '';
  },

  clearUnitMatch(unit) {
    if (!unit) return;
    unit.snipeitComponentId = null;
    unit.snipeitComponentSnapshot = null;
    unit.snipeitMatchStatus = 'unresolved';
    unit.proposedNewComponentCategory = '';
    unit.proposedNewComponentLocation = '';
  },

  resolveCategoryForType(type, name, serial) {
    const haystack = `${String(name || '').toLowerCase()} ${String(serial || '').toLowerCase()}`;
    if (type === 'CPU') return 'CPU';
    if (type === 'RAM') return 'RAM';
    if (type === 'DISK') {
      if (haystack.includes('nvme')) return 'Nvme SSD';
      if (haystack.includes('sas')) return 'SAS Disk';
      if (haystack.includes('sata')) return 'SATA Disk';
      if (haystack.includes('ssd')) return 'SSD Disk';
      return 'SSD Disk';
    }
    if (type === 'NIC') {
      if (haystack.includes('sfp')) return 'SFP';
      return 'Fiber NIC';
    }
    return 'Cable';
  },

  makeUnit(type, unitData, fallbackName, fallbackSerial) {
    const source = unitData || {};
    return {
      id: source.id || null,
      name: source.name !== undefined ? source.name : (fallbackName || ''),
      serial: Components.supportsSerial(type)
        ? (source.serial !== undefined ? source.serial : (fallbackSerial || ''))
        : '',
      health: Components.supportsHealth(type) && source.health !== undefined ? source.health : '',
      snipeitComponentId: source.snipeitComponentId ?? source.snipeit_component_id ?? null,
      snipeitComponentSnapshot: source.snipeitComponentSnapshot || source.snipeit_component_snapshot || null,
      snipeitMatchStatus: source.snipeitMatchStatus || source.snipeit_match_status || 'unresolved',
      proposedNewComponentCategory: source.proposedNewComponentCategory || source.proposed_new_component_category || '',
      proposedNewComponentLocation: source.proposedNewComponentLocation || source.proposed_new_component_location || ''
    };
  },

  makeComp(data) {
    const source = data || {};
    const qty = source.qty || 1;
    const type = source.type || 'CPU';
    return {
      id: source.id || null,
      type,
      qty,
      name: source.name || '',
      serial: Components.supportsSerial(type) ? (source.serial || '') : '',
      health: source.health !== undefined ? source.health : '',
      snipeitComponentId: source.snipeitComponentId ?? source.snipeit_component_id ?? null,
      snipeitComponentSnapshot: source.snipeitComponentSnapshot || source.snipeit_component_snapshot || null,
      snipeitMatchStatus: source.snipeitMatchStatus || source.snipeit_match_status || 'unresolved',
      proposedNewComponentCategory: source.proposedNewComponentCategory || source.proposed_new_component_category || '',
      proposedNewComponentLocation: source.proposedNewComponentLocation || source.proposed_new_component_location || '',
      units: MULTI_TYPES.has(type)
        ? Array.from({ length: qty }, (_, index) => Components.makeUnit(
            type,
            source.units?.[index] || null,
            source.name || '',
            index === 0 ? (source.serial || '') : ''
          ))
        : []
    };
  },

  editableAttr() {
    return App.canEditCurrentSession() ? '' : 'disabled';
  },

  addComponent(deviceIndex, data) {
    if (!App.canEditCurrentSession()) return;
    App.devices[deviceIndex].components.push(Components.makeComp(data || {}));
    Components.renderCompListFor(deviceIndex);
    App.render();
    App.scheduleAutoSave();
  },

  removeComponent(deviceIndex, componentIndex) {
    if (!App.canEditCurrentSession()) return;
    App.devices[deviceIndex].components.splice(componentIndex, 1);
    Components.renderCompListFor(deviceIndex);
    App.render();
    App.scheduleAutoSave();
  },

  updateComp(deviceIndex, componentIndex, key, value) {
    if (!App.canEditCurrentSession()) return;
    const component = App.devices[deviceIndex].components[componentIndex];
    const shouldRerender = Components.applyComponentUpdate(component, key, value);
    if (shouldRerender) Components.renderCompListFor(deviceIndex);
    else Components.syncComponentRowState(deviceIndex, 'comp', componentIndex);
    App.render();
    App.scheduleAutoSave();
  },

  updateCompUnit(deviceIndex, componentIndex, unitIndex, key, value) {
    if (!App.canEditCurrentSession()) return;
    const component = App.devices[deviceIndex].components[componentIndex];
    Components.applyUnitUpdate(component, unitIndex, key, value);
    Components.syncUnitRowState(deviceIndex, 'comp', componentIndex, unitIndex);
    App.render();
    App.scheduleAutoSave();
  },

  addTakilan(deviceIndex, data) {
    if (!App.canEditCurrentSession()) return;
    App.devices[deviceIndex].takilanComponents.push(Components.makeComp(data || {}));
    Components.renderTakilanListFor(deviceIndex);
    App.render();
    App.scheduleAutoSave();
  },

  removeTakilan(deviceIndex, componentIndex) {
    if (!App.canEditCurrentSession()) return;
    App.devices[deviceIndex].takilanComponents.splice(componentIndex, 1);
    Components.renderTakilanListFor(deviceIndex);
    App.render();
    App.scheduleAutoSave();
  },

  updateTakilan(deviceIndex, componentIndex, key, value) {
    if (!App.canEditCurrentSession()) return;
    const component = App.devices[deviceIndex].takilanComponents[componentIndex];
    const shouldRerender = Components.applyComponentUpdate(component, key, value);
    if (shouldRerender) Components.renderTakilanListFor(deviceIndex);
    else Components.syncComponentRowState(deviceIndex, 'takilan', componentIndex);
    App.render();
    App.scheduleAutoSave();
  },

  updateTakilanUnit(deviceIndex, componentIndex, unitIndex, key, value) {
    if (!App.canEditCurrentSession()) return;
    const component = App.devices[deviceIndex].takilanComponents[componentIndex];
    Components.applyUnitUpdate(component, unitIndex, key, value);
    Components.syncUnitRowState(deviceIndex, 'takilan', componentIndex, unitIndex);
    App.render();
    App.scheduleAutoSave();
  },

  applyComponentUpdate(component, key, value) {
    if (key === 'proposedNewComponentLocation' || key === 'proposedNewComponentCategory') {
      component[key] = value;
      return false;
    }

    if (key === 'type') {
      component.type = value;
      component.serial = Components.supportsSerial(value) ? component.serial : '';
      component.health = Components.supportsHealth(value) ? component.health : '';
      component.units = MULTI_TYPES.has(value)
        ? Array.from({ length: component.qty }, () => Components.makeUnit(value))
        : [];
      Components.clearComponentMatch(component);
      return true;
    } else if (key === 'qty') {
      const qty = parseInt(value, 10) || 1;
      component.qty = qty;
      if (MULTI_TYPES.has(component.type)) {
        component.units = Array.from(
          { length: qty },
          (_, index) => Components.makeUnit(component.type, component.units[index] || null)
        );
        Components.clearComponentMatch(component);
      }
      return true;
    } else {
      if (key === 'serial' && !Components.supportsSerial(component.type)) {
        component.serial = '';
      } else if (key === 'health' && !Components.supportsHealth(component.type)) {
        component.health = '';
      } else {
        component[key] = value;
      }

      if (component.snipeitMatchStatus === 'create_new') {
        if (key === 'name' || key === 'serial' || key === 'type') {
          component.proposedNewComponentCategory = Components.resolveCategoryForType(component.type, component.name, component.serial);
        }
        return false;
      }

      Components.clearComponentMatch(component);
      return false;
    }
  },

  applyUnitUpdate(component, unitIndex, key, value) {
    const unit = component.units[unitIndex];
    if (!unit) return;
    if (key === 'proposedNewComponentLocation' || key === 'proposedNewComponentCategory') {
      unit[key] = value;
      return;
    }
    if (key === 'health' && !Components.supportsHealth(component.type)) {
      unit.health = '';
    } else {
      unit[key] = value;
    }

    if (unit.snipeitMatchStatus === 'create_new') {
      if (key === 'name' || key === 'serial') {
        unit.proposedNewComponentCategory = Components.resolveCategoryForType(component.type, unit.name, unit.serial);
      }
      return;
    }

    Components.clearUnitMatch(unit);
  },

  getList(deviceIndex, listType) {
    const device = App.devices[deviceIndex];
    if (!device) return null;
    return listType === 'takilan' ? device.takilanComponents : device.components;
  },

  setComponentMatch(deviceIndex, listType, componentIndex, match) {
    const list = Components.getList(deviceIndex, listType);
    const component = list?.[componentIndex];
    if (!component || !match) return;

    component.name = match.name || component.name;
    component.serial = Components.supportsSerial(component.type) ? (match.serial || component.serial) : '';
    component.snipeitComponentId = match.id;
    component.snipeitComponentSnapshot = match;
    component.snipeitMatchStatus = 'matched';
    component.proposedNewComponentCategory = '';
    component.proposedNewComponentLocation = '';
  },

  setUnitMatch(deviceIndex, listType, componentIndex, unitIndex, match) {
    const list = Components.getList(deviceIndex, listType);
    const component = list?.[componentIndex];
    const unit = component?.units?.[unitIndex];
    if (!component || !unit || !match) return;

    unit.name = match.name || unit.name;
    unit.serial = Components.supportsSerial(component.type) ? (match.serial || unit.serial) : '';
    unit.snipeitComponentId = match.id;
    unit.snipeitComponentSnapshot = match;
    unit.snipeitMatchStatus = 'matched';
    unit.proposedNewComponentCategory = '';
    unit.proposedNewComponentLocation = '';
  },

  markComponentCreateNew(deviceIndex, listType, componentIndex) {
    if (!App.canEditCurrentSession()) return;
    const component = Components.getList(deviceIndex, listType)?.[componentIndex];
    if (!component || MULTI_TYPES.has(component.type)) return;
    component.snipeitComponentId = null;
    component.snipeitComponentSnapshot = null;
    component.snipeitMatchStatus = 'create_new';
    component.proposedNewComponentCategory = Components.resolveCategoryForType(component.type, component.name, component.serial);
    if (!component.proposedNewComponentLocation) {
      component.proposedNewComponentLocation = App.devices[deviceIndex]?.proposedNewAssetLocation || '';
    }
    Components.syncComponentRowState(deviceIndex, listType, componentIndex);
    App.render();
    App.scheduleAutoSave();
  },

  markUnitCreateNew(deviceIndex, listType, componentIndex, unitIndex) {
    if (!App.canEditCurrentSession()) return;
    const component = Components.getList(deviceIndex, listType)?.[componentIndex];
    const unit = component?.units?.[unitIndex];
    if (!component || !unit) return;
    unit.snipeitComponentId = null;
    unit.snipeitComponentSnapshot = null;
    unit.snipeitMatchStatus = 'create_new';
    unit.proposedNewComponentCategory = Components.resolveCategoryForType(component.type, unit.name, unit.serial);
    if (!unit.proposedNewComponentLocation) {
      unit.proposedNewComponentLocation = App.devices[deviceIndex]?.proposedNewAssetLocation || '';
    }
    Components.syncUnitRowState(deviceIndex, listType, componentIndex, unitIndex);
    App.render();
    App.scheduleAutoSave();
  },

  clearCreateNewComponent(deviceIndex, listType, componentIndex) {
    if (!App.canEditCurrentSession()) return;
    const component = Components.getList(deviceIndex, listType)?.[componentIndex];
    if (!component) return;
    Components.clearComponentMatch(component);
    Components.syncComponentRowState(deviceIndex, listType, componentIndex);
    App.render();
    App.scheduleAutoSave();
  },

  clearCreateNewUnit(deviceIndex, listType, componentIndex, unitIndex) {
    if (!App.canEditCurrentSession()) return;
    const component = Components.getList(deviceIndex, listType)?.[componentIndex];
    const unit = component?.units?.[unitIndex];
    if (!unit) return;
    Components.clearUnitMatch(unit);
    Components.syncUnitRowState(deviceIndex, listType, componentIndex, unitIndex);
    App.render();
    App.scheduleAutoSave();
  },

  syncComponentRowState(deviceIndex, listType, componentIndex) {
    const component = Components.getList(deviceIndex, listType)?.[componentIndex];
    const row = document.getElementById(`${listType}row_${deviceIndex}_${componentIndex}`);
    if (!component || !row) return;

    const isMatched = component.snipeitMatchStatus === 'matched';
    const isCreateNew = component.snipeitMatchStatus === 'create_new';
    row.classList.toggle('comp-row--matched', isMatched);
    row.classList.toggle('comp-row--unresolved', !isMatched && !isCreateNew);
    row.classList.toggle('comp-row--new', isCreateNew);

    if (!MULTI_TYPES.has(component.type)) {
      const badge = row.querySelector('.component-match-inline');
      if (badge) {
        badge.innerHTML = Components.renderMatchBadge(component.snipeitMatchStatus, component.snipeitComponentSnapshot);
      }
    }
  },

  syncUnitRowState(deviceIndex, listType, componentIndex, unitIndex) {
    const component = Components.getList(deviceIndex, listType)?.[componentIndex];
    const unit = component?.units?.[unitIndex];
    const row = document.getElementById(`${listType}row_${deviceIndex}_${componentIndex}`);
    if (!unit || !row) return;

    const badges = row.querySelectorAll('.comp-row-bottom .component-match-inline');
    const badge = badges[unitIndex];
    if (badge) {
      badge.innerHTML = Components.renderMatchBadge(unit.snipeitMatchStatus, unit.snipeitComponentSnapshot);
    }
  },

  dragState: null,

  listKey(listType) {
    return listType === 'takilan' ? 'takilanComponents' : 'components';
  },

  clearDragOverState() {
    document.querySelectorAll('.comp-row--drag-over').forEach((el) => el.classList.remove('comp-row--drag-over'));
    document.querySelectorAll('.comp-list--drag-over').forEach((el) => el.classList.remove('comp-list--drag-over'));
  },

  clearDragState() {
    Components.dragState = null;
    document.querySelectorAll('.comp-row--dragging').forEach((el) => el.classList.remove('comp-row--dragging'));
    Components.clearDragOverState();
  },

  canAcceptDrop(deviceIndex, listType) {
    const state = Components.dragState;
    if (!state || !App.canEditCurrentSession()) return false;
    if (state.deviceIndex !== deviceIndex) return false;
    return !!Components.getList(state.deviceIndex, state.listType) && !!Components.getList(deviceIndex, listType);
  },

  onDragStart(event, deviceIndex, listType, componentIndex) {
    if (!App.canEditCurrentSession()) return;
    const list = Components.getList(deviceIndex, listType);
    if (!list || componentIndex < 0 || componentIndex >= list.length) return;

    Components.clearDragState();
    Components.dragState = { deviceIndex, listType, componentIndex };
    const row = event.target.closest('.comp-row');
    if (row) row.classList.add('comp-row--dragging');

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `${deviceIndex}:${listType}:${componentIndex}`);
      if (row) {
        try {
          event.dataTransfer.setDragImage(row, 24, 12);
        } catch (_) {}
      }
    }
  },

  onDragEnd() {
    Components.clearDragState();
  },

  onDragOverRow(event, deviceIndex, listType, componentIndex) {
    if (!Components.canAcceptDrop(deviceIndex, listType)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    Components.clearDragOverState();
    event.currentTarget.classList.add('comp-row--drag-over');
  },

  onDragLeaveRow(event) {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    event.currentTarget.classList.remove('comp-row--drag-over');
  },

  onDropRow(event, deviceIndex, listType, componentIndex) {
    if (!Components.canAcceptDrop(deviceIndex, listType)) return;
    event.preventDefault();
    event.stopPropagation();
    let insertIndex = componentIndex;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientY > rect.top + rect.height / 2) insertIndex = componentIndex + 1;
    Components.finishDrop(deviceIndex, listType, insertIndex);
  },

  onDragOverList(event, deviceIndex, listType) {
    if (!Components.canAcceptDrop(deviceIndex, listType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    Components.clearDragOverState();
    event.currentTarget.classList.add('comp-list--drag-over');
  },

  onDragLeaveList(event) {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    event.currentTarget.classList.remove('comp-list--drag-over');
  },

  onDropList(event, deviceIndex, listType) {
    if (!Components.canAcceptDrop(deviceIndex, listType)) return;
    event.preventDefault();
    Components.finishDrop(deviceIndex, listType, null);
  },

  moveComponent(fromDeviceIndex, fromListType, fromIndex, toDeviceIndex, toListType, toIndex) {
    if (fromDeviceIndex !== toDeviceIndex) return false;

    const fromList = Components.getList(fromDeviceIndex, fromListType);
    const toList = Components.getList(toDeviceIndex, toListType);
    if (!fromList || !toList || fromIndex < 0 || fromIndex >= fromList.length) return false;

    const append = toIndex === null || toIndex === undefined;
    let insertIndex = append ? toList.length : Math.max(0, Math.min(toIndex, toList.length));

    if (fromList === toList && (insertIndex === fromIndex || insertIndex === fromIndex + 1)) {
      return false;
    }

    const [moved] = fromList.splice(fromIndex, 1);
    if (!moved) return false;

    if (fromList === toList && fromIndex < insertIndex) {
      insertIndex -= 1;
    }
    toList.splice(insertIndex, 0, moved);
    return true;
  },

  finishDrop(toDeviceIndex, toListType, toIndex) {
    const state = Components.dragState;
    if (!state) return;

    const moved = Components.moveComponent(state.deviceIndex, state.listType, state.componentIndex, toDeviceIndex, toListType, toIndex);
    Components.clearDragState();
    if (!moved) return;

    const affectedLists = new Set([state.listType, toListType]);
    affectedLists.forEach((listType) => {
      if (listType === 'takilan') Components.renderTakilanListFor(toDeviceIndex);
      else Components.renderCompListFor(toDeviceIndex);
    });
    App.render();
    App.scheduleAutoSave();
  },

  renderMatchBadge(matchStatus, snapshot) {
    if (matchStatus === 'matched' && snapshot) {
      return `<span class="component-match-badge matched">Envanter: ${snapshot.name || snapshot.serial || 'Kayıt'}</span>`;
    }
    if (matchStatus === 'create_new') {
      return `<span class="component-match-badge new">Envantere yeni eklenecek</span>`;
    }
    return `<span class="component-match-badge unresolved">Eşleşme yok</span>`;
  },

  renderCreateNewUnitFields(component, unit, deviceIndex, componentIndex, unitIndex, listType) {
    if (unit.snipeitMatchStatus !== 'create_new') return '';
    if (!unit.proposedNewComponentCategory) {
      unit.proposedNewComponentCategory = Components.resolveCategoryForType(component.type, unit.name, unit.serial);
    }
    const fn = listType === 'comp' ? 'Components.updateCompUnit' : 'Components.updateTakilanUnit';
    const keyBase = `locunit_${listType}_${deviceIndex}_${componentIndex}`;
    return `
      <div class="comp-row-bottom comp-row-bottom--single">
        <div class="search-wrap">
          <input type="text" value="${unit.proposedNewComponentLocation || ''}" placeholder="Envanter lokasyonu"
            ${Components.editableAttr()}
            oninput="${fn}(${deviceIndex}, ${componentIndex}, ${unitIndex}, 'proposedNewComponentLocation', this.value); Search.onComponentLocationSearch(this, '${keyBase}', ${unitIndex}, ${deviceIndex}, ${componentIndex}, ${unitIndex}, true)"
            onfocus="Search.onComponentLocationSearch(this, '${keyBase}', ${unitIndex}, ${deviceIndex}, ${componentIndex}, ${unitIndex}, true)"
            onkeydown="Search.onCompSearchKey(event, '${keyBase}', ${unitIndex})"
            onblur="Search.closeCompDD('${keyBase}', ${unitIndex}, 150)"
            autocomplete="off">
          <div class="search-dropdown" id="${Search.compDdId(keyBase, unitIndex)}"></div>
        </div>
        <div class="component-match-inline"><span class="component-match-badge matched">Kategori: ${unit.proposedNewComponentCategory || '-'}</span></div>
      </div>
    `;
  },

  renderCreateNewComponentFields(component, deviceIndex, componentIndex, listType) {
    if (component.snipeitMatchStatus !== 'create_new') return '';
    if (!component.proposedNewComponentCategory) {
      component.proposedNewComponentCategory = Components.resolveCategoryForType(component.type, component.name, component.serial);
    }
    const fn = listType === 'comp' ? 'Components.updateComp' : 'Components.updateTakilan';
    const keyBase = `loccomp_${listType}_${deviceIndex}`;
    return `
      <div class="comp-row-bottom comp-row-bottom--single">
        <div class="search-wrap">
          <input type="text" value="${component.proposedNewComponentLocation || ''}" placeholder="Envanter lokasyonu"
            ${Components.editableAttr()}
            oninput="${fn}(${deviceIndex}, ${componentIndex}, 'proposedNewComponentLocation', this.value); Search.onComponentLocationSearch(this, '${keyBase}', ${componentIndex}, ${deviceIndex}, ${componentIndex}, null, false)"
            onfocus="Search.onComponentLocationSearch(this, '${keyBase}', ${componentIndex}, ${deviceIndex}, ${componentIndex}, null, false)"
            onkeydown="Search.onCompSearchKey(event, '${keyBase}', ${componentIndex})"
            onblur="Search.closeCompDD('${keyBase}', ${componentIndex}, 150)"
            autocomplete="off">
          <div class="search-dropdown" id="${Search.compDdId(keyBase, componentIndex)}"></div>
        </div>
        <div class="component-match-inline"><span class="component-match-badge matched">Kategori: ${component.proposedNewComponentCategory || '-'}</span></div>
      </div>
    `;
  },

  renderUnitAction(unit, deviceIndex, componentIndex, unitIndex, listType) {
    if (!App.canEditCurrentSession()) return '';
    if (unit.snipeitMatchStatus === 'create_new') {
      return `<button class="btn btn-ghost btn-sm" type="button" onclick="Components.clearCreateNewUnit(${deviceIndex}, '${listType}', ${componentIndex}, ${unitIndex})">Eşleştirmeye Dön</button>`;
    }
    if (unit.snipeitMatchStatus === 'matched') return '';
    return `<button class="btn btn-ghost btn-sm" type="button" onclick="Components.markUnitCreateNew(${deviceIndex}, '${listType}', ${componentIndex}, ${unitIndex})">Envantere Yeni Ekle</button>`;
  },

  renderComponentAction(component, deviceIndex, componentIndex, listType) {
    if (!App.canEditCurrentSession() || MULTI_TYPES.has(component.type)) return '';
    if (component.snipeitMatchStatus === 'create_new') {
      return `<button class="btn btn-ghost btn-sm" type="button" onclick="Components.clearCreateNewComponent(${deviceIndex}, '${listType}', ${componentIndex})">Eşleştirmeye Dön</button>`;
    }
    if (component.snipeitMatchStatus === 'matched') return '';
    return `<button class="btn btn-ghost btn-sm" type="button" onclick="Components.markComponentCreateNew(${deviceIndex}, '${listType}', ${componentIndex})">Envantere Yeni Ekle</button>`;
  },

  renderUnitRows(component, deviceIndex, componentIndex, listType) {
    const fn = listType === 'comp' ? 'Components.updateCompUnit' : 'Components.updateTakilanUnit';
    const prefix = listType === 'comp' ? 'compdd' : 'takilandd';
    const showHealth = Components.supportsHealth(component.type);
    return component.units.map((unit, unitIndex) => {
      const actionHtml = Components.renderUnitAction(unit, deviceIndex, componentIndex, unitIndex, listType);
      const createNewHtml = Components.renderCreateNewUnitFields(component, unit, deviceIndex, componentIndex, unitIndex, listType);
      return `
      <div class="comp-row-bottom ${showHealth ? '' : 'comp-row-bottom--no-health'}">
        <div class="search-wrap">
          <input type="text" value="${unit.name}" placeholder="Model"
            ${Components.editableAttr()}
            oninput="${fn}(${deviceIndex}, ${componentIndex}, ${unitIndex}, 'name', this.value); Search.onUnitSearch(this, '${listType}', ${deviceIndex}, ${componentIndex}, ${unitIndex}, 'name')"
            onkeydown="Search.onCompSearchKey(event, 'unit_${listType}_${deviceIndex}_${componentIndex}', ${unitIndex})"
            onblur="Search.closeCompDD('unit_${listType}_${deviceIndex}_${componentIndex}', ${unitIndex}, 150)"
            autocomplete="off">
          <div class="search-dropdown" id="${prefix}_${deviceIndex}_${componentIndex}_${unitIndex}"></div>
        </div>
        <div class="search-wrap">
          <input type="text" value="${unit.serial}" placeholder="Seri No"
            ${Components.editableAttr()}
            oninput="${fn}(${deviceIndex}, ${componentIndex}, ${unitIndex}, 'serial', this.value); Search.onUnitSearch(this, '${listType}', ${deviceIndex}, ${componentIndex}, ${unitIndex}, 'serial')"
            onkeydown="Search.onCompSearchKey(event, 'sn_unit_${listType}_${deviceIndex}_${componentIndex}', ${unitIndex})"
            onblur="Search.closeCompDD('sn_unit_${listType}_${deviceIndex}_${componentIndex}', ${unitIndex}, 150)"
            autocomplete="off">
          <div class="search-dropdown" id="sn${prefix}_${deviceIndex}_${componentIndex}_${unitIndex}"></div>
        </div>
        ${showHealth ? `<input type="number" min="0" max="100" value="${unit.health}" placeholder="%"
          ${Components.editableAttr()} class="input-center" oninput="${fn}(${deviceIndex}, ${componentIndex}, ${unitIndex}, 'health', this.value)" title="Saglik %">` : ''}
        <div class="component-match-inline">${Components.renderMatchBadge(unit.snipeitMatchStatus, unit.snipeitComponentSnapshot)}</div>
      </div>
      ${actionHtml ? `<div class="comp-row-bottom comp-row-bottom--single">${actionHtml}</div>` : ''}
      ${createNewHtml}
    `;
    }).join('');
  },

  renderCompRows(list, deviceIndex, listType) {
    const removeFn = listType === 'comp' ? 'Components.removeComponent' : 'Components.removeTakilan';
    const updateFn = listType === 'comp' ? 'Components.updateComp' : 'Components.updateTakilan';
    const dropdownPrefix = listType === 'comp' ? 'compdd' : 'takilandd';

    return list.map((component, componentIndex) => {
      const isMulti = MULTI_TYPES.has(component.type);
      const options = TYPES.map((type) => `<option${component.type === type ? ' selected' : ''}>${type}</option>`).join('');
      const componentActionHtml = Components.renderComponentAction(component, deviceIndex, componentIndex, listType);
      const createNewComponentHtml = Components.renderCreateNewComponentFields(component, deviceIndex, componentIndex, listType);
      const bottomHtml = isMulti
        ? Components.renderUnitRows(component, deviceIndex, componentIndex, listType)
        : `
          <div class="comp-row-bottom comp-row-bottom--single">
            <div class="search-wrap">
              <input type="text" value="${component.name}" placeholder="Model"
                ${Components.editableAttr()}
                oninput="${updateFn}(${deviceIndex}, ${componentIndex}, 'name', this.value); Search.onComponentSearch(this, '${listType}', ${deviceIndex}, ${componentIndex}, 'name')"
                onkeydown="Search.onCompSearchKey(event, '${listType}_${deviceIndex}', ${componentIndex})"
                onblur="Search.closeCompDD('${listType}_${deviceIndex}', ${componentIndex}, 150)"
                autocomplete="off">
              <div class="search-dropdown" id="${dropdownPrefix}_${deviceIndex}_${componentIndex}"></div>
            </div>
            ${Components.supportsSerial(component.type) ? `
              <div class="search-wrap">
                <input type="text" value="${component.serial}" placeholder="Seri No"
                  ${Components.editableAttr()}
                  oninput="${updateFn}(${deviceIndex}, ${componentIndex}, 'serial', this.value); Search.onComponentSearch(this, '${listType}', ${deviceIndex}, ${componentIndex}, 'serial')"
                  onkeydown="Search.onCompSearchKey(event, 'sn_${listType}_${deviceIndex}', ${componentIndex})"
                  onblur="Search.closeCompDD('sn_${listType}_${deviceIndex}', ${componentIndex}, 150)"
                  autocomplete="off">
                <div class="search-dropdown" id="sn${dropdownPrefix}_${deviceIndex}_${componentIndex}"></div>
              </div>
            ` : ''}
            <div class="component-match-inline">${Components.renderMatchBadge(component.snipeitMatchStatus, component.snipeitComponentSnapshot)}</div>
          </div>
          ${componentActionHtml ? `<div class="comp-row-bottom comp-row-bottom--single">${componentActionHtml}</div>` : ''}
          ${createNewComponentHtml}
        `;

      return `
        <div class="comp-row ${component.snipeitMatchStatus === 'matched' ? 'comp-row--matched' : component.snipeitMatchStatus === 'create_new' ? 'comp-row--new' : 'comp-row--unresolved'}" id="${listType}row_${deviceIndex}_${componentIndex}"
          ondragover="Components.onDragOverRow(event, ${deviceIndex}, '${listType}', ${componentIndex})"
          ondragleave="Components.onDragLeaveRow(event)"
          ondrop="Components.onDropRow(event, ${deviceIndex}, '${listType}', ${componentIndex})">
          <div class="comp-row-top">
            <button class="btn btn-ghost comp-drag-handle" type="button" ${App.canEditCurrentSession() ? '' : 'disabled'} draggable="${App.canEditCurrentSession() ? 'true' : 'false'}"
              onmousedown="event.stopPropagation()"
              ondragstart="Components.onDragStart(event, ${deviceIndex}, '${listType}', ${componentIndex})"
              ondragend="Components.onDragEnd()"
              title="Surukle">
              <span class="material-symbols-outlined md">drag_indicator</span>
            </button>
            <select onchange="${updateFn}(${deviceIndex}, ${componentIndex}, 'type', this.value)" ${Components.editableAttr()} style="width:100%">${options}</select>
            <input type="number" min="1" max="32" value="${component.qty}" ${Components.editableAttr()}
              onchange="${updateFn}(${deviceIndex}, ${componentIndex}, 'qty', parseInt(this.value, 10) || 1)" style="text-align:center">
            <button class="btn btn-danger btn-icon" type="button" ${App.canEditCurrentSession() ? '' : 'disabled'} onclick="${removeFn}(${deviceIndex}, ${componentIndex})"><span class="material-symbols-outlined md">close</span></button>
          </div>
          ${bottomHtml}
        </div>
      `;
    }).join('');
  },

  renderCompListFor(deviceIndex) {
    const el = document.getElementById(`compList_${deviceIndex}`);
    if (el) el.innerHTML = Components.renderCompRows(App.devices[deviceIndex].components, deviceIndex, 'comp');
  },

  renderTakilanListFor(deviceIndex) {
    const el = document.getElementById(`takilanList_${deviceIndex}`);
    if (el) el.innerHTML = Components.renderCompRows(App.devices[deviceIndex].takilanComponents, deviceIndex, 'takilan');
  }
};
