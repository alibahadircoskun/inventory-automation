const MULTI_COMPONENT_TYPES = new Set(['DISK', 'NIC']);
const NON_SERIAL_COMPONENT_TYPES = new Set(['CPU', 'RAM']);

function parseJsonColumn(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function stringifyJson(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return JSON.stringify(value);
}

function componentUsesUnits(component) {
  return MULTI_COMPONENT_TYPES.has(component.type);
}

function componentUsesSerial(type) {
  return !NON_SERIAL_COMPONENT_TYPES.has(String(type || '').trim().toUpperCase());
}

function inferComponentCategory(type, name = '', serial = '') {
  const haystack = `${String(name || '').trim().toLowerCase()} ${String(serial || '').trim().toLowerCase()}`;
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
}

function mapUnitRow(row) {
  return {
    id: row.id,
    name: row.name || '',
    serial: row.serial || '',
    health: row.health ?? '',
    snipeitComponentId: row.snipeit_component_id ?? null,
    snipeitComponentSnapshot: parseJsonColumn(row.snipeit_component_snapshot, null),
    snipeitMatchStatus: row.snipeit_match_status || 'unresolved',
    proposedNewComponentCategory: row.proposed_new_component_category || '',
    proposedNewComponentLocation: row.proposed_new_component_location || ''
  };
}

function mapComponentRow(row, units) {
  const type = row.type || 'CPU';
  return {
    id: row.id,
    type,
    qty: row.qty || 1,
    name: row.name || '',
    serial: componentUsesSerial(type) ? (row.serial || '') : '',
    health: row.health ?? '',
    snipeitComponentId: row.snipeit_component_id ?? null,
    snipeitComponentSnapshot: parseJsonColumn(row.snipeit_component_snapshot, null),
    snipeitMatchStatus: row.snipeit_match_status || 'unresolved',
    proposedNewComponentCategory: row.proposed_new_component_category || '',
    proposedNewComponentLocation: row.proposed_new_component_location || '',
    units
  };
}

function mapDeviceRow(row, installed, removed) {
  return {
    id: row.id,
    model: row.model || '',
    etiket: row.etiket || '',
    seri: row.seri || '',
    not: row.not_text || '',
    componentsOnly: !!row.components_only,
    assetResolutionMode: row.asset_resolution_mode || 'unresolved',
    snipeitAssetId: row.snipeit_asset_id ?? null,
    snipeitAssetSnapshot: parseJsonColumn(row.snipeit_asset_snapshot, null),
    snipeitValidatedAt: row.snipeit_validated_at || null,
    currentStateSnapshot: parseJsonColumn(row.current_state_snapshot, null),
    currentStateFetchedAt: row.current_state_fetched_at || null,
    proposedNewAssetStatus: row.proposed_new_asset_status || '',
    proposedNewAssetLocation: row.proposed_new_asset_location || '',
    takilanComponents: installed,
    components: removed
  };
}

function buildSourceSession(row) {
  if (!row.source_session_id) {
    return null;
  }

  return {
    id: row.source_session_id,
    title: row.source_title || '',
    status: row.source_status || 'draft'
  };
}

function cloneUnitForDraft(unit) {
  return {
    id: null,
    name: unit.name || '',
    serial: unit.serial || '',
    health: unit.health ?? '',
    snipeitComponentId: unit.snipeitComponentId ?? null,
    snipeitComponentSnapshot: unit.snipeitComponentSnapshot || null,
    snipeitMatchStatus: unit.snipeitMatchStatus || 'unresolved',
    proposedNewComponentCategory: unit.proposedNewComponentCategory || '',
    proposedNewComponentLocation: unit.proposedNewComponentLocation || ''
  };
}

function cloneComponentForDraft(component) {
  const type = component.type || 'CPU';
  return {
    id: null,
    type,
    qty: component.qty || 1,
    name: component.name || '',
    serial: componentUsesSerial(type) ? (component.serial || '') : '',
    health: component.health ?? '',
    snipeitComponentId: component.snipeitComponentId ?? null,
    snipeitComponentSnapshot: component.snipeitComponentSnapshot || null,
    snipeitMatchStatus: component.snipeitMatchStatus || 'unresolved',
    proposedNewComponentCategory: component.proposedNewComponentCategory || '',
    proposedNewComponentLocation: component.proposedNewComponentLocation || '',
    units: (component.units || []).map(cloneUnitForDraft)
  };
}

function cloneDeviceForDraft(device) {
  const shouldConvertCreatedAssetToMatched = device.assetResolutionMode === 'create_new' && !!device.snipeitAssetId;

  return {
    id: null,
    model: device.model || '',
    etiket: device.etiket || '',
    seri: device.seri || '',
    not: device.not || '',
    componentsOnly: !!device.componentsOnly,
    assetResolutionMode: shouldConvertCreatedAssetToMatched ? 'matched' : (device.assetResolutionMode || 'unresolved'),
    snipeitAssetId: device.snipeitAssetId ?? null,
    snipeitAssetSnapshot: device.snipeitAssetSnapshot || null,
    snipeitValidatedAt: device.snipeitValidatedAt || null,
    currentStateSnapshot: device.currentStateSnapshot || null,
    currentStateFetchedAt: device.currentStateFetchedAt || null,
    proposedNewAssetStatus: shouldConvertCreatedAssetToMatched ? '' : (device.proposedNewAssetStatus || ''),
    proposedNewAssetLocation: shouldConvertCreatedAssetToMatched ? '' : (device.proposedNewAssetLocation || ''),
    takilanComponents: (device.takilanComponents || []).map(cloneComponentForDraft),
    components: (device.components || []).map(cloneComponentForDraft)
  };
}

function cloneDevicesForDraft(devices) {
  return (devices || []).map(cloneDeviceForDraft);
}

function listSessionEvents(db, sessionId) {
  const rows = db.prepare(`
    SELECT
      session_events.id,
      session_events.event_type,
      session_events.detail,
      session_events.created_at,
      session_events.actor_user_id,
      users.username AS actor_username,
      users.display_name AS actor_display_name
    FROM session_events
    LEFT JOIN users ON users.id = session_events.actor_user_id
    WHERE session_events.session_id = ?
    ORDER BY session_events.created_at ASC, session_events.id ASC
  `).all(sessionId);

  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    detail: parseJsonColumn(row.detail, row.detail || ''),
    createdAt: row.created_at,
    actor: row.actor_user_id ? {
      id: row.actor_user_id,
      username: row.actor_username,
      display_name: row.actor_display_name
    } : null
  }));
}

