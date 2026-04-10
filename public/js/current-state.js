const CurrentState = {
  buildTable(snapshot, title, options = {}) {
    const tdBase = 'padding:6px 8px;border:1px solid #c8cdd2;background-color:#ffffff;color:#1a1a1a;font-size:13px;line-height:1.35;font-family:Arial,Helvetica,sans-serif;vertical-align:middle;';
    const tdLabel = `${tdBase}background-color:#f0f2f5;font-weight:600;text-align:center;white-space:nowrap;`;
    const tdCenter = `${tdBase}text-align:center;white-space:nowrap;`;
    const tdText = `${tdBase}white-space:nowrap;word-break:normal;overflow-wrap:normal;`;
    const th = 'padding:9px 10px;background-color:#2d3748;color:#ffffff;text-align:center;font-size:13px;font-weight:700;line-height:1.3;border:1px solid #c8cdd2;font-family:Arial,Helvetica,sans-serif;';
    const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
    const asset = snapshot?.asset || {};
    const fetchedAt = options.fetchedAt
      ? new Date(options.fetchedAt).toLocaleString('tr-TR')
      : '';

    const groupRows = groups.length
      ? groups.map((group) => {
          const rows = Array.isArray(group.rows) ? group.rows : [];
          return rows.map((row, index) => `
            <tr>
              ${index === 0 ? `<td rowspan="${rows.length}" style="${tdLabel}">${group.label}</td>` : ''}
              <td style="${tdCenter}">${row.qty || 1}x</td>
              <td style="${tdText}">${row.name || '—'}</td>
              <td style="${tdText}">${row.serial || row.location || row.note || '—'}</td>
            </tr>
          `).join('');
        }).join('')
      : `<tr><td colspan="4" style="${tdText}">Bu sunucu için atanmış bileşen bulunamadı.</td></tr>`;

    return `
      <div class="current-state-card">
        <div class="current-state-card-head">
          <div>
            <div class="current-state-card-title">${title}</div>
            <div class="current-state-card-meta">${asset.asset_tag || '-'} · ${asset.serial || '-'}${fetchedAt ? ` · ${fetchedAt}` : ''}</div>
          </div>
          ${options.refreshButton || ''}
        </div>
        <div class="current-state-table-wrap">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
            <colgroup><col width="120"><col width="55"><col><col></colgroup>
            <tbody>
              <tr><td colspan="4" align="center" valign="middle" bgcolor="#2d3748" style="${th}">CİHAZ BİLGİLERİ</td></tr>
              <tr><td style="${tdLabel}">Model</td><td colspan="3" style="${tdText}">${asset.model || '—'}</td></tr>
              <tr><td style="${tdLabel}">Etiket</td><td colspan="3" style="${tdText}">${asset.asset_tag || '—'}</td></tr>
              <tr><td style="${tdLabel}">Seri No</td><td colspan="3" style="${tdText}">${asset.serial || '—'}</td></tr>
              <tr><td style="${tdLabel}">Durum</td><td colspan="3" style="${tdText}">${asset.status_label || '—'}${asset.location ? ` · ${asset.location}` : ''}</td></tr>
              <tr><td colspan="4" align="center" valign="middle" bgcolor="#2d3748" style="${th}">MEVCUT TAKILI DONANIM</td></tr>
              ${groupRows}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  buildEmptyState(device, index) {
    const label = device.model || device.etiket || `Cihaz ${index + 1}`;
    const message = device.assetResolutionMode === 'create_new'
      ? 'Yeni sunucu olarak işaretlenen cihazlarda mevcut durum gösterilmez.'
      : device.assetResolutionMode === 'matched'
        ? 'Bu eşleşmiş sunucu için mevcut durum henüz alınamadı.'
        : 'Mevcut durumu görmek için sunucuyu canlı envanterle eşleştirin.';
    return `
      <div class="current-state-empty">
        <div class="current-state-card-title">${label}</div>
        <div class="current-state-card-meta">${message}</div>
      </div>
    `;
  },

  buildPreviewHTML(devices, options = {}) {
    const list = Array.isArray(devices) ? devices : [];
    if (!list.length) {
      return '<div class="current-state-empty"><div class="current-state-card-title">Henüz cihaz yok</div><div class="current-state-card-meta">Bir cihaz eklendiğinde mevcut durum burada görünecek.</div></div>';
    }

    return list.map((device, index) => {
      if (device.assetResolutionMode !== 'matched' || !device.currentStateSnapshot) {
        return CurrentState.buildEmptyState(device, index);
      }

      const refreshButton = options.allowRefresh && device.id
        ? `<button class="btn btn-ghost btn-sm" type="button" onclick="Approval.refreshDeviceCurrentState(${device.id})">Yenile</button>`
        : '';

      return CurrentState.buildTable(
        device.currentStateSnapshot,
        device.model || device.etiket || `Cihaz ${index + 1}`,
        {
          fetchedAt: device.currentStateFetchedAt,
          refreshButton
        }
      );
    }).join('');
  }
};
