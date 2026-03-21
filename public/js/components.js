const MULTI_TYPES = new Set(['DISK','NIC']);
const TYPES = ['CPU','RAM','DISK','NIC'];

const Components = {
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
        ? Array.from({length:qty}, (_, i) => ({
            name:   (data.units&&data.units[i]) ? data.units[i].name   : (data.name||''),
            serial: (data.units&&data.units[i]) ? data.units[i].serial : (i === 0 ? (data.serial||'') : ''),
            health: (data.units&&data.units[i]) ? data.units[i].health : ''
          }))
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
      c.units=MULTI_TYPES.has(val)?Array.from({length:c.qty},()=>({name:'',serial:'',health:''})):[];
      Components.renderCompListFor(di); App.render();
    } else if (key==='qty') {
      const qty=parseInt(val)||1; c.qty=qty;
      if (MULTI_TYPES.has(c.type)) {
        while(c.units.length<qty) c.units.push({name:'',serial:'',health:''});
        c.units=c.units.slice(0,qty);
        Components.renderCompListFor(di);
      }
      App.render();
    } else { c[key]=val; App.render(); }
    App.scheduleAutoSave();
  },
  updateCompUnit(di, ci, ui, key, val) {
    App.devices[di].components[ci].units[ui][key]=val; App.render(); App.scheduleAutoSave();
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
      c.units=MULTI_TYPES.has(val)?Array.from({length:c.qty},()=>({name:'',serial:'',health:''})):[];
      Components.renderTakilanListFor(di); App.render();
    } else if (key==='qty') {
      const qty=parseInt(val)||1; c.qty=qty;
      if (MULTI_TYPES.has(c.type)) {
        while(c.units.length<qty) c.units.push({name:'',serial:'',health:''});
        c.units=c.units.slice(0,qty);
        Components.renderTakilanListFor(di);
      }
      App.render();
    } else { c[key]=val; App.render(); }
    App.scheduleAutoSave();
  },
  updateTakilanUnit(di, ci, ui, key, val) {
    App.devices[di].takilanComponents[ci].units[ui][key]=val; App.render(); App.scheduleAutoSave();
  },

  renderUnitRows(c, di, ci, listType) {
    const fn  = listType === 'comp' ? 'Components.updateCompUnit' : 'Components.updateTakilanUnit';
    const pfx = listType === 'comp' ? 'compdd' : 'takilandd';
    return c.units.map((u, ui) => `
      <div class="comp-row-bottom">
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
        <input type="number" min="0" max="100" value="${u.health}" placeholder="%"
          style="text-align:center" oninput="${fn}(${di},${ci},${ui},'health',this.value)" title="Sağlık %">
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
      return `<div class="comp-row" id="${listType}row_${di}_${ci}">
        <div class="comp-row-top">
          <select onchange="${updateFn}(${di},${ci},'type',this.value)" style="width:100%">${opts}</select>
          <input type="number" min="1" max="32" value="${c.qty}"
            onchange="${updateFn}(${di},${ci},'qty',parseInt(this.value)||1)" style="text-align:center">
          <button class="btn btn-danger" onclick="${removeFn}(${di},${ci})" style="padding:2px 4px"><span class="material-symbols-outlined" style="font-size:15px">close</span></button>
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