function loadSessionWithDevices(db, sessionId, { includeEvents = true } = {}) {
  const session = db.prepare(`
    SELECT
      ws.*,
      owner.username AS owner_username,
      owner.display_name AS owner_display_name,
      submitter.username AS submitted_by_username,
      submitter.display_name AS submitted_by_display_name,
      reviewer.username AS reviewed_by_username,
      reviewer.display_name AS reviewed_by_display_name,
      source.id AS source_session_id,
      source.title AS source_title,
      source.status AS source_status
    FROM work_sessions ws
    JOIN users owner ON owner.id = ws.user_id
    LEFT JOIN users submitter ON submitter.id = ws.submitted_by
    LEFT JOIN users reviewer ON reviewer.id = ws.reviewed_by
    LEFT JOIN work_sessions source ON source.id = ws.source_session_id
    WHERE ws.id = ?
  `).get(sessionId);

  if (!session) {
    return null;
  }

  const deviceRows = db.prepare('SELECT * FROM session_devices WHERE session_id = ? ORDER BY position').all(sessionId);
  const componentRows = db.prepare(`
    SELECT *
    FROM session_components
    WHERE device_id IN (SELECT id FROM session_devices WHERE session_id = ?)
    ORDER BY device_id, list_type, position
  `).all(sessionId);
  const unitRows = db.prepare(`
    SELECT *
    FROM session_component_units
    WHERE component_id IN (
      SELECT id FROM session_components WHERE device_id IN (
        SELECT id FROM session_devices WHERE session_id = ?
      )
    )
    ORDER BY component_id, position
  `).all(sessionId);

  const unitsByComponentId = new Map();
  for (const unit of unitRows) {
    if (!unitsByComponentId.has(unit.component_id)) {
      unitsByComponentId.set(unit.component_id, []);
    }
    unitsByComponentId.get(unit.component_id).push(mapUnitRow(unit));
  }

  const componentsByDeviceId = new Map();
  for (const component of componentRows) {
    if (!componentsByDeviceId.has(component.device_id)) {
      componentsByDeviceId.set(component.device_id, { takilan: [], cikarilan: [] });
    }
    const bucket = componentsByDeviceId.get(component.device_id);
    const mapped = mapComponentRow(component, unitsByComponentId.get(component.id) || []);
    if (component.list_type === 'takilan') {
      bucket.takilan.push(mapped);
    } else {
      bucket.cikarilan.push(mapped);
    }
  }

  const devices = deviceRows.map((device) => {
    const components = componentsByDeviceId.get(device.id) || { takilan: [], cikarilan: [] };
    return mapDeviceRow(device, components.takilan, components.cikarilan);
  });

  return {
    id: session.id,
    user_id: session.user_id,
    title: session.title || '',
    description: session.description || '',
    status: session.status || 'draft',
    created_at: session.created_at,
    updated_at: session.updated_at,
    submitted_at: session.submitted_at,
    archived_at: session.archived_at,
    archived_by_user_id: session.archived_by_user_id,
    review_comment: session.review_comment || '',
    reviewed_at: session.reviewed_at,
    snipeit_sync_status: session.snipeit_sync_status,
    snipeit_sync_started_at: session.snipeit_sync_started_at,
    snipeit_sync_finished_at: session.snipeit_sync_finished_at,
    snipeit_sync_summary: parseJsonColumn(session.snipeit_sync_summary, session.snipeit_sync_summary || null),
    owner: {
      id: session.user_id,
      username: session.owner_username,
      display_name: session.owner_display_name
    },
    submittedBy: session.submitted_by ? {
      id: session.submitted_by,
      username: session.submitted_by_username,
      display_name: session.submitted_by_display_name
    } : null,
    reviewedBy: session.reviewed_by ? {
      id: session.reviewed_by,
      username: session.reviewed_by_username,
      display_name: session.reviewed_by_display_name
    } : null,
    sourceSession: buildSourceSession(session),
    devices,
    events: includeEvents ? listSessionEvents(db, session.id) : []
  };
}

