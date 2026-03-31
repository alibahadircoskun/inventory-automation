const MULTI_TYPES = new Set(['DISK','NIC']);
const TYPES = ['CPU','RAM','DISK','NIC'];

const Components = {
  supportsHealth(type) {
    return type === 'DISK';
  },

  makeUnit(type, unitData, fallbackName, fallbackSerial) {
    const src = unitData || {};
    return {
      name: src.name !== undefined ? src.name : (fallbackName || ''),
      serial: src.serial !== undefined ? src.serial : (fallbackSerial || ''),
      health: Components.supportsHealth(type) && src.health !== undefined ? src.health : ''
    };
  },

  makeComp(data) {
    data = data || {};
    const qty  = data.qty  || 1;
    const type = data.type || 'CPU';
    return {
      type, qty,
      name:   data.name   || '',
      serial: data.serial || '',
      health: data.health !== undefined ? data.health : '',
      units: MULTI_TYPES.has(type)
        ? Array.from({length:qty}, (_, i) => Components.makeUnit(
            type,
            (data.units && data.units[i]) ? data.units[i] : null,
            data.name || '',
            i === 0 ? (data.serial || '') : ''
          ))
        : []
    };
  },

  addComponent(di, data) {
    App.devices[di].components.push(Components.makeComp(data||{}));
    Components.renderCompListFor(di); App.render(); App.scheduleAutoSave();
  },
  removeComponent(di, ci) {
    App.devices[di].components.splice(ci,1);
    Components.renderCompListFor(di); App.render(); App.scheduleAutoSave();
  },
  updateComp(di, ci, key, val) {
    const c = App.devices[di].components[ci];
    if (key==='type') {
      c.type=val;
      c.units=MULTI_TYPES.has(val)?Array.from({length:c.qty},()=>Components.makeUnit(val)):[];
      Components.renderCompListFor(di); App.render();
    } else if (key==='qty') {
      const qty=parseInt(val)||1; c.qty=qty;
      if (MULTI_TYPES.has(c.type)) {
        while(c.units.length<qty) c.units.push(Components.makeUnit(c.type));
        c.units=c.units.slice(0,qty);
        Components.renderCompListFor(di);
      }
      App.render();
    } else { c[key]=val; App.render(); }
    App.scheduleAutoSave();
  },
  updateCompUnit(di, ci, ui, key, val) {
    const comp = App.devices[di].components[ci];
    if (key==='health' && !Components.supportsHealth(comp.type)) {
      comp.units[ui].health='';
    } else {
      comp.units[ui][key]=val;
    }
    App.render(); App.scheduleAutoSave();
  },

  addTakilan(di, data) {
    App.devices[di].takilanComponents.push(Components.makeComp(data||{}));
    Components.renderTakilanListFor(di); App.render(); App.scheduleAutoSave();
  },
  removeTakilan(di, ci) {
    App.devices[di].takilanComponents.splice(ci,1);
    Components.renderTakilanListFor(di); App.render(); App.scheduleAutoSave();
  },
  updateTakilan(di, ci, key, val) {
    const c = App.devices[di].takilanComponents[ci];
    if (key==='type') {
      c.type=val;
      c.units=MULTI_TYPES.has(val)?Array.from({length:c.qty},()=>Components.makeUnit(val)):[];
      Components.renderTakilanListFor(di); App.render();
    } else if (key==='qty') {
      const qty=parseInt(val)||1; c.qty=qty;
      if (MULTI_TYPES.has(c.type)) {
        while(c.units.length<qty) c.units.push(Components.makeUnit(c.type));
        c.units=c.units.slice(0,qty);
        Components.renderTakilanListFor(di);
      }
      App.render();
    } else { c[key]=val; App.render(); }
    App.scheduleAutoSave();
  },
  updateTakilanUnit(di, ci, ui, key, val) {
    const comp = App.devices[di].takilanComponents[ci];
    if (key==='health' && !Components.supportsHealth(comp.type)) {
      comp.units[ui].health='';
    } else {
      comp.units[ui][key]=val;
    }
    App.render(); App.scheduleAutoSave();
  },

  dragState: null,

  listKey(listType) {
    return listType === 'takilan' ? 'takilanComponents' : 'components';
  },

  getList(di, listType) {
    const device = App.devices[di];
    if (!device) return null;
    const list = device[Components.listKey(listType)];
    return Array.isArray(list) ? list : null;
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

  canAcceptDrop(di, listType) {
    const state = Components.dragState;
    if (!state) return false;
    if (state.di !== di) return false;
    return !!Components.getList(state.di, state.listType) && !!Components.getList(di, listType);
  },

  onDragStart(event, di, listType, ci) {
    const list = Components.getList(di, listType);
    if (!list || ci < 0 || ci >= list.length) return;

    Components.clearDragState();
    Components.dragState = { di, listType, ci };

    if (typeof Search !== 'undefined' && typeof Search.closeAllDropdowns === 'function') {
      Search.closeAllDropdowns();
    }

    const row = event.target.closest('.comp-row');
    if (row) {
      row.classList.add('comp-row--dragging');
    }

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `${di}:${listType}:${ci}`);
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

  onDragOverRow(event, di, listType, ci) {
    if (!Components.canAcceptDrop(di, listType)) return;
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

  onDropRow(event, di, listType, ci) {
    if (!Components.canAcceptDrop(di, listType)) return;
    event.preventDefault();
    event.stopPropagation();

    let insertIndex = ci;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientY > rect.top + rect.height / 2) insertIndex = ci + 1;

    Components.finishDrop(di, listType, insertIndex);
  },

  onDragOverList(event, di, listType) {
    if (!Components.canAcceptDrop(di, listType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    Components.clearDragOverState();
    event.currentTarget.classList.add('comp-list--drag-over');
  },

  onDragLeaveList(event) {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    event.currentTarget.classList.remove('comp-list--drag-over');
  },

  onDropList(event, di, listType) {
    if (!Components.canAcceptDrop(di, listType)) return;
    event.preventDefault();
    Components.finishDrop(di, listType, null);
  },

  moveComponent(fromDi, fromListType, fromIndex, toDi, toListType, toIndex) {
    if (fromDi !== toDi) return false;

    const fromList = Components.getList(fromDi, fromListType);
    const toList = Components.getList(toDi, toListType);
    if (!fromList || !toList) return false;
    if (fromIndex < 0 || fromIndex >= fromList.length) return false;

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

  finishDrop(toDi, toListType, toIndex) {
    const state = Components.dragState;
    if (!state) return;

    const moved = Components.moveComponent(state.di, state.listType, state.ci, toDi, toListType, toIndex);
    Components.clearDragState();
    if (!moved) return;

    if (typeof Search !== 'undefined' && typeof Search.closeAllDropdowns === 'function') {
      Search.closeAllDropdowns();
    }

    const affectedLists = new Set([state.listType, toListType]);
    affectedLists.forEach((listType) => {
      if (listType === 'takilan') Components.renderTakilanListFor(toDi);
      else Components.renderCompListFor(toDi);
    });
    App.render();
    App.scheduleAutoSave();
  },

  renderUnitRows(c, di, ci, listType) {
    const fn  = listType === 'comp' ? 'Components.updateCompUnit' : 'Components.updateTakilanUnit';
    const pfx = listType === 'comp' ? 'compdd' : 'takilandd';
    const showHealth = Components.supportsHealth(c.type);
    const rowClass = showHealth ? 'comp-row-bottom' : 'comp-row-bottom comp-row-bottom--no-health';
    return c.units.map((u, ui) => `
      <div class="${rowClass}">
        <div class="search-wrap">
          <input type="text" value="${u.name}" placeholder="Model"
            oninput="${fn}(${di},${ci},${ui},'name',this.value);Search.onCompSearch(this,'${listType}_${di}_${ci}',${ui})"
            onkeydown="Search.onCompSearchKey(event,'${listType}_${di}_${ci}',${ui})"
            onblur="Search.closeCompDD('${listType}_${di}_${ci}',${ui},150)"
            onfocus="Search.closeAllDropdowns()"
            autocomplete="off" style="width:100%">
          <div class="search-dropdown" id="${pfx}_${di}_${ci}_${ui}"></div>
        </div>
        <div class="search-wrap">
          <input type="text" value="${u.serial}" placeholder="Seri No"
            oninput="${fn}(${di},${ci},${ui},'serial',this.value);Search.onCompSearch(this,'sn_${listType}_${di}_${ci}',${ui})"
            onkeydown="Search.onCompSearchKey(event,'sn_${listType}_${di}_${ci}',${ui})"
            onblur="Search.closeCompDD('sn_${listType}_${di}_${ci}',${ui},150)"
            onfocus="Search.closeAllDropdowns()"
            autocomplete="off" style="min-width:0">
          <div class="search-dropdown" id="sn${pfx}_${di}_${ci}_${ui}"></div>
        </div>
        ${showHealth ? `<input type="number" min="0" max="100" value="${u.health}" placeholder="%"
          style="text-align:center" oninput="${fn}(${di},${ci},${ui},'health',this.value)" title="Sağlık %">` : ''}
      </div>`).join('');
  },

  renderCompRows(list, di, listType) {
    const removeFn = listType === 'comp' ? 'Components.removeComponent' : 'Components.removeTakilan';
    const updateFn = listType === 'comp' ? 'Components.updateComp'      : 'Components.updateTakilan';
    const ddPfx    = listType === 'comp' ? 'compdd'          : 'takilandd';
    return list.map((c, ci) => {
      const isMulti = MULTI_TYPES.has(c.type);
      const opts = TYPES.map(t => `<option${c.type===t?' selected':''}>${t}</option>`).join('');
      const bottomHtml = isMulti
        ? Components.renderUnitRows(c, di, ci, listType)
        : `<div class="comp-row-bottom comp-row-bottom--single">
            <div class="search-wrap">
              <input type="text" value="${c.name}" placeholder="Model"
                oninput="${updateFn}(${di},${ci},'name',this.value);Search.onCompSearch(this,'${listType}_${di}',${ci})"
                onkeydown="Search.onCompSearchKey(event,'${listType}_${di}',${ci})"
                onblur="Search.closeCompDD('${listType}_${di}',${ci},150)"
                autocomplete="off" style="width:100%">
              <div class="search-dropdown" id="${ddPfx}_${di}_${ci}"></div>
            </div>
          </div>`;
      return `<div class="comp-row" id="${listType}row_${di}_${ci}"
        ondragover="Components.onDragOverRow(event,${di},'${listType}',${ci})"
        ondragleave="Components.onDragLeaveRow(event)"
        ondrop="Components.onDropRow(event,${di},'${listType}',${ci})">
        <div class="comp-row-top">
          <button class="btn btn-ghost comp-drag-handle" type="button" draggable="true"
            onmousedown="event.stopPropagation()"
            ondragstart="Components.onDragStart(event,${di},'${listType}',${ci})"
            ondragend="Components.onDragEnd()"
            title="Sürükle">
            <span class="material-symbols-outlined" style="font-size:16px">drag_indicator</span>
          </button>
          <select onchange="${updateFn}(${di},${ci},'type',this.value)" style="width:100%">${opts}</select>
          <input type="number" min="1" max="32" value="${c.qty}"
            onchange="${updateFn}(${di},${ci},'qty',parseInt(this.value)||1)" style="text-align:center">
          <button class="btn btn-danger" type="button" onclick="${removeFn}(${di},${ci})" style="padding:2px 4px"><span class="material-symbols-outlined" style="font-size:15px">close</span></button>
        </div>${bottomHtml}</div>`;
    }).join('');
  },

  renderCompListFor(di) {
    const el = document.getElementById('compList_'+di);
    if (el) el.innerHTML = Components.renderCompRows(App.devices[di].components, di, 'comp');
  },
  renderTakilanListFor(di) {
    const el = document.getElementById('takilanList_'+di);
    if (el) el.innerHTML = Components.renderCompRows(App.devices[di].takilanComponents, di, 'takilan');
  }
};
