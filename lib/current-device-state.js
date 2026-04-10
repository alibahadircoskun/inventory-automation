const { getSnipeItClient } = require('./snipeit-client');

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function inferType(category = '', name = '') {
  const haystack = `${normalizeText(category)} ${normalizeText(name)}`;
  if (!haystack) return 'OTHER';
  if (haystack.includes('cpu') || haystack.includes('xeon') || haystack.includes('epyc')) return 'CPU';
  if (haystack.includes('ram') || haystack.includes('ddr') || haystack.includes('memory')) return 'RAM';
  if (haystack.includes('disk') || haystack.includes('ssd') || haystack.includes('sas') || haystack.includes('sata') || haystack.includes('nvme')) return 'DISK';
  if (haystack.includes('nic') || haystack.includes('ethernet') || haystack.includes('fiber') || haystack.includes('network') || haystack.includes('sfp')) return 'NIC';
  return (category || 'OTHER').toUpperCase();
}

function toAssetSummary(asset) {
  return {
    id: asset.id,
    asset_tag: asset.asset_tag || '',
    serial: asset.serial || '',
    model: asset.model || '',
    location: asset.location || '',
    status_label: asset.status_label || ''
  };
}

function sortGroups(groups) {
  const order = ['CPU', 'RAM', 'DISK', 'NIC'];
  return groups.sort((a, b) => {
    const aIndex = order.indexOf(a.label);
    const bIndex = order.indexOf(b.label);
    if (aIndex === -1 && bIndex === -1) return a.label.localeCompare(b.label);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });
}

async function fetchCurrentDeviceStateSnapshot(assetOrId, client = getSnipeItClient()) {
  const asset = typeof assetOrId === 'object'
    ? assetOrId
    : await client.getAssetById(assetOrId);

  if (!asset?.id) {
    throw new Error('Current device state requires a matched Snipe-IT asset.');
  }

  const assignments = await client.getAssignedComponents(asset.id);
  const detailEntries = await Promise.all(assignments.map(async (assignment) => {
    const componentId = Number(assignment.component_id || 0) || null;
    if (!componentId) {
      return [null, null];
    }

    try {
      return [componentId, await client.getComponentById(componentId)];
    } catch (_) {
      return [componentId, null];
    }
  }));

  const detailMap = new Map(detailEntries.filter(([id]) => id));
  const grouped = new Map();

  for (const assignment of assignments) {
    const componentId = Number(assignment.component_id || 0) || null;
    const detail = componentId ? detailMap.get(componentId) : null;
    const name = detail?.name || assignment.component_name || '';
    const category = detail?.category || '';
    const label = inferType(category, name);

    if (!grouped.has(label)) {
      grouped.set(label, []);
    }

    grouped.get(label).push({
      component_id: componentId,
      assigned_pivot_id: assignment.assigned_pivot_id ?? null,
      qty: Number(assignment.assigned_qty || 1) || 1,
      name,
      serial: detail?.serial || '',
      category,
      location: detail?.location || '',
      note: assignment.note || ''
    });
  }

  return {
    asset: toAssetSummary(asset),
    groups: sortGroups(Array.from(grouped.entries()).map(([label, rows]) => ({ label, rows }))),
    counts: {
      groups: grouped.size,
      rows: assignments.length
    }
  };
}

module.exports = {
  fetchCurrentDeviceStateSnapshot
};