function canEditSession(session) {
  return session.status === 'draft';
}

function countChangeItems(session) {
  let count = 0;
  for (const device of session.devices || []) {
    count += (device.takilanComponents || []).length;
    count += (device.components || []).length;
  }
  return count;
}

function validateDraftStructure(session) {
  const issues = [];

  if (!session.devices || session.devices.length === 0) {
    issues.push('En az bir cihaz eklenmelidir.');
  }

  if (countChangeItems(session) === 0) {
    issues.push('Onaya göndermek için en az bir donanım değişikliği eklenmelidir.');
  }

  (session.devices || []).forEach((device, deviceIndex) => {
    const label = device.model || device.etiket || `Cihaz ${deviceIndex + 1}`;

    if (device.componentsOnly) {
      issues.push(`${label}: Sadece bileşen modu onay akışında desteklenmiyor.`);
      return;
    }

    if (!['matched', 'create_new'].includes(device.assetResolutionMode)) {
      issues.push(`${label}: Envanter sunucu eşleştirmesi tamamlanmadı.`);
    }

    if (device.assetResolutionMode === 'matched' && !device.snipeitAssetId) {
      issues.push(`${label}: Eşleşen envanter sunucusu kaydedilmedi.`);
    }

    if (device.assetResolutionMode === 'create_new') {
      if (!device.model) {
        issues.push(`${label}: Yeni sunucu için model gerekli.`);
      }
      if (!device.proposedNewAssetStatus) {
        issues.push(`${label}: Yeni sunucu için durum etiketi seçilmeli.`);
      }
      if (!device.proposedNewAssetLocation) {
        issues.push(`${label}: Yeni sunucu için lokasyon seçilmeli.`);
      }
      if (!device.etiket && !device.seri) {
        issues.push(`${label}: Yeni sunucu için etiket veya seri numarası girilmeli.`);
      }
    }

    const lists = [
      { key: 'takilanComponents', label: 'takılan' },
      { key: 'components', label: 'çıkarılan' }
    ];

    for (const listMeta of lists) {
      for (const component of device[listMeta.key] || []) {
        if (componentUsesUnits(component)) {
          if (!Array.isArray(component.units) || component.units.length !== Number(component.qty || 0)) {
            issues.push(`${label}: ${listMeta.label} ${component.type} satırında adet ve birim sayısı uyuşmuyor.`);
            continue;
          }

          component.units.forEach((unit, unitIndex) => {
            if (unit.snipeitMatchStatus === 'create_new') {
              if (!unit.proposedNewComponentCategory) {
                unit.proposedNewComponentCategory = inferComponentCategory(component.type, unit.name, unit.serial);
              }
              if (!unit.proposedNewComponentLocation) {
                issues.push(`${label}: ${listMeta.label} ${component.type} #${unitIndex + 1} için envanter lokasyonu seçilmeli.`);
              }
              if (!unit.name && !unit.serial) {
                issues.push(`${label}: ${listMeta.label} ${component.type} #${unitIndex + 1} için ad veya seri girilmeli.`);
              }
              return;
            }

            if (!unit.snipeitComponentId || unit.snipeitMatchStatus !== 'matched') {
              issues.push(`${label}: ${listMeta.label} ${component.type} #${unitIndex + 1} envanter ile eşleşmedi.`);
            }
          });
        } else if (component.snipeitMatchStatus === 'create_new') {
          if (!component.proposedNewComponentCategory) {
            component.proposedNewComponentCategory = inferComponentCategory(component.type, component.name, component.serial);
          }
          if (!component.proposedNewComponentLocation) {
            issues.push(`${label}: ${listMeta.label} ${component.type} satırı için envanter lokasyonu seçilmeli.`);
          }
          if (!component.name && !component.serial) {
            issues.push(`${label}: ${listMeta.label} ${component.type} satırı için ad veya seri girilmeli.`);
          }
        } else if (!component.snipeitComponentId || component.snipeitMatchStatus !== 'matched') {
          issues.push(`${label}: ${listMeta.label} ${component.type} satırı envanter ile eşleşmedi.`);
        }
      }
    }
  });

  return issues;
}

