const Search = {
  _searchTimer: null,
  _compSearchTimer: null,

  highlight(text, query) {
    if (!text) return '\u2014';
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return text.slice(0, idx)
      + `<span class="hi">${text.slice(idx, idx + query.length)}</span>`
      + text.slice(idx + query.length);
  },

  closeAllDropdowns() {
    document.querySelectorAll('.search-dropdown.open').forEach(dd => dd.classList.remove('open'));
  },

  // Device inventory search (server-side)
  onSearchInput(input, field, di) {
    const q = input.value.trim();
    const dd = document.getElementById('dd_'+field+'_'+di);
    if (!dd) return;
    if (!App.ddState[di]) App.ddState[di] = {};
    if (!App.ddState[di][field]) App.ddState[di][field] = {selected:-1};
    App.ddState[di][field].selected = -1;

    if (!q || q.length < 2) { dd.classList.remove('open'); return; }

    clearTimeout(Search._searchTimer);
    Search._searchTimer = setTimeout(async () => {
      const results = await API.get('/api/inventory/assets?q=' + encodeURIComponent(q));
      if (!results || results.length === 0) {
        dd.innerHTML = '<div class="search-empty">Sonuç bulunamadı</div>';
        dd.classList.add('open');
        return;
      }
      Search._lastAssetResults = results;
      dd.innerHTML = results.map((d, i) => {
        const model  = d.Model || d.model || '\u2014';
        const etiket = d['Asset Tag'] || '\u2014';
        const serial = d.Serial || '\u2014';
        return `<div class="search-item" onmousedown="Search.selectDevice(${i},${di})">
          <div class="search-item-main">${Search.highlight(model,q)} &middot; <span style="color:var(--accent2)">${Search.highlight(etiket,q)}</span></div>
          <div class="search-item-sub">SN: ${Search.highlight(serial,q)}</div>
        </div>`;
      }).join('');
      dd.classList.add('open');
    }, 200);
  },

  onSearchKey(event, field, di) {
    const dd = document.getElementById('dd_'+field+'_'+di);
    if (!dd || !dd.classList.contains('open')) return;
    const items = dd.querySelectorAll('.search-item');
    if (items.length === 0) return;
    if (!App.ddState[di]) App.ddState[di] = {};
    if (!App.ddState[di][field]) App.ddState[di][field] = {selected:-1};
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      App.ddState[di][field].selected = Math.min(App.ddState[di][field].selected+1, items.length-1);
      items.forEach((el,i) => el.classList.toggle('active', i===App.ddState[di][field].selected));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      App.ddState[di][field].selected = Math.max(App.ddState[di][field].selected-1, 0);
      items.forEach((el,i) => el.classList.toggle('active', i===App.ddState[di][field].selected));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const sel = App.ddState[di][field].selected;
      if (sel >= 0 && items[sel]) items[sel].dispatchEvent(new MouseEvent('mousedown'));
    } else if (event.key === 'Escape') {
      dd.classList.remove('open');
    }
  },

  closeDropdown(field, di, delay) {
    setTimeout(() => {
      const dd = document.getElementById('dd_'+field+'_'+di);
      if (dd) dd.classList.remove('open');
    }, delay||0);
  },

  selectDevice(resultIdx, di) {
    const d = Search._lastAssetResults[resultIdx];
    if (!d) return;
    App.devices[di].model  = d.Model || '';
    App.devices[di].etiket = d['Asset Tag'] || '';
    App.devices[di].seri   = d.Serial || '';
    ['model','etiket','seri'].forEach(f => {
      const dd = document.getElementById('dd_'+f+'_'+di);
      if (dd) dd.classList.remove('open');
    });
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
    App.showToast((d.Model||'') + ' ' + (d['Asset Tag']||'') + ' yüklendi');
  },

  _lastAssetResults: [],
  _lastCompResults: [],

  // Component inventory search (server-side)
  compDdId(listType, rowIdx) {
    const isSn = listType.startsWith('sn_');
    const actual = isSn ? listType.slice(3) : listType;
    const parts = actual.split('_');
    const prefix = parts[0] === 'comp' ? 'compdd' : 'takilandd';
    const snTag = isSn ? 'sn' : '';
    if (parts.length === 2) return `${snTag}${prefix}_${parts[1]}_${rowIdx}`;
    return `${snTag}${prefix}_${parts[1]}_${parts[2]}_${rowIdx}`;
  },

  onCompSearch(input, listType, rowIdx) {
    const q = input.value.trim();
    const dd = document.getElementById(Search.compDdId(listType, rowIdx));
    if (!dd) return;
    if (!q || q.length < 2) { dd.classList.remove('open'); return; }

    clearTimeout(Search._compSearchTimer);
    Search._compSearchTimer = setTimeout(async () => {
      const results = await API.get('/api/inventory/components?q=' + encodeURIComponent(q));
      if (!results || results.length === 0) {
        dd.innerHTML = '<div class="search-empty">Sonuç bulunamadı</div>';
        dd.classList.add('open');
        return;
      }
      Search._lastCompResults = results;
      dd.innerHTML = results.map((item, idx) => `
        <div class="search-item" onmousedown="Search.selectComponent('${listType}',${rowIdx},${idx})">
          <div class="search-item-main">${Search.highlight(item.Name||'', q)}</div>
          <div class="search-item-sub">${item.Category||''}${item.Serial ? ' &middot; SN: ' + item.Serial : ''}</div>
        </div>
      `).join('');
      dd.classList.add('open');
    }, 200);
  },

  onCompSearchKey(event, listType, rowIdx) {
    const dd = document.getElementById(Search.compDdId(listType, rowIdx));
    if (!dd || !dd.classList.contains('open')) return;
    const items = dd.querySelectorAll('.search-item');
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = dd.querySelector('.search-item.active');
      const idx  = next ? [...items].indexOf(next) + 1 : 0;
      items.forEach(el => el.classList.remove('active'));
      if (items[Math.min(idx, items.length-1)]) items[Math.min(idx, items.length-1)].classList.add('active');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const cur = dd.querySelector('.search-item.active');
      const idx = cur ? [...items].indexOf(cur) - 1 : items.length - 1;
      items.forEach(el => el.classList.remove('active'));
      if (items[Math.max(idx, 0)]) items[Math.max(idx, 0)].classList.add('active');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const active = dd.querySelector('.search-item.active');
      if (active) active.dispatchEvent(new MouseEvent('mousedown'));
    } else if (event.key === 'Escape') {
      Search.closeAllDropdowns();
    }
  },

  closeCompDD(listType, rowIdx, delay) {
    setTimeout(() => {
      const dd = document.getElementById(Search.compDdId(listType, rowIdx));
      if (dd) dd.classList.remove('open');
    }, delay);
  },

  inferType(category) {
    const c = (category || '').toLowerCase();
    if (c.includes('disk') || c.includes('sas') || c.includes('ssd') || c.includes('hdd') || c.includes('nvme')) return 'DISK';
    if (c.includes('ram') || c.includes('memory') || c.includes('dimm')) return 'RAM';
    if (c.includes('cpu') || c.includes('processor') || c.includes('xeon')) return 'CPU';
    if (c.includes('nic') || c.includes('network') || c.includes('ethernet') || c.includes('adapter')) return 'NIC';
    return null;
  },

  selectComponent(listType, rowIdx, compIdx) {
    const comp = Search._lastCompResults[compIdx];
    if (!comp) return;
    const name   = comp.Name   || '';
    const serial = comp.Serial || '';
    const type   = Search.inferType(comp.Category);
    const actualListType = listType.startsWith('sn_') ? listType.slice(3) : listType;
    const parts  = actualListType.split('_');
    const prefix = parts[0];
    const di     = parseInt(parts[1]);
    const arr    = prefix === 'comp' ? App.devices[di].components : App.devices[di].takilanComponents;

    if (parts.length === 3) {
      const ci = parseInt(parts[2]);
      arr[ci].units[rowIdx].name   = name;
      arr[ci].units[rowIdx].serial = serial;
    } else {
      arr[rowIdx].name   = name;
      arr[rowIdx].serial = serial;
      if (type) arr[rowIdx].type = type;
    }
    if (prefix === 'comp') Components.renderCompListFor(di); else Components.renderTakilanListFor(di);
    App.render();
    App.scheduleAutoSave();
  }
};

// Close dropdowns on outside click
document.addEventListener('mousedown', e => {
  if (!e.target.closest('.search-wrap')) Search.closeAllDropdowns();
});
