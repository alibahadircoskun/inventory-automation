const { getDb } = require('../db');
const { fetchCurrentDeviceStateSnapshot } = require('./current-device-state');
const { createNotification } = require('./notifications');
const { getSnipeItClient, SnipeItError } = require('./snipeit-client');
const {
  componentUsesUnits,
  insertSessionEvent,
  loadSessionWithDevices,
  parseJsonColumn,
  replaceSessionData,
  stringifyJson,
  validateDraftStructure
} = require('./work-sessions');

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function componentUsesSerial(type) {
  return !['cpu', 'ram'].includes(String(type || '').trim().toLowerCase());
}

function nowIso() {
  return new Date().toISOString();
}

function exactNameMatch(rows, name, field = 'name') {
  const normalized = normalizeText(name);
  return rows.filter((row) => normalizeText(row[field]) === normalized);
}

function componentMatchesType(component, type) {
  const category = normalizeText(component.category);
  if (!category) {
    return true;
  }

  if (type === 'DISK') {
    return ['disk', 'ssd', 'sas', 'sata', 'nvme'].some((needle) => category.includes(needle));
  }
  if (type === 'NIC') {
    return ['nic', 'ethernet', 'fiber', 'network', 'sfp', 'adapter'].some((needle) => category.includes(needle));
  }
  if (type === 'RAM') {
    return ['ram', 'memory', 'dimm'].some((needle) => category.includes(needle));
  }
  if (type === 'CPU') {
    return ['cpu', 'processor', 'xeon'].some((needle) => category.includes(needle));
  }

  return true;
}

function extractPayloadId(response) {
  if (response && typeof response === 'object') {
    if (response.payload && typeof response.payload === 'object' && response.payload.id != null) {
      return Number(response.payload.id);
    }
    if (response.id != null) {
      return Number(response.id);
    }
  }

  return null;
}

function buildOperationResult({ key, operation, target, success, skipped = false, message, responseStatus = 200, responseBody = null }) {
  return {
    key,
    operation,
    target,
    success,
    skipped,
    message,
    responseStatus,
    responseBody
  };
}