function insertSessionEvent(db, sessionId, actorUserId, eventType, detail = null) {
  db.prepare(`
    INSERT INTO session_events (session_id, actor_user_id, event_type, detail)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, actorUserId || null, eventType, detail === null ? null : JSON.stringify(detail));
}

function replaceSessionData(db, sessionId, description, devices) {
  const insertDevice = db.prepare(`
    INSERT INTO session_devices (
      id, session_id, position, model, etiket, seri, not_text, components_only,
      asset_resolution_mode, snipeit_asset_id, snipeit_asset_snapshot,
      snipeit_validated_at, current_state_snapshot, current_state_fetched_at,
      proposed_new_asset_status, proposed_new_asset_location
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertComponent = db.prepare(`
    INSERT INTO session_components (
      id, device_id, list_type, position, type, qty, name, serial, health,
      snipeit_component_id, snipeit_component_snapshot, snipeit_match_status,
      proposed_new_component_category, proposed_new_component_location
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUnit = db.prepare(`
    INSERT INTO session_component_units (
      id, component_id, position, name, serial, health,
      snipeit_component_id, snipeit_component_snapshot, snipeit_match_status,
      proposed_new_component_category, proposed_new_component_location
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    db.prepare("UPDATE work_sessions SET description = ?, updated_at = datetime('now') WHERE id = ?")
      .run(description || '', sessionId);

    const existingDevices = db.prepare('SELECT id FROM session_devices WHERE session_id = ?').all(sessionId);
    for (const device of existingDevices) {
      const existingComponents = db.prepare('SELECT id FROM session_components WHERE device_id = ?').all(device.id);
      for (const component of existingComponents) {
        db.prepare('DELETE FROM session_component_units WHERE component_id = ?').run(component.id);
      }
      db.prepare('DELETE FROM session_components WHERE device_id = ?').run(device.id);
    }
    db.prepare('DELETE FROM session_devices WHERE session_id = ?').run(sessionId);

    (devices || []).forEach((device, deviceIndex) => {
      const deviceResult = insertDevice.run(
        device.id ?? null,
        sessionId,
        deviceIndex,
        device.model || '',
        device.etiket || '',
        device.seri || '',
        device.not || '',
        device.componentsOnly ? 1 : 0,
        device.assetResolutionMode || 'unresolved',
        device.snipeitAssetId ?? null,
        stringifyJson(device.snipeitAssetSnapshot),
        device.snipeitValidatedAt || null,
        stringifyJson(device.currentStateSnapshot),
        device.currentStateFetchedAt || null,
        device.proposedNewAssetStatus || '',
        device.proposedNewAssetLocation || ''
      );

      const deviceId = deviceResult.lastInsertRowid;
      const insertList = (listType, components) => {
        (components || []).forEach((component, componentIndex) => {
          const type = component.type || 'CPU';
          const componentResult = insertComponent.run(
            component.id ?? null,
            deviceId,
            listType,
            componentIndex,
            type,
            component.qty || 1,
            component.name || '',
            componentUsesSerial(type) ? (component.serial || '') : '',
            component.health ?? '',
            component.snipeitComponentId ?? null,
            stringifyJson(component.snipeitComponentSnapshot),
            component.snipeitMatchStatus || 'unresolved',
            component.proposedNewComponentCategory || '',
            component.proposedNewComponentLocation || ''
          );

          (component.units || []).forEach((unit, unitIndex) => {
            insertUnit.run(
              unit.id ?? null,
              componentResult.lastInsertRowid,
              unitIndex,
              unit.name || '',
              unit.serial || '',
              unit.health ?? '',
              unit.snipeitComponentId ?? null,
              stringifyJson(unit.snipeitComponentSnapshot),
              unit.snipeitMatchStatus || 'unresolved',
              unit.proposedNewComponentCategory || '',
              unit.proposedNewComponentLocation || ''
            );
          });
        });
      };

      insertList('takilan', device.takilanComponents);
      insertList('cikarilan', device.components);
    });
  });

  tx();
}

function listSessionsForUser(db, userId) {
  return db.prepare(`
    SELECT
      ws.id,
      ws.title,
      ws.description,
      ws.status,
      ws.created_at,
      ws.updated_at,
      ws.submitted_at,
      ws.reviewed_at,
      ws.review_comment,
      ws.snipeit_sync_status,
      ws.snipeit_sync_summary,
      ws.source_session_id,
      source.title AS source_title,
      source.status AS source_status
    FROM work_sessions ws
    LEFT JOIN work_sessions source ON source.id = ws.source_session_id
    WHERE ws.user_id = ?
      AND ws.archived_at IS NULL
    ORDER BY ws.updated_at DESC
  `).all(userId).map((row) => ({
    ...row,
    sourceSession: buildSourceSession(row),
    snipeit_sync_summary: parseJsonColumn(row.snipeit_sync_summary, row.snipeit_sync_summary || null)
  }));
}

module.exports = {
  canEditSession,
  cloneDevicesForDraft,
  componentUsesUnits,
  insertSessionEvent,
  listSessionsForUser,
  loadSessionWithDevices,
  parseJsonColumn,
  replaceSessionData,
  stringifyJson,
  validateDraftStructure
};
