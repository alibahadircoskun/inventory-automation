const Email = {
  buildHTML(data) {
    const MULTI_TYPES = new Set(['DISK', 'NIC']);
    const HEALTH_TYPES = new Set(['DISK']);
    const devices = Array.isArray(data?.devices) ? data.devices : [];

    const hasValue = (v) => v !== '' && v !== null && v !== undefined;
    const hasAnyHealth = devices.some((d) => {
      const allComps = [
        ...(Array.isArray(d?.takilanComponents) ? d.takilanComponents : []),
        ...(Array.isArray(d?.components) ? d.components : []),
      ];
      return allComps.some((c) => {
        const type = String(c?.type || '').toUpperCase();
        return HEALTH_TYPES.has(type)
          && Array.isArray(c?.units)
          && c.units.some((u) => hasValue(u?.health));
      });
    });

    const totalCols = hasAnyHealth ? 5 : 4;

    const tdBase =
      'padding:6px 8px;border:1px solid #c8cdd2;background-color:#ffffff;color:#1a1a1a;font-size:13px;line-height:1.35;font-family:Arial,Helvetica,sans-serif;vertical-align:middle;';
    const tdText = tdBase + 'white-space:nowrap;word-break:normal;overflow-wrap:normal;';
    const tdSerial = tdBase + 'white-space:nowrap;word-break:normal;overflow-wrap:normal;';
    const tdLabel =
      'padding:6px 8px;border:1px solid #c8cdd2;background-color:#f0f2f5;color:#1a1a1a;font-size:13px;font-weight:600;line-height:1.35;white-space:nowrap;text-align:center;font-family:Arial,Helvetica,sans-serif;vertical-align:middle;';
    const tdCenter = tdBase + 'text-align:center;white-space:nowrap;';
    const thMain =
      'padding:9px 10px;background-color:#2d3748;color:#ffffff;text-align:center;font-size:13px;font-weight:700;line-height:1.3;letter-spacing:1.1px;border:1px solid #c8cdd2;font-family:Arial,Helvetica,sans-serif;mso-line-height-rule:exactly;mso-border-alt:1px solid #c8cdd2;';
    const thSection =
      'padding:9px 10px;background-color:#2d3748;color:#ffffff;text-align:center;font-size:13px;font-weight:700;line-height:1.3;letter-spacing:1.1px;border:1px solid #c8cdd2;font-family:Arial,Helvetica,sans-serif;mso-line-height-rule:exactly;mso-border-alt:1px solid #c8cdd2;';
    const thMainText =
      'display:block;margin:0;text-align:center;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;line-height:1.3;letter-spacing:1.1px;mso-line-height-rule:exactly;';
    const thSectionText =
      'display:block;margin:0;text-align:center;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;line-height:1.3;letter-spacing:1.1px;mso-line-height-rule:exactly;';

    const buildHeaderRow = (label, cellStyle, textStyle) =>
      `<tr><td colspan="${totalCols}" align="center" valign="middle" bgcolor="#2d3748" style="${cellStyle}"><span style="${textStyle}">${label}</span></td></tr>`;

    const colgroup = hasAnyHealth
      ? '<colgroup><col width="120" style="width:120px;"><col width="55" style="width:55px;"><col><col><col width="60" style="width:60px;"></colgroup>'
      : '<colgroup><col width="120" style="width:120px;"><col width="55" style="width:55px;"><col><col></colgroup>';

    const buildUnitCells = (unit, includeHealth) => {
      const name = unit?.name || '\u2014';
      const serial = unit?.serial || '';
      const rawHealth = includeHealth ? unit?.health : null;
      const healthVal = hasValue(rawHealth) ? parseInt(rawHealth, 10) : null;
      const hasSerial = hasValue(serial);
      const hasHealth = Number.isFinite(healthVal);

      if (!hasAnyHealth || !includeHealth) {
        if (!hasSerial) {
          return `<td colspan="${hasAnyHealth ? 3 : 2}" style="${tdText}">${name}</td>`;
        }
        if (hasAnyHealth) {
          return `<td style="${tdText}">${name}</td><td colspan="2" style="${tdSerial}">${serial}</td>`;
        }
        return `<td style="${tdText}">${name}</td><td style="${tdSerial}">${serial}</td>`;
      }

      const healthColor = hasHealth
        ? healthVal >= 90
          ? '#1a7a4a'
          : healthVal >= 70
            ? '#b45309'
            : '#b91c1c'
        : '';

      if (!hasSerial && !hasHealth) {
        return `<td colspan="3" style="${tdText}">${name}</td>`;
      }
      if (!hasHealth) {
        return `<td style="${tdText}">${name}</td><td colspan="2" style="${tdSerial}">${serial}</td>`;
      }
      if (!hasSerial) {
        return `<td colspan="2" style="${tdText}">${name}</td><td style="${tdCenter}color:${healthColor};font-weight:700;">%${healthVal}</td>`;
      }

      return `<td style="${tdText}">${name}</td><td style="${tdSerial}">${serial}</td><td style="${tdCenter}color:${healthColor};font-weight:700;">%${healthVal}</td>`;
    };

    const buildSingleCompCells = (component) => {
      const name = component?.name || '\u2014';
      if (hasAnyHealth) {
        return `<td colspan="3" style="${tdText}">${name}</td>`;
      }
      return `<td colspan="2" style="${tdText}">${name}</td>`;
    };

    const buildCompRows = (list) => {
      if (!Array.isArray(list) || list.length === 0) return '';
      let rows = '';

      list.forEach((c) => {
        const type = c?.type || '\u2014';
        const units = Array.isArray(c?.units) ? c.units : [];
        const qty = c?.qty || (units.length > 0 ? units.length : 1);
        const isMulti = MULTI_TYPES.has(type);
        const includeHealth = HEALTH_TYPES.has(String(type).toUpperCase());

        if (isMulti && units.length > 0) {
          units.forEach((u, idx) => {
            const contentCells = buildUnitCells(u, includeHealth);

            if (idx === 0) {
              rows += `<tr>
                <td rowspan="${units.length}" style="${tdLabel}">${type}</td>
                <td rowspan="${units.length}" style="${tdCenter}font-weight:600;">${qty}x</td>
                ${contentCells}
              </tr>`;
            } else {
              rows += `<tr>${contentCells}</tr>`;
            }
          });
          return;
        }

        rows += `<tr>
          <td style="${tdLabel}">${type}</td>
          <td style="${tdCenter}font-weight:600;">${qty}x</td>
          ${buildSingleCompCells(c)}
        </tr>`;
      });

      return rows;
    };

    const deviceBlocks = devices
      .map((d, di) => {
        const takilan = Array.isArray(d?.takilanComponents) ? d.takilanComponents : [];
        const cikan = Array.isArray(d?.components) ? d.components : [];
        const componentsOnly = !!d?.componentsOnly;

        const header = componentsOnly
          ? buildHeaderRow('DONANIM', thMain, thMainText)
          : devices.length > 1
            ? buildHeaderRow(`CİHAZ ${di + 1}${d?.model ? ' \u2013 ' + d.model : ''}`, thMain, thMainText)
            : buildHeaderRow('CİHAZ BİLGİLERİ', thMain, thMainText);

        const notRow = d?.not
          ? `<tr><td style="${tdLabel}">Not</td><td colspan="${totalCols - 1}" style="${tdText}">${d.not}</td></tr>`
          : '';

        const deviceInfoRows = componentsOnly
          ? ''
          : `<tr><td style="${tdLabel}">Model</td><td colspan="${totalCols - 1}" style="${tdText}">${d?.model || '\u2014'}</td></tr>` +
            `<tr><td style="${tdLabel}">Etiket</td><td colspan="${totalCols - 1}" style="${tdText}">${d?.etiket || '\u2014'}</td></tr>` +
            `<tr><td style="${tdLabel}">Seri No</td><td colspan="${totalCols - 1}" style="${tdSerial}">${d?.seri || '\u2014'}</td></tr>` +
            notRow;

        const takilanRows = takilan.length
          ? componentsOnly
            ? buildCompRows(takilan)
            : `${buildHeaderRow('TAKILAN DONANIM', thSection, thSectionText)}${buildCompRows(takilan)}`
          : '';

        const cikaRows = cikan.length
          ? componentsOnly
            ? buildCompRows(cikan)
            : `${buildHeaderRow('ÇIKARILAN DONANIM', thSection, thSectionText)}${buildCompRows(cikan)}`
          : '';

        return header + deviceInfoRows + takilanRows + cikaRows;
      })
      .join('');

    const descHtml = data?.description
      ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;color:#1a1a1a;margin:0 0 10px 0;white-space:pre-wrap;">${data.description}</p>`
      : '';

    return `<table data-mail-wrapper="1" role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;" bgcolor="#ffffff">
  <tbody>
    <tr>
      <td style="padding:0;">
        ${descHtml}
        <table data-mail-table="1" role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #c8cdd2;table-layout:auto;">
          ${colgroup}
          <tbody>${deviceBlocks}</tbody>
        </table>
      </td>
    </tr>
  </tbody>
</table>`;
  },

  copyHTML() {
    const data = App.getFormData();
    const html = Email.buildHTML(data);
    const plainText = (() => {
      const container = document.createElement('div');
      container.innerHTML = html;
      return container.textContent || container.innerText || '';
    })();

    if (navigator.clipboard && window.ClipboardItem) {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
      });

      navigator.clipboard.write([item]).then(() => {
        App.showToast('HTML kopyalandı. Outlook/Gmail\'e yapıştırabilirsiniz.');
      }).catch(() => {
        Email.copyHTMLFallback(html, plainText);
      });
      return;
    }

    Email.copyHTMLFallback(html, plainText);
  },

  copyHTMLFallback(html, plainText) {
    const tmp = document.createElement('div');
    tmp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none';
    tmp.innerHTML = html;
    document.body.appendChild(tmp);

    try {
      const handleCopy = (event) => {
        event.preventDefault();
        event.clipboardData.setData('text/html', html);
        event.clipboardData.setData('text/plain', plainText);
      };

      document.addEventListener('copy', handleCopy, { once: true });
      const range = document.createRange();
      range.selectNodeContents(tmp);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();

      if (ok) {
        App.showToast('HTML kopyalandı. Outlook/Gmail\'e yapıştırabilirsiniz.');
      } else {
        throw new Error('execCommand failed');
      }
    } catch (e) {
      navigator.clipboard.writeText(html).then(() => {
        App.showToast('HTML kaynak kodu kopyalandı');
      });
    } finally {
      document.body.removeChild(tmp);
    }
  },
};
