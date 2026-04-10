const Search = {
  assetTimer: null,
  componentTimer: null,
  metaTimer: null,
  componentResults: new Map(),
  assetResults: new Map(),
  locationResults: new Map(),
  snipeStatusFetchedAt: 0,

  highlight(text, query) {
    if (!text) return '-';
    if (!query) return text;
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    if (index === -1) return text;
    return `${text.slice(0, index)}<span class="hi">${text.slice(index, index + query.length)}</span>${text.slice(index + query.length)}`;
  },

  async ensureSnipeStatus(force = false) {
    if (!force && Date.now() - Search.snipeStatusFetchedAt < 15000 && App.snipeStatus) {
      return App.snipeStatus;
    }

    try {
      const status = await API.get('/api/snipeit/status');
      Search.snipeStatusFetchedAt = Date.now();
      await App.updateSnipeStatus(status);
      return status;
    } catch (error) {
      const fallback = error.data || { configured: false, healthy: false, error: error.message };
      Search.snipeStatusFetchedAt = Date.now();
      await App.updateSnipeStatus(fallback);
      return fallback;
    }
  },

  async searchAssets(query) {
    const status = await Search.ensureSnipeStatus();
    if (status.healthy) {
      try {
        return await API.get(`/api/snipeit/assets/search?q=${encodeURIComponent(query)}`);
      } catch (_) {}
    }

    const local = await API.get(`/api/inventory/assets?q=${encodeURIComponent(query)}`);
    return (local || []).map((row) => ({
      id: null,
      source: 'local',
      asset_tag: row['Asset Tag'] || '',
      serial: row.Serial || '',
      model: row.Model || '',
      location: row.Location || '',
      status_label: row.Status || ''
    }));
  },

  async fetchCurrentState(assetId) {
    const result = await API.get(`/api/snipeit/assets/${encodeURIComponent(assetId)}/current-state`);
    return {
      snapshot: result?.snapshot || null,
      fetchedAt: result?.fetched_at || null
    };
  },

  async hydrateDeviceCurrentState(deviceIndex, { showWarning = false } = {}) {
    const device = App.devices[deviceIndex];
    if (!device || device.assetResolutionMode !== 'matched' || !device.snipeitAssetId) {
      return false;
    }

    try {
      const state = await Search.fetchCurrentState(device.snipeitAssetId);
      device.currentStateSnapshot = state.snapshot;
      device.currentStateFetchedAt = state.fetchedAt;
      return true;
    } catch (error) {
      if (showWarning) {
        App.showToast(error?.data?.error || 'Mevcut cihaz durumu alınamadı', 'warn');
      }
      return false;
    }
  },

  async searchComponents(query) {
    const status = await Search.ensureSnipeStatus();
    if (status.healthy) {
      try {
        return await API.get(`/api/snipeit/components/search?q=${encodeURIComponent(query)}`);
      } catch (_) {}
    }

    const local = await API.get(`/api/inventory/components?q=${encodeURIComponent(query)}`);
    return (local || []).map((row) => ({
      id: null,
      source: 'local',
      name: row.Name || '',
      serial: row.Serial || '',
      category: row.Category || '',
      location: row.Location || '',
      remaining: row.Remaining || 0,
      qty: row.Total || 0
    }));
  },

  async searchStatusLabels(query) {
    const status = await Search.ensureSnipeStatus();
    if (!status.healthy) return [];
    try {
      return await API.get(`/api/snipeit/statuslabels/search?q=${encodeURIComponent(query)}`);
    } catch (_) {
      return [];
    }
  },

  async searchLocations(query) {
    const status = await Search.ensureSnipeStatus();
    if (!status.healthy) return [];
    try {
      return await API.get(`/api/snipeit/locations/search?q=${encodeURIComponent(query)}`);
    } catch (_) {
      return [];
    }
  },

  closeAllDropdowns() {
    document.querySelectorAll('.search-dropdown.open').forEach((dropdown) => dropdown.classList.remove('open'));
  },

  onSearchInput(input, field, deviceIndex) {
    const query = input.value.trim();
    const dropdown = document.getElementById(`dd_${field}_${deviceIndex}`);
    if (!dropdown) return;
    if (!App.ddState[deviceIndex]) App.ddState[deviceIndex] = {};
    if (!App.ddState[deviceIndex][field]) App.ddState[deviceIndex][field] = { selected: -1 };
    App.ddState[deviceIndex][field].selected = -1;

    if (!query || query.length < 2) {
      dropdown.classList.remove('open');
      return;
    }

    clearTimeout(Search.assetTimer);
    Search.assetTimer = setTimeout(async () => {
      const results = await Search.searchAssets(query);
      Search.assetResults.set(`asset_${field}_${deviceIndex}`, results);

      if (!results.length) {
        dropdown.innerHTML = '<div class="search-empty">Sonuc bulunamadı</div>';
        dropdown.classList.add('open');
        return;
      }

      dropdown.innerHTML = results.map((item, resultIndex) => `
        <div class="search-item" onmousedown="Search.selectDevice('${field}', ${deviceIndex}, ${resultIndex})">
          <div class="search-item-main">
            ${Search.highlight(item.model || '-', query)}
            <span style="color:var(--accent2)">· ${Search.highlight(item.asset_tag || '-', query)}</span>
            <span class="search-source ${item.source}">${item.source === 'snipeit' ? 'Canlı' : 'Yerel'}</span>
          </div>
          <div class="search-item-sub">SN: ${Search.highlight(item.serial || '-', query)} · ${item.location || '-'}</div>
        </div>
      `).join('');
      dropdown.classList.add('open');

      if ((field === 'etiket' || field === 'seri')) {
        const exact = results.filter((item) => {
          const needle = query.toLowerCase();
          return item.source === 'snipeit' && (
            (field === 'etiket' && item.asset_tag?.toLowerCase() === needle) ||
            (field === 'seri' && item.serial?.toLowerCase() === needle)
          );
        });
        if (exact.length === 1) {
          Search.selectDevice(field, deviceIndex, results.indexOf(exact[0]));
        }
      }
    }, 220);
  },

  onSearchKey(event, field, deviceIndex) {
    const dropdown = document.getElementById(`dd_${field}_${deviceIndex}`);
    if (!dropdown || !dropdown.classList.contains('open')) return;
    const items = dropdown.querySelectorAll('.search-item');
    if (!items.length) return;
    if (!App.ddState[deviceIndex]) App.ddState[deviceIndex] = {};
    if (!App.ddState[deviceIndex][field]) App.ddState[deviceIndex][field] = { selected: -1 };

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      App.ddState[deviceIndex][field].selected = Math.min(App.ddState[deviceIndex][field].selected + 1, items.length - 1);
      items.forEach((item, index) => item.classList.toggle('active', index === App.ddState[deviceIndex][field].selected));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      App.ddState[deviceIndex][field].selected = Math.max(App.ddState[deviceIndex][field].selected - 1, 0);
      items.forEach((item, index) => item.classList.toggle('active', index === App.ddState[deviceIndex][field].selected));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = App.ddState[deviceIndex][field].selected;
      if (selected >= 0 && items[selected]) items[selected].dispatchEvent(new MouseEvent('mousedown'));
    } else if (event.key === 'Escape') {
      dropdown.classList.remove('open');
    }
  },

  closeDropdown(field, deviceIndex, delay) {
    setTimeout(() => {
      const dropdown = document.getElementById(`dd_${field}_${deviceIndex}`);
      if (dropdown) dropdown.classList.remove('open');
    }, delay || 0);
  },

  onAssetMetaSearchInput(input, field, deviceIndex) {
    const query = input.value.trim();
    const dropdown = document.getElementById(`dd_meta_${field}_${deviceIndex}`);
    if (!dropdown) return;

    clearTimeout(Search.metaTimer);
    Search.metaTimer = setTimeout(async () => {
      const results = field === 'status'
        ? await Search.searchStatusLabels(query)
        : await Search.searchLocations(query);
      Search.locationResults.set(`meta_${field}_${deviceIndex}`, results);

      if (!results.length) {
        dropdown.innerHTML = '<div class="search-empty">Sonuc bulunamadı</div>';
        dropdown.classList.add('open');
        return;
      }

      dropdown.innerHTML = results.map((item, index) => `
        <div class="search-item" onmousedown="Search.selectAssetMeta('${field}', ${deviceIndex}, ${index})">
          <div class="search-item-main">${Search.highlight(item.name || '-', query)}</div>
        </div>
      `).join('');
      dropdown.classList.add('open');
    }, 220);
  },

  selectAssetMeta(field, deviceIndex, resultIndex) {
    const results = Search.locationResults.get(`meta_${field}_${deviceIndex}`) || [];
    const item = results[resultIndex];
    if (!item) return;

    if (field === 'status') {
      Devices.updateDevice(deviceIndex, 'proposedNewAssetStatus', item.name || '');
    } else {
      Devices.updateDevice(deviceIndex, 'proposedNewAssetLocation', item.name || '');
    }
    const dropdown = document.getElementById(`dd_meta_${field}_${deviceIndex}`);
    if (dropdown) dropdown.classList.remove('open');
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  async selectDevice(field, deviceIndex, resultIndex) {
    const results = Search.assetResults.get(`asset_${field}_${deviceIndex}`) || [];
    const item = results[resultIndex];
    if (!item) return;

    if (item.source === 'snipeit' && item.id) {
      Devices.setMatchedAsset(deviceIndex, item);
      await Search.hydrateDeviceCurrentState(deviceIndex, { showWarning: true });
    } else {
      App.devices[deviceIndex].model = item.model || '';
      App.devices[deviceIndex].etiket = item.asset_tag || '';
      App.devices[deviceIndex].seri = item.serial || '';
      Devices.clearAssetResolution(deviceIndex);
    }

    ['model', 'etiket', 'seri'].forEach((key) => {
      const dropdown = document.getElementById(`dd_${key}_${deviceIndex}`);
      if (dropdown) dropdown.classList.remove('open');
    });
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
  },

  async validateDevice(deviceIndex, showToast = false) {
    const device = App.devices[deviceIndex];
    if (!device) return;

    try {
      await Search.ensureSnipeStatus(true);
      let asset = null;
      if (device.etiket) {
        try {
          asset = await API.get(`/api/snipeit/assets/bytag/${encodeURIComponent(device.etiket)}`);
        } catch (_) {}
      }
      if (!asset && device.seri) {
        try {
          asset = await API.get(`/api/snipeit/assets/byserial/${encodeURIComponent(device.seri)}`);
        } catch (_) {}
      }

      if (asset) {
        Devices.setMatchedAsset(deviceIndex, asset);
        await Search.hydrateDeviceCurrentState(deviceIndex, { showWarning: showToast });
        Devices.renderDeviceList();
        App.render();
        App.scheduleAutoSave();
        if (showToast) App.showToast('Envanter sunucusu doğrulandı');
        return;
      }
    } catch (_) {}

    Devices.clearAssetResolution(deviceIndex);
    Devices.renderDeviceList();
    App.render();
    App.scheduleAutoSave();
    if (showToast) App.showToast('Envanter sunucusu doğrulanamadı');
  },

  compDdId(listType, rowIndex) {
    const isSerial = listType.startsWith('sn_');
    const actual = isSerial ? listType.slice(3) : listType;
    const parts = actual.split('_');
    const serialPrefix = isSerial ? 'sn' : '';
    if (parts[0] === 'locunit') {
      const prefix = parts[1] === 'comp' ? 'compdd' : 'takilandd';
      return `loc${serialPrefix}${prefix}_${parts[2]}_${parts[3]}_${rowIndex}`;
    }
    if (parts[0] === 'loccomp') {
      const prefix = parts[1] === 'comp' ? 'compdd' : 'takilandd';
      return `loc${serialPrefix}${prefix}_${parts[2]}_${rowIndex}`;
    }
    if (parts[0] === 'unit') {
      const prefix = parts[1] === 'comp' ? 'compdd' : 'takilandd';
      return `${serialPrefix}${prefix}_${parts[2]}_${parts[3]}_${rowIndex}`;
    }

    const prefix = parts[0] === 'comp' ? 'compdd' : 'takilandd';
    return `${serialPrefix}${prefix}_${parts[1]}_${rowIndex}`;
  },

  renderComponentResults(dropdown, results, query, onSelectExpression) {
    if (!results.length) {
      dropdown.innerHTML = '<div class="search-empty">Sonuc bulunamadı</div>';
      dropdown.classList.add('open');
      return;
    }

    dropdown.innerHTML = results.map((item, index) => `
      <div class="search-item" onmousedown="${onSelectExpression(index)}">
        <div class="search-item-main">
          ${Search.highlight(item.name || '', query)}
          <span class="search-source ${item.source}">${item.source === 'snipeit' ? 'Canlı' : 'Yerel'}</span>
        </div>
        <div class="search-item-sub">${item.category || ''}${item.serial ? ` · SN: ${Search.highlight(item.serial, query)}` : ''}</div>
      </div>
    `).join('');
    dropdown.classList.add('open');
  },

  onComponentSearch(input, listType, deviceIndex, componentIndex, field) {
    const query = input.value.trim();
    const key = field === 'serial' ? `sn_${listType}_${deviceIndex}` : `${listType}_${deviceIndex}`;
    const dropdown = document.getElementById(Search.compDdId(key, componentIndex));
    if (!dropdown) return;

    if (!query || query.length < 2) {
      dropdown.classList.remove('open');
      return;
    }

    clearTimeout(Search.componentTimer);
    Search.componentTimer = setTimeout(async () => {
      const results = await Search.searchComponents(query);
      Search.componentResults.set(`${key}_${componentIndex}`, results);
      Search.renderComponentResults(
        dropdown,
        results,
        query,
        (resultIndex) => `Search.selectComponent('${listType}', ${deviceIndex}, ${componentIndex}, ${resultIndex})`
      );

      if (field === 'serial') {
        const exact = results.filter((item) => item.source === 'snipeit' && item.serial?.toLowerCase() === query.toLowerCase());
        if (exact.length === 1) {
          Search.selectComponent(listType, deviceIndex, componentIndex, results.indexOf(exact[0]));
        }
      }
    }, 220);
  },

  onUnitSearch(input, listType, deviceIndex, componentIndex, unitIndex, field) {
    const query = input.value.trim();
    const key = field === 'serial'
      ? `sn_unit_${listType}_${deviceIndex}_${componentIndex}`
      : `unit_${listType}_${deviceIndex}_${componentIndex}`;
    const dropdown = document.getElementById(Search.compDdId(key, unitIndex));
    if (!dropdown) return;

    if (!query || query.length < 2) {
      dropdown.classList.remove('open');
      return;
    }

    clearTimeout(Search.componentTimer);
    Search.componentTimer = setTimeout(async () => {
      const results = await Search.searchComponents(query);
      Search.componentResults.set(`${key}_${unitIndex}`, results);
      Search.renderComponentResults(
        dropdown,
        results,
        query,
        (resultIndex) => `Search.selectUnit('${listType}', ${deviceIndex}, ${componentIndex}, ${unitIndex}, ${resultIndex})`
      );

      if (field === 'serial') {
        const exact = results.filter((item) => item.source === 'snipeit' && item.serial?.toLowerCase() === query.toLowerCase());
        if (exact.length === 1) {
          Search.selectUnit(listType, deviceIndex, componentIndex, unitIndex, results.indexOf(exact[0]));
        }
      }
    }, 220);
  },

  onCompSearchKey(event, listType, rowIndex) {
    const dropdown = document.getElementById(Search.compDdId(listType, rowIndex));
    if (!dropdown || !dropdown.classList.contains('open')) return;
    const items = dropdown.querySelectorAll('.search-item');
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const active = dropdown.querySelector('.search-item.active');
      const index = active ? [...items].indexOf(active) + 1 : 0;
      items.forEach((item) => item.classList.remove('active'));
      if (items[Math.min(index, items.length - 1)]) items[Math.min(index, items.length - 1)].classList.add('active');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const active = dropdown.querySelector('.search-item.active');
      const index = active ? [...items].indexOf(active) - 1 : items.length - 1;
      items.forEach((item) => item.classList.remove('active'));
      if (items[Math.max(index, 0)]) items[Math.max(index, 0)].classList.add('active');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const active = dropdown.querySelector('.search-item.active');
      if (active) active.dispatchEvent(new MouseEvent('mousedown'));
    } else if (event.key === 'Escape') {
      Search.closeAllDropdowns();
    }
  },

  onComponentLocationSearch(input, keyBase, rowIndex, deviceIndex, componentIndex, unitIndex, isUnit) {
    const query = input.value.trim();
    const dropdown = document.getElementById(Search.compDdId(keyBase, rowIndex));
    if (!dropdown) return;

    clearTimeout(Search.metaTimer);
    Search.metaTimer = setTimeout(async () => {
      const results = await Search.searchLocations(query);
      Search.locationResults.set(`${keyBase}_${rowIndex}`, results);
      if (!results.length) {
        dropdown.innerHTML = '<div class="search-empty">Sonuc bulunamadı</div>';
        dropdown.classList.add('open');
        return;
      }

      dropdown.innerHTML = results.map((item, index) => `
        <div class="search-item" onmousedown="Search.selectComponentLocation('${keyBase}', ${rowIndex}, ${index}, ${deviceIndex}, ${componentIndex}, ${unitIndex === null ? -1 : unitIndex}, ${isUnit ? 'true' : 'false'})">
          <div class="search-item-main">${Search.highlight(item.name || '-', query)}</div>
        </div>
      `).join('');
      dropdown.classList.add('open');
    }, 220);
  },

  selectComponentLocation(keyBase, rowIndex, resultIndex, deviceIndex, componentIndex, unitIndex, isUnit) {
    const results = Search.locationResults.get(`${keyBase}_${rowIndex}`) || [];
    const item = results[resultIndex];
    if (!item) return;

    if (isUnit) {
      const listType = keyBase.split('_')[1];
      if (listType === 'comp') Components.updateCompUnit(deviceIndex, componentIndex, unitIndex, 'proposedNewComponentLocation', item.name || '');
      else Components.updateTakilanUnit(deviceIndex, componentIndex, unitIndex, 'proposedNewComponentLocation', item.name || '');
    } else {
      const listType = keyBase.split('_')[1];
      if (listType === 'comp') Components.updateComp(deviceIndex, componentIndex, 'proposedNewComponentLocation', item.name || '');
      else Components.updateTakilan(deviceIndex, componentIndex, 'proposedNewComponentLocation', item.name || '');
    }
    const dropdown = document.getElementById(Search.compDdId(keyBase, rowIndex));
    if (dropdown) dropdown.classList.remove('open');
  },

  closeCompDD(listType, rowIndex, delay) {
    setTimeout(() => {
      const dropdown = document.getElementById(Search.compDdId(listType, rowIndex));
      if (dropdown) dropdown.classList.remove('open');
    }, delay || 0);
  },

  selectComponent(listType, deviceIndex, componentIndex, resultIndex) {
    const resultKey = `${listType}_${deviceIndex}`;
    const serialKey = `sn_${listType}_${deviceIndex}`;
    const results = Search.componentResults.get(`${resultKey}_${componentIndex}`)
      || Search.componentResults.get(`${serialKey}_${componentIndex}`)
      || [];
    const item = results[resultIndex];
    if (!item) return;

    Components.setComponentMatch(deviceIndex, listType, componentIndex, item);
    const list = Components.getList(deviceIndex, listType);
    const component = list?.[componentIndex];
    if (component && item.source !== 'snipeit') {
      component.name = item.name || component.name;
      component.serial = Components.supportsSerial(component.type) ? (item.serial || component.serial) : '';
      Components.clearComponentMatch(component);
    }

    if (listType === 'comp') Components.renderCompListFor(deviceIndex);
    else Components.renderTakilanListFor(deviceIndex);
    App.render();
    App.scheduleAutoSave();
  },

  selectUnit(listType, deviceIndex, componentIndex, unitIndex, resultIndex) {
    const resultKey = `unit_${listType}_${deviceIndex}_${componentIndex}`;
    const serialKey = `sn_unit_${listType}_${deviceIndex}_${componentIndex}`;
    const results = Search.componentResults.get(`${resultKey}_${unitIndex}`)
      || Search.componentResults.get(`${serialKey}_${unitIndex}`)
      || [];
    const item = results[resultIndex];
    if (!item) return;

    Components.setUnitMatch(deviceIndex, listType, componentIndex, unitIndex, item);
    const list = Components.getList(deviceIndex, listType);
    const unit = list?.[componentIndex]?.units?.[unitIndex];
    if (unit && item.source !== 'snipeit') {
      unit.name = item.name || unit.name;
      unit.serial = item.serial || unit.serial;
      Components.clearUnitMatch(unit);
    }

    if (listType === 'comp') Components.renderCompListFor(deviceIndex);
    else Components.renderTakilanListFor(deviceIndex);
    App.render();
    App.scheduleAutoSave();
  }
};

document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.search-wrap')) Search.closeAllDropdowns();
});