function insertSyncAudit(db, sessionId, entry) {
  db.prepare(`
    INSERT INTO sync_audit_log (
      session_id,
      operation,
      snipeit_endpoint,
      request_payload,
      response_status,
      response_body,
      success,
      idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    entry.operation,
    entry.endpoint,
    entry.requestPayload ? JSON.stringify(entry.requestPayload) : null,
    entry.responseStatus ?? null,
    entry.responseBody ? JSON.stringify(entry.responseBody) : null,
    entry.success ? 1 : 0,
    entry.idempotencyKey || null
  );
}

function hasSuccessfulAudit(db, sessionId, idempotencyKey) {
  if (!idempotencyKey) {
    return false;
  }

  const row = db.prepare(`
    SELECT id
    FROM sync_audit_log
    WHERE session_id = ? AND idempotency_key = ? AND success = 1
    LIMIT 1
  `).get(sessionId, idempotencyKey);

  return !!row;
}

function listSuccessfulAuditsByKey(db, sessionId) {
  const rows = db.prepare(`
    SELECT
      idempotency_key,
      operation,
      request_payload,
      response_body
    FROM sync_audit_log
    WHERE session_id = ?
      AND success = 1
      AND idempotency_key IS NOT NULL
    ORDER BY id ASC
  `).all(sessionId);

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.idempotency_key)) {
      map.set(row.idempotency_key, {
        key: row.idempotency_key,
        operation: row.operation,
        requestPayload: parseJsonColumn(row.request_payload, null),
        responseBody: parseJsonColumn(row.response_body, null)
      });
    }
  }

  return map;
}

function countOperationResults(operations = []) {
  const failures = operations.filter((operation) => !operation.success).length;
  const successes = operations.filter((operation) => operation.success && !operation.skipped).length;
  const skipped = operations.filter((operation) => operation.skipped).length;

  return {
    success: successes,
    failed: failures,
    skipped
  };
}

function buildSummaryFromOperations(operations = [], { dryRun = false, issues = [] } = {}) {
  const counts = countOperationResults(operations);
  const status = issues.length && counts.success === 0 && counts.failed === 0
    ? 'failed'
    : counts.failed === 0
      ? 'success'
      : counts.success > 0
        ? 'partial'
        : 'failed';
  return {
    status,
    issues,
    operations,
    counts,
    dryRun
  };
}

function rollbackKeyFor(idempotencyKey) {
  return `rollback:${idempotencyKey}`;
}

function shouldRollbackAudit(auditEntry, { allowAlreadyAssigned = true } = {}) {
  if (!auditEntry) {
    return false;
  }

  if (auditEntry.responseBody?.dry_run) {
    return false;
  }

  if (!allowAlreadyAssigned && auditEntry.responseBody?.already_assigned) {
    return false;
  }

  return true;
}

function buildComponentTargetName(device, component, unit = null) {
  return `${device.model || device.etiket || 'Cihaz'} / ${component.type} / ${unit?.serial || unit?.name || component.serial || component.name || component.id}`;
}

function resolveComponentCategoryName(type, item) {
  const haystack = `${normalizeText(item?.name)} ${normalizeText(item?.serial)}`;
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

function componentKeySuffix(component) {
  return component.id || `${component.type}:${component.serial || component.name || 'component'}`;
}

function unitKeySuffix(component, unit) {
  return unit.id || `${component.id || 'x'}:${unit.serial || unit.name || 'unit'}`;
}

function resolveDeviceAssetId(device, createAudit = null) {
  return Number(
    device.snipeitAssetId
      ?? extractPayloadId(createAudit?.responseBody)
      ?? 0
  ) || null;
}

async function findUniqueModel(client, name) {
  const matches = exactNameMatch(await client.searchModels(name, 20), name);
  return matches.length === 1 ? matches[0] : null;
}

async function findUniqueLocation(client, name) {
  const matches = exactNameMatch(await client.searchLocations(name, 20), name);
  return matches.length === 1 ? matches[0] : null;
}

async function findUniqueStatus(client, name) {
  const matches = exactNameMatch(await client.searchStatusLabels(name, 20), name);
  return matches.length === 1 ? matches[0] : null;
}

async function findUniqueCategory(client, name) {
  const matches = exactNameMatch(
    await client.searchCategories(name, { limit: 30, categoryType: 'Component' }),
    name
  ).filter((row) => normalizeText(row.category_type) === 'component');
  return matches.length === 1 ? matches[0] : null;
}

async function resolveExactAsset(client, device) {
  let asset = null;

  if (device.snipeitAssetId) {
    try {
      asset = await client.getAssetById(device.snipeitAssetId);
    } catch (_) {}
  }

  if (!asset && device.etiket) {
    try {
      asset = await client.getAssetByTag(device.etiket);
    } catch (_) {}
  }

  if (!asset && device.seri) {
    try {
      asset = await client.getAssetBySerial(device.seri);
    } catch (_) {}
  }

  return asset;
}

async function resolveExactComponent(client, componentLike, type) {
  if (componentLike.snipeitComponentId) {
    try {
      return await client.getComponentById(componentLike.snipeitComponentId);
    } catch (_) {}
  }

  if (componentUsesSerial(type) && componentLike.serial) {
    const serialMatches = (await client.searchComponents(componentLike.serial, 20))
      .filter((row) => normalizeText(row.serial) === normalizeText(componentLike.serial));
    if (serialMatches.length === 1) {
      return serialMatches[0];
    }
  }

  if (!componentLike.name) {
    return null;
  }

  const nameMatches = (await client.searchComponents(componentLike.name, 20))
    .filter((row) => normalizeText(row.name) === normalizeText(componentLike.name))
    .filter((row) => componentMatchesType(row, type));
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

async function findDuplicateComponent(client, componentLike, type) {
  if (componentUsesSerial(type) && componentLike.serial) {
    const serialMatches = (await client.searchComponents(componentLike.serial, 20))
      .filter((row) => normalizeText(row.serial) === normalizeText(componentLike.serial))
      .filter((row) => componentMatchesType(row, type));
    if (serialMatches.length === 1) {
      return serialMatches[0];
    }
  }

  if (!componentLike.name) {
    return null;
  }

  const nameMatches = (await client.searchComponents(componentLike.name, 20))
    .filter((row) => normalizeText(row.name) === normalizeText(componentLike.name))
    .filter((row) => componentMatchesType(row, type));
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

async function validateCreateNewComponent(client, device, component, sourceLike, type, issues, labelSuffix) {
  sourceLike.proposedNewComponentCategory = sourceLike.proposedNewComponentCategory
    || resolveComponentCategoryName(type, sourceLike);

  let existingCreated = null;
  if (sourceLike.snipeitComponentId) {
    try {
      existingCreated = await client.getComponentById(sourceLike.snipeitComponentId);
    } catch (_) {}
  }

  const [category, location, duplicate] = await Promise.all([
    sourceLike.proposedNewComponentCategory
      ? findUniqueCategory(client, sourceLike.proposedNewComponentCategory)
      : Promise.resolve(null),
    sourceLike.proposedNewComponentLocation
      ? findUniqueLocation(client, sourceLike.proposedNewComponentLocation)
      : Promise.resolve(null),
    existingCreated ? Promise.resolve(null) : findDuplicateComponent(client, sourceLike, type)
  ]);

  if (!category) {
    issues.push(`${device.model || device.etiket || 'Cihaz'}: ${type} ${labelSuffix} için bileşen kategorisi envanterde bulunamadı veya benzersiz değil.`);
  }
  if (!location) {
    issues.push(`${device.model || device.etiket || 'Cihaz'}: ${type} ${labelSuffix} için lokasyon envanterde bulunamadı veya benzersiz değil.`);
  }
  if (!sourceLike.name && !sourceLike.serial) {
    issues.push(`${device.model || device.etiket || 'Cihaz'}: ${type} ${labelSuffix} için ad veya seri girilmeli.`);
  }
  if (duplicate) {
    issues.push(`${device.model || device.etiket || 'Cihaz'}: ${type} ${labelSuffix} envanterde zaten var. Eşleştirme yapın.`);
  }
}

async function revalidateSessionAgainstSnipe(session, { allowNewAssets = true } = {}) {
  const client = getSnipeItClient();
  if (!client.isConfigured()) {
    return {
      ok: false,
      issues: ['Envanter bağlantısı ayarlanmadığı için canlı doğrulama yapılamadı.'],
      session
    };
  }

  const issues = [...validateDraftStructure(session)];

  for (const device of session.devices || []) {
    if (device.assetResolutionMode === 'matched') {
      const asset = await resolveExactAsset(client, device);
      if (!asset) {
        issues.push(`${device.model || device.etiket || 'Cihaz'}: envanter sunucusu yeniden doğrulanamadı.`);
      } else {
        device.assetResolutionMode = 'matched';
        device.snipeitAssetId = asset.id;
        device.snipeitAssetSnapshot = asset;
        device.snipeitValidatedAt = nowIso();
        try {
          device.currentStateSnapshot = await fetchCurrentDeviceStateSnapshot(asset, client);
          device.currentStateFetchedAt = nowIso();
        } catch (_) {
          device.currentStateSnapshot = device.currentStateSnapshot || null;
          device.currentStateFetchedAt = device.currentStateFetchedAt || null;
        }

        if (device.etiket && normalizeText(device.etiket) !== normalizeText(asset.asset_tag)) {
          issues.push(`${device.model || device.etiket}: Etiket numarası envanter kaydı ile eşleşmiyor.`);
        }
        if (device.seri && normalizeText(device.seri) !== normalizeText(asset.serial)) {
          issues.push(`${device.model || device.etiket}: Seri numarası envanter kaydı ile eşleşmiyor.`);
        }
      }
    }

    if (device.assetResolutionMode === 'create_new') {
      device.currentStateSnapshot = null;
      device.currentStateFetchedAt = null;
      if (!allowNewAssets) {
        issues.push(`${device.model || device.etiket || 'Cihaz'}: Yeni sunucu oluşturma bu adımda desteklenmiyor.`);
      } else {
        const existingByTag = device.etiket ? await resolveExactAsset(client, { etiket: device.etiket }) : null;
        const existingBySerial = !existingByTag && device.seri ? await resolveExactAsset(client, { seri: device.seri }) : null;
        if (existingByTag || existingBySerial) {
          issues.push(`${device.model || device.etiket || 'Cihaz'}: Yeni sunucu seçildi ancak aynı etiket/seri envanterde zaten var.`);
        }

        const [model, status, location] = await Promise.all([
          device.model ? findUniqueModel(client, device.model) : Promise.resolve(null),
          device.proposedNewAssetStatus ? findUniqueStatus(client, device.proposedNewAssetStatus) : Promise.resolve(null),
          device.proposedNewAssetLocation ? findUniqueLocation(client, device.proposedNewAssetLocation) : Promise.resolve(null)
        ]);

        if (!model) issues.push(`${device.model || device.etiket || 'Cihaz'}: Model envanterde bulunamadı veya benzersiz değil.`);
        if (!status) issues.push(`${device.model || device.etiket || 'Cihaz'}: Durum etiketi envanterde bulunamadı veya benzersiz değil.`);
        if (!location) issues.push(`${device.model || device.etiket || 'Cihaz'}: Lokasyon envanterde bulunamadı veya benzersiz değil.`);
      }
    }

    const lists = [device.takilanComponents || [], device.components || []];
    for (const list of lists) {
      for (const component of list) {
        if (componentUsesUnits(component)) {
          for (const unit of component.units || []) {
            if (unit.snipeitMatchStatus === 'create_new') {
              await validateCreateNewComponent(client, device, component, unit, component.type, issues, 'birimi');
              continue;
            }

            const match = await resolveExactComponent(client, unit, component.type);
            if (!match) {
              issues.push(`${device.model || device.etiket || 'Cihaz'}: ${component.type} birimi envanter ile yeniden eşleşmedi.`);
              unit.snipeitMatchStatus = 'unresolved';
              unit.snipeitComponentId = null;
              unit.snipeitComponentSnapshot = null;
            } else {
              unit.snipeitMatchStatus = 'matched';
              unit.snipeitComponentId = match.id;
              unit.snipeitComponentSnapshot = match;
            }
          }
        } else {
          if (component.snipeitMatchStatus === 'create_new') {
            await validateCreateNewComponent(client, device, component, component, component.type, issues, 'satırı');
            continue;
          }

          const match = await resolveExactComponent(client, component, component.type);
          if (!match) {
            issues.push(`${device.model || device.etiket || 'Cihaz'}: ${component.type} satırı envanter ile yeniden eşleşmedi.`);
            component.snipeitMatchStatus = 'unresolved';
            component.snipeitComponentId = null;
            component.snipeitComponentSnapshot = null;
          } else {
            component.snipeitMatchStatus = 'matched';
            component.snipeitComponentId = match.id;
            component.snipeitComponentSnapshot = match;
          }
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    session
  };
}

function applyManagerOverrides(session, overrides = []) {
  const deviceOverrides = Array.isArray(overrides)
    ? overrides
    : Array.isArray(overrides?.devices)
      ? overrides.devices
      : [];
  const componentOverrides = Array.isArray(overrides?.components) ? overrides.components : [];

  if (deviceOverrides.length === 0 && componentOverrides.length === 0) {
    return;
  }

  const overridesById = new Map(deviceOverrides.map((item) => [Number(item.deviceId), item]));
  for (const device of session.devices || []) {
    const override = overridesById.get(Number(device.id));
    if (!override) {
      // pass
    } else {
      if (typeof override.model === 'string') {
        device.model = override.model.trim();
      }
      if (typeof override.proposedNewAssetStatus === 'string') {
        device.proposedNewAssetStatus = override.proposedNewAssetStatus.trim();
      }
      if (typeof override.proposedNewAssetLocation === 'string') {
        device.proposedNewAssetLocation = override.proposedNewAssetLocation.trim();
      }
    }

    const overridesForDevice = componentOverrides.filter((item) => Number(item.deviceId) === Number(device.id));
    if (!overridesForDevice.length) {
      continue;
    }

    for (const item of overridesForDevice) {
      if (item.targetType === 'unit') {
        for (const component of [...(device.takilanComponents || []), ...(device.components || [])]) {
          const unit = (component.units || []).find((entry) => Number(entry.id) === Number(item.unitId));
          if (!unit) continue;
          if (typeof item.proposedNewComponentLocation === 'string') {
            unit.proposedNewComponentLocation = item.proposedNewComponentLocation.trim();
          }
        }
      } else {
        for (const component of [...(device.takilanComponents || []), ...(device.components || [])]) {
          if (Number(component.id) !== Number(item.componentId)) continue;
          if (typeof item.proposedNewComponentLocation === 'string') {
            component.proposedNewComponentLocation = item.proposedNewComponentLocation.trim();
          }
        }
      }
    }
  }
}

async function performLoggedOperation(db, sessionId, {
  idempotencyKey,
  operation,
  endpoint,
  requestPayload,
  target,
  runner
}) {
  if (hasSuccessfulAudit(db, sessionId, idempotencyKey)) {
    return buildOperationResult({
      key: idempotencyKey,
      operation,
      target,
      success: true,
      skipped: true,
      message: 'Daha önce başarıyla tamamlandığı için atlandı.'
    });
  }

  try {
    const responseBody = await runner();
    insertSyncAudit(db, sessionId, {
      operation,
      endpoint,
      requestPayload,
      responseStatus: 200,
      responseBody,
      success: true,
      idempotencyKey
    });
    return buildOperationResult({
      key: idempotencyKey,
      operation,
      target,
      success: true,
      message: 'Başarılı',
      responseBody
    });
  } catch (error) {
    insertSyncAudit(db, sessionId, {
      operation,
      endpoint,
      requestPayload,
      responseStatus: error.statusCode || 500,
      responseBody: error.data || { error: error.message },
      success: false,
      idempotencyKey
    });
    return buildOperationResult({
      key: idempotencyKey,
      operation,
      target,
      success: false,
      message: error.message,
      responseStatus: error.statusCode || 500,
      responseBody: error.data || { error: error.message }
    });
  }
}

async function ensureAssetForDevice(db, client, sessionId, device) {
  if (device.assetResolutionMode === 'matched') {
    const asset = await client.getAssetById(device.snipeitAssetId);
    device.snipeitAssetSnapshot = asset;
    return { assetId: asset.id, operation: null };
  }

  const model = await findUniqueModel(client, device.model);
  const status = await findUniqueStatus(client, device.proposedNewAssetStatus);
  const location = await findUniqueLocation(client, device.proposedNewAssetLocation);

  if (!model || !status || !location) {
    throw new Error('Yeni sunucu için model/durum/lokasyon bilgileri yeniden doğrulanamadı.');
  }

  const requestPayload = {
    asset_tag: device.etiket || undefined,
    serial: device.seri || undefined,
    name: device.etiket || undefined,
    model_id: model.id,
    status_id: status.id,
    location_id: location.id
  };

  const key = `device:${device.id}:create-asset`;
  const operation = await performLoggedOperation(db, sessionId, {
    idempotencyKey: key,
    operation: 'create_asset',
    endpoint: 'hardware',
    requestPayload,
    target: device.model || device.etiket || `device:${device.id}`,
    runner: async () => {
      if (client.dryRun) {
        return {
          dry_run: true,
          created_asset_id: null,
          payload: requestPayload
        };
      }

      const response = await client.createAsset(requestPayload);
      return response;
    }
  });

  if (!operation.success) {
    throw new Error(operation.message);
  }

  if (!client.dryRun) {
    const createdId = extractPayloadId(operation.responseBody);
    if (!createdId) {
      throw new Error('Yeni envanter sunucusu oluşturuldu ancak ID döndürülmedi.');
    }
    device.snipeitAssetId = createdId;
    device.snipeitAssetSnapshot = await client.getAssetById(createdId);
    return { assetId: createdId, operation };
  }

  return { assetId: null, operation };
}

async function ensureComponentForSync(db, client, sessionId, device, component, sourceLike, qty, idempotencyKey) {
  if (sourceLike.snipeitMatchStatus === 'matched' && sourceLike.snipeitComponentId) {
    return { componentId: sourceLike.snipeitComponentId, operation: null };
  }
  if (sourceLike.snipeitMatchStatus !== 'create_new') {
    throw new Error('Bilesen envanter ile eslesmedi.');
  }
  if (sourceLike.snipeitComponentId) {
    try {
      const existing = await client.getComponentById(sourceLike.snipeitComponentId);
      if (existing?.id) {
        sourceLike.snipeitComponentSnapshot = existing;
        return { componentId: existing.id, operation: null };
      }
    } catch (_) {}
  }

  const categoryName = sourceLike.proposedNewComponentCategory || resolveComponentCategoryName(component.type, sourceLike);
  sourceLike.proposedNewComponentCategory = categoryName;

  const [category, location, duplicate] = await Promise.all([
    findUniqueCategory(client, categoryName),
    findUniqueLocation(client, sourceLike.proposedNewComponentLocation),
    findDuplicateComponent(client, sourceLike, component.type)
  ]);

  if (!category || !location) {
    throw new Error('Yeni bilesen icin kategori/lokasyon bilgileri yeniden dogrulanamadi.');
  }
  if (duplicate) {
    throw new Error('Yeni bilesen envanterde zaten var. Eslestirme yapin.');
  }

  const requestPayload = {
    name: sourceLike.name || sourceLike.serial || `${component.type} ${device.model || device.etiket || ''}`.trim(),
    qty: Number(qty || 1),
    category_id: category.id,
    location_id: location.id,
    serial: componentUsesSerial(component.type) ? (sourceLike.serial || undefined) : undefined
  };

  const operation = await performLoggedOperation(db, sessionId, {
    idempotencyKey,
    operation: 'create_component',
    endpoint: 'components',
    requestPayload,
    target: buildComponentTargetName(device, component, sourceLike === component ? null : sourceLike),
    runner: async () => {
      if (client.dryRun) {
        return { dry_run: true, payload: requestPayload };
      }
      return client.createComponent(requestPayload);
    }
  });

  if (!operation.success) {
    throw new Error(operation.message);
  }

  if (client.dryRun) {
    return { componentId: null, operation };
  }

  const createdId = extractPayloadId(operation.responseBody);
  if (!createdId) {
    throw new Error('Yeni bilesen olusturuldu ancak ID donmedi.');
  }

  sourceLike.snipeitComponentId = createdId;
  sourceLike.snipeitComponentSnapshot = {
    id: createdId,
    name: requestPayload.name,
    serial: requestPayload.serial || '',
    category: category.name,
    location: location.name
  };
  return { componentId: createdId, operation };
}

async function syncInstall(db, client, sessionId, assetId, targetName, componentId, qty, idempotencyKey) {
  const requestPayload = { assigned_to: assetId, assigned_qty: qty };
  return performLoggedOperation(db, sessionId, {
    idempotencyKey,
    operation: 'component_checkout',
    endpoint: `components/${componentId}/checkout`,
    requestPayload,
    target: targetName,
    runner: async () => {
      const assignments = await client.getComponentAssetAssignments(componentId);
      const existing = assignments.find((row) => Number(row.name?.id) === Number(assetId));
      if (existing && Number(existing.assigned_qty || 0) >= qty) {
        return { already_assigned: true, assignment: existing };
      }

      if (client.dryRun) {
        return { dry_run: true, payload: requestPayload };
      }

      return client.checkoutComponent(componentId, assetId, qty);
    }
  });
}

async function syncRemoval(db, client, sessionId, assetId, targetName, componentId, qty, idempotencyKey) {
  if (hasSuccessfulAudit(db, sessionId, idempotencyKey)) {
    return buildOperationResult({
      key: idempotencyKey,
      operation: 'component_checkin',
      target: targetName,
      success: true,
      skipped: true,
      message: 'Daha önce başarıyla tamamlandığı için atlandı.'
    });
  }

  const assignments = await client.getComponentAssetAssignments(componentId);
  const existing = assignments.find((row) => Number(row.name?.id) === Number(assetId));
  if (!existing) {
    return buildOperationResult({
      key: idempotencyKey,
      operation: 'component_checkin',
      target: targetName,
      success: false,
      message: 'Bileşen bu varlığa atanmış görünmüyor.'
    });
  }

  const requestPayload = { checkin_qty: qty };
  return performLoggedOperation(db, sessionId, {
    idempotencyKey,
    operation: 'component_checkin',
    endpoint: `components/${existing.assigned_pivot_id}/checkin`,
    requestPayload,
    target: targetName,
    runner: async () => {
      if (client.dryRun) {
        return { dry_run: true, payload: requestPayload, assignment: existing };
      }

      return client.checkinComponent(existing.assigned_pivot_id, qty);
    }
  });
}

async function syncComponentList(db, client, sessionId, assetId, device, list, direction) {
  const operations = [];
  const prefix = direction === 'install' ? 'install' : 'remove';

  for (const component of list || []) {
    if (componentUsesUnits(component)) {
      for (const unit of component.units || []) {
        const unitKey = unitKeySuffix(component, unit);
        const target = `${device.model || device.etiket || 'Cihaz'} / ${component.type} / ${unit.serial || unit.name || unit.id}`;

        let componentId = unit.snipeitComponentId;
        if (unit.snipeitMatchStatus === 'create_new') {
          const createResult = await ensureComponentForSync(
            db,
            client,
            sessionId,
            device,
            component,
            unit,
            1,
            `create:unit:${unitKey}`
          );
          if (createResult.operation) operations.push(createResult.operation);
          componentId = createResult.componentId;

          if (direction === 'remove') {
            continue;
          }
          if (!componentId && client.dryRun) {
            operations.push(buildOperationResult({
              key: `${prefix}:unit:${unitKey}`,
              operation: 'component_checkout',
              target,
              success: true,
              skipped: true,
              message: 'Dry-run modunda yeni bileşen ID üretilmediği için atlandı.'
            }));
            continue;
          }
        } else if (unit.snipeitMatchStatus !== 'matched' || !componentId) {
          operations.push(buildOperationResult({
            key: `${prefix}:unit:${unitKey}`,
            operation: direction === 'install' ? 'component_checkout' : 'component_checkin',
            target,
            success: false,
            message: 'Bileşen envanter ile eşleşmedi.'
          }));
          continue;
        }

        if (direction === 'install') {
          operations.push(await syncInstall(db, client, sessionId, assetId, target, componentId, 1, `${prefix}:unit:${unitKey}`));
        } else {
          operations.push(await syncRemoval(db, client, sessionId, assetId, target, componentId, 1, `${prefix}:unit:${unitKey}`));
        }
      }
    } else {
      const componentKey = componentKeySuffix(component);
      const target = `${device.model || device.etiket || 'Cihaz'} / ${component.type} / ${component.serial || component.name || component.id}`;
      const qty = Number(component.qty || 1);

      let componentId = component.snipeitComponentId;
      if (component.snipeitMatchStatus === 'create_new') {
        const createResult = await ensureComponentForSync(
          db,
          client,
          sessionId,
          device,
          component,
          component,
          qty,
          `create:component:${componentKey}`
        );
        if (createResult.operation) operations.push(createResult.operation);
        componentId = createResult.componentId;

        if (direction === 'remove') {
          continue;
        }
        if (!componentId && client.dryRun) {
          operations.push(buildOperationResult({
            key: `${prefix}:component:${componentKey}`,
            operation: 'component_checkout',
            target,
            success: true,
            skipped: true,
            message: 'Dry-run modunda yeni bileşen ID üretilmediği için atlandı.'
          }));
          continue;
        }
      } else if (component.snipeitMatchStatus !== 'matched' || !componentId) {
        operations.push(buildOperationResult({
          key: `${prefix}:component:${componentKey}`,
          operation: direction === 'install' ? 'component_checkout' : 'component_checkin',
          target,
          success: false,
          message: 'Bileşen envanter ile eşleşmedi.'
        }));
        continue;
      }

      if (direction === 'install') {
        operations.push(await syncInstall(db, client, sessionId, assetId, target, componentId, qty, `${prefix}:component:${componentKey}`));
      } else {
        operations.push(await syncRemoval(db, client, sessionId, assetId, target, componentId, qty, `${prefix}:component:${componentKey}`));
      }
    }
  }

  return operations;
}

async function rollbackInstalledComponent(db, client, sessionId, assetId, item, rollbackKey) {
  if (hasSuccessfulAudit(db, sessionId, rollbackKey)) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'component_checkin',
      target: item.target,
      success: true,
      skipped: true,
      message: 'Daha önce başarıyla geri alındığı için atlandı.'
    });
  }

  if (!assetId || !item.componentId) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'component_checkin',
      target: item.target,
      success: false,
      message: 'Geri alma için sunucu veya bileşen bilgisi eksik.'
    });
  }

  const assignments = await client.getComponentAssetAssignments(item.componentId);
  const existing = assignments.find((row) => Number(row.name?.id) === Number(assetId));
  const assignedQty = Number(existing?.assigned_qty || 0);
  if (!existing || assignedQty <= 0) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'component_checkin',
      target: item.target,
      success: true,
      skipped: true,
      message: 'Bileşen zaten bu sunucudan geri alınmış.'
    });
  }

  if (!existing.assigned_pivot_id) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'component_checkin',
      target: item.target,
      success: false,
      message: 'Envanter bağlantı kaydı bulunamadığı için geri alma tamamlanamadı.'
    });
  }

  const checkinQty = Math.min(assignedQty, Number(item.qty || 1));
  const requestPayload = { checkin_qty: checkinQty };
  return performLoggedOperation(db, sessionId, {
    idempotencyKey: rollbackKey,
    operation: 'component_checkin',
    endpoint: `components/${existing.assigned_pivot_id}/checkin`,
    requestPayload,
    target: item.target,
    runner: async () => client.checkinComponent(existing.assigned_pivot_id, checkinQty)
  });
}

async function rollbackRemovedComponent(db, client, sessionId, assetId, item, rollbackKey) {
  if (hasSuccessfulAudit(db, sessionId, rollbackKey)) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'component_checkout',
      target: item.target,
      success: true,
      skipped: true,
      message: 'Daha önce başarıyla geri alındığı için atlandı.'
    });
  }

  if (!assetId || !item.componentId) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'component_checkout',
      target: item.target,
      success: false,
      message: 'Geri alma için sunucu veya bileşen bilgisi eksik.'
    });
  }

  const assignments = await client.getComponentAssetAssignments(item.componentId);
  const existing = assignments.find((row) => Number(row.name?.id) === Number(assetId));
  const assignedQty = Number(existing?.assigned_qty || 0);
  const desiredQty = Number(item.qty || 1);
  if (assignedQty >= desiredQty) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'component_checkout',
      target: item.target,
      success: true,
      skipped: true,
      message: 'Bileşen zaten önceki varlığa geri atanmış.'
    });
  }

  const checkoutQty = Math.max(1, desiredQty - assignedQty);
  const requestPayload = { assigned_to: assetId, assigned_qty: checkoutQty };
  return performLoggedOperation(db, sessionId, {
    idempotencyKey: rollbackKey,
    operation: 'component_checkout',
    endpoint: `components/${item.componentId}/checkout`,
    requestPayload,
    target: item.target,
    runner: async () => client.checkoutComponent(item.componentId, assetId, checkoutQty)
  });
}

async function rollbackCreatedAsset(db, client, sessionId, assetId, target, rollbackKey) {
  if (hasSuccessfulAudit(db, sessionId, rollbackKey)) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'delete_asset',
      target,
      success: true,
      skipped: true,
      message: 'Daha önce başarıyla geri alındığı için atlandı.'
    });
  }

  if (!assetId) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'delete_asset',
      target,
      success: false,
      message: 'Silinecek yeni envanter sunucusu tespit edilemedi.'
    });
  }

  return performLoggedOperation(db, sessionId, {
    idempotencyKey: rollbackKey,
    operation: 'delete_asset',
    endpoint: `hardware/${assetId}`,
    requestPayload: null,
    target,
    runner: async () => {
      try {
        return await client.deleteAsset(assetId);
      } catch (error) {
        if (error instanceof SnipeItError && error.statusCode === 404) {
          return { already_deleted: true, asset_id: assetId };
        }
        throw error;
      }
    }
  });
}

async function rollbackCreatedComponent(db, client, sessionId, componentId, target, rollbackKey) {
  if (hasSuccessfulAudit(db, sessionId, rollbackKey)) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'delete_component',
      target,
      success: true,
      skipped: true,
      message: 'Daha önce başarıyla geri alındığı için atlandı.'
    });
  }

  if (!componentId) {
    return buildOperationResult({
      key: rollbackKey,
      operation: 'delete_component',
      target,
      success: false,
      message: 'Silinecek yeni bileşen tespit edilemedi.'
    });
  }

  return performLoggedOperation(db, sessionId, {
    idempotencyKey: rollbackKey,
    operation: 'delete_component',
    endpoint: `components/${componentId}`,
    requestPayload: null,
    target,
    runner: async () => {
      try {
        return await client.deleteComponent(componentId);
      } catch (error) {
        if (error instanceof SnipeItError && error.statusCode === 404) {
          return { already_deleted: true, component_id: componentId };
        }
        throw error;
      }
    }
  });
}

function collectRollbackComponentItems(device, list, direction, successfulAudits, assetId) {
  const items = [];
  const components = [...(list || [])].reverse();

  for (const component of components) {
    if (componentUsesUnits(component)) {
      const units = [...(component.units || [])].reverse();
      for (const unit of units) {
        const unitKey = unitKeySuffix(component, unit);
        const originalKey = `${direction}:unit:${unitKey}`;
        const auditEntry = successfulAudits.get(originalKey);
        if (!shouldRollbackAudit(auditEntry, { allowAlreadyAssigned: direction !== 'install' })) {
          // pass
        } else {
          items.push({
            direction,
            originalKey,
            rollbackKey: rollbackKeyFor(originalKey),
            assetId,
            componentId: unit.snipeitComponentId,
            qty: 1,
            target: buildComponentTargetName(device, component, unit)
          });
        }

        const createKey = `create:unit:${unitKey}`;
        const createAudit = successfulAudits.get(createKey);
        if (unit.snipeitMatchStatus === 'create_new' && shouldRollbackAudit(createAudit)) {
          items.push({
            direction: 'create_component',
            originalKey: createKey,
            rollbackKey: rollbackKeyFor(createKey),
            componentId: unit.snipeitComponentId || extractPayloadId(createAudit?.responseBody),
            target: buildComponentTargetName(device, component, unit)
          });
        }
      }
    } else {
      const componentKey = componentKeySuffix(component);
      const originalKey = `${direction}:component:${componentKey}`;
      const auditEntry = successfulAudits.get(originalKey);
      if (!shouldRollbackAudit(auditEntry, { allowAlreadyAssigned: direction !== 'install' })) {
        // pass
      } else {
        items.push({
          direction,
          originalKey,
          rollbackKey: rollbackKeyFor(originalKey),
          assetId,
          componentId: component.snipeitComponentId,
          qty: Number(component.qty || 1),
          target: buildComponentTargetName(device, component)
        });
      }

      const createKey = `create:component:${componentKey}`;
      const createAudit = successfulAudits.get(createKey);
      if (component.snipeitMatchStatus === 'create_new' && shouldRollbackAudit(createAudit)) {
        items.push({
          direction: 'create_component',
          originalKey: createKey,
          rollbackKey: rollbackKeyFor(createKey),
          componentId: component.snipeitComponentId || extractPayloadId(createAudit?.responseBody),
          target: buildComponentTargetName(device, component)
        });
      }
    }
  }

  return items;
}

function collectRollbackPlan(session, successfulAudits) {
  const plan = [];
  const devices = [...(session.devices || [])].reverse();

  for (const device of devices) {
    const createAssetKey = `device:${device.id}:create-asset`;
    const createAssetAudit = successfulAudits.get(createAssetKey);
    const assetId = resolveDeviceAssetId(device, createAssetAudit);

    plan.push(
      ...collectRollbackComponentItems(device, device.components, 'remove', successfulAudits, assetId),
      ...collectRollbackComponentItems(device, device.takilanComponents, 'install', successfulAudits, assetId)
    );

    if (device.assetResolutionMode === 'create_new' && shouldRollbackAudit(createAssetAudit)) {
      plan.push({
        direction: 'create_asset',
        originalKey: createAssetKey,
        rollbackKey: rollbackKeyFor(createAssetKey),
        assetId,
        deviceId: device.id,
        target: device.model || device.etiket || `device:${device.id}`
      });
    }
  }

  return plan;
}

function resetCreatedAssetReferences(session, rollbackPlan) {
  const revertedDeviceIds = new Set(
    rollbackPlan
      .filter((item) => item.direction === 'create_asset')
      .map((item) => Number(item.deviceId))
  );

  for (const device of session.devices || []) {
    if (!revertedDeviceIds.has(Number(device.id))) {
      continue;
    }

    device.snipeitAssetId = null;
    device.snipeitAssetSnapshot = null;
    device.snipeitValidatedAt = null;
  }
}

function resetCreatedComponentReferences(session, rollbackPlan, operations) {
  const successfulKeys = new Set((operations || []).filter((row) => row.success).map((row) => row.key));
  const rolledBackCreates = new Set(
    rollbackPlan
      .filter((step) => step.direction === 'create_component' && successfulKeys.has(step.rollbackKey))
      .map((step) => String(step.originalKey))
  );
  if (!rolledBackCreates.size) {
    return;
  }

  for (const device of session.devices || []) {
    for (const component of [...(device.takilanComponents || []), ...(device.components || [])]) {
      if (componentUsesUnits(component)) {
        for (const unit of component.units || []) {
          const key = `create:unit:${unitKeySuffix(component, unit)}`;
          if (!rolledBackCreates.has(key)) continue;
          unit.snipeitComponentId = null;
          unit.snipeitComponentSnapshot = null;
        }
      } else {
        const key = `create:component:${componentKeySuffix(component)}`;
        if (!rolledBackCreates.has(key)) continue;
        component.snipeitComponentId = null;
        component.snipeitComponentSnapshot = null;
      }
    }
  }
}

async function revertApprovedSession(sessionId, { actorUserId = null, comment = '' } = {}) {
  const db = getDb();
  const session = loadSessionWithDevices(db, sessionId);
  if (!session) {
    throw new Error('Oturum bulunamadı');
  }

  const successfulAudits = listSuccessfulAuditsByKey(db, sessionId);
  const rollbackPlan = collectRollbackPlan(session, successfulAudits);
  const hasLiveChanges = rollbackPlan.length > 0;
  const client = getSnipeItClient();

  if (hasLiveChanges && !client.isConfigured()) {
    return buildSummaryFromOperations([], {
      dryRun: false,
      issues: ['Envanter bağlantısı olmadığı için onay geri alma işlemi tamamlanamadı.']
    });
  }

  if (hasLiveChanges && client.dryRun) {
    return buildSummaryFromOperations([], {
      dryRun: true,
      issues: ['Sistem dry-run modunda olduğu için canlı envanter değişiklikleri geri alınamadı.']
    });
  }

  const operations = [];
  for (const step of rollbackPlan) {
    try {
      if (step.direction === 'remove') {
        operations.push(await rollbackRemovedComponent(db, client, sessionId, step.assetId, step, step.rollbackKey));
      } else if (step.direction === 'install') {
        operations.push(await rollbackInstalledComponent(db, client, sessionId, step.assetId, step, step.rollbackKey));
      } else if (step.direction === 'create_asset') {
        operations.push(await rollbackCreatedAsset(db, client, sessionId, step.assetId, step.target, step.rollbackKey));
      } else if (step.direction === 'create_component') {
        operations.push(await rollbackCreatedComponent(db, client, sessionId, step.componentId, step.target, step.rollbackKey));
      }
    } catch (error) {
      operations.push(buildOperationResult({
        key: step.rollbackKey,
        operation: step.direction === 'create_asset'
          ? 'delete_asset'
          : step.direction === 'create_component'
            ? 'delete_component'
            : step.direction === 'install'
              ? 'component_checkin'
              : 'component_checkout',
        target: step.target,
        success: false,
        message: error.message
      }));
    }
  }

  const summary = buildSummaryFromOperations(operations, { dryRun: false });
  if (summary.status !== 'success') {
    return summary;
  }

  resetCreatedAssetReferences(session, rollbackPlan);
  resetCreatedComponentReferences(session, rollbackPlan, operations);
  replaceSessionData(db, sessionId, session.description, session.devices);

  db.prepare(`
    UPDATE work_sessions
    SET status = 'pending',
        reviewed_by = NULL,
        reviewed_at = NULL,
        review_comment = ?,
        snipeit_sync_status = NULL,
        snipeit_sync_started_at = NULL,
        snipeit_sync_finished_at = NULL,
        snipeit_sync_summary = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(String(comment || '').trim(), sessionId);

  insertSessionEvent(db, sessionId, actorUserId, 'unapproved', {
    comment: String(comment || '').trim(),
    rollback_counts: summary.counts
  });

  if (session.owner?.id) {
    createNotification(session.owner.id, {
      type: 'session_unapproved',
      title: 'Onay geri alındı',
      body: session.title || session.id,
      data: { sessionId, comment: String(comment || '').trim() }
    });
  }

  return summary;
}

async function syncApprovedSession(sessionId, { actorUserId = null, isRetry = false, managerOverrides = [] } = {}) {
  const db = getDb();
  const client = getSnipeItClient();

  if (!client.isConfigured()) {
    const summary = {
      status: 'failed',
      issues: ['Envanter bağlantısı ayarlanmamış.'],
      operations: []
    };
    db.prepare(`
      UPDATE work_sessions
      SET snipeit_sync_status = 'failed',
          snipeit_sync_started_at = COALESCE(snipeit_sync_started_at, datetime('now')),
          snipeit_sync_finished_at = datetime('now'),
          snipeit_sync_summary = ?
      WHERE id = ?
    `).run(JSON.stringify(summary), sessionId);
    return summary;
  }

  const session = loadSessionWithDevices(db, sessionId);
  if (!session) {
    throw new Error('Oturum bulunamadı');
  }

  applyManagerOverrides(session, managerOverrides);

  db.prepare(`
    UPDATE work_sessions
    SET snipeit_sync_status = 'running',
        snipeit_sync_started_at = datetime('now'),
        snipeit_sync_finished_at = NULL
    WHERE id = ?
  `).run(sessionId);

  const validation = await revalidateSessionAgainstSnipe(session);
  replaceSessionData(db, sessionId, session.description, validation.session.devices);

  if (!validation.ok) {
    const summary = {
      status: 'failed',
      issues: validation.issues,
      operations: []
    };
    db.prepare(`
      UPDATE work_sessions
      SET snipeit_sync_status = 'failed',
          snipeit_sync_finished_at = datetime('now'),
          snipeit_sync_summary = ?
      WHERE id = ?
    `).run(JSON.stringify(summary), sessionId);

    if (session.owner?.id) {
      createNotification(session.owner.id, {
        type: 'sync_failed',
        title: 'Envanter senkronizasyonu başarısız',
        body: session.title || session.id,
        data: { sessionId, issues: validation.issues }
      });
    }

    return summary;
  }

  const operations = [];
  for (const device of validation.session.devices || []) {
    try {
      const assetResult = await ensureAssetForDevice(db, client, sessionId, device);
      if (assetResult.operation) {
        operations.push(assetResult.operation);
      }

      if (!assetResult.assetId && client.dryRun) {
        operations.push(buildOperationResult({
          key: `device:${device.id}:dry-run-dependent-components`,
          operation: 'component_checkout',
          target: device.model || device.etiket || `device:${device.id}`,
          success: true,
          skipped: true,
          message: 'Dry-run modunda yeni sunucu ID üretilmediği için bileşen işlemleri simülasyon dışı bırakıldı.'
        }));
        continue;
      }

      operations.push(...await syncComponentList(db, client, sessionId, assetResult.assetId, device, device.takilanComponents, 'install'));
      operations.push(...await syncComponentList(db, client, sessionId, assetResult.assetId, device, device.components, 'remove'));
    } catch (error) {
      operations.push(buildOperationResult({
        key: `device:${device.id}:sync-error`,
        operation: 'device_sync',
        target: device.model || device.etiket || `device:${device.id}`,
        success: false,
        message: error.message
      }));
    }
  }

  replaceSessionData(db, sessionId, validation.session.description, validation.session.devices);

  const summary = buildSummaryFromOperations(operations, { dryRun: client.dryRun });

  db.prepare(`
    UPDATE work_sessions
    SET snipeit_sync_status = ?,
        snipeit_sync_finished_at = datetime('now'),
        snipeit_sync_summary = ?
    WHERE id = ?
  `).run(summary.status, JSON.stringify(summary), sessionId);

  if (isRetry) {
    insertSessionEvent(db, sessionId, actorUserId, 'sync_retried', {
      sync_status: summary.status
    });
  }

  if (summary.status !== 'success' && session.owner?.id) {
    createNotification(session.owner.id, {
      type: 'sync_failed',
      title: 'Envanter senkronizasyonunda sorun var',
      body: session.title || session.id,
      data: { sessionId, status: summary.status }
    });
  }

  return summary;
}

module.exports = {
  applyManagerOverrides,
  revalidateSessionAgainstSnipe,
  revertApprovedSession,
  syncApprovedSession
};
