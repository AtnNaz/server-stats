export const ACK_COUNTERS = ['reallocated', 'pending', 'offlineUncorrectable', 'reportedUncorrect', 'mediaErrors'];
export const MAX_ACKS = 32;

const ATA_COUNTERS = { 5: 'reallocated', 187: 'reportedUncorrect', 197: 'pending', 198: 'offlineUncorrectable' };

export function smartCounters(data) {
  const out = {};
  for (const a of data?.ata_smart_attributes?.table ?? []) {
    if (ATA_COUNTERS[a.id] && Number.isFinite(a.raw?.value)) out[ATA_COUNTERS[a.id]] = a.raw.value;
  }
  const nvme = data?.nvme_smart_health_information_log;
  if (nvme && Number.isFinite(nvme.media_errors)) out.mediaErrors = nvme.media_errors;
  return out;
}

const SERIAL = /^[\x21-\x7e][\x20-\x7e]{0,63}$/;
const TEXT = /^[\x20-\x7e\u00a0-\uffff]{0,128}$/;

export function validAck(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  if (Object.keys(a).some((k) => !['serial', 'model', 'counters', 'at'].includes(k))) return false;
  if (typeof a.serial !== 'string' || !SERIAL.test(a.serial)) return false;
  if (a.model !== undefined && a.model !== null && (typeof a.model !== 'string' || !TEXT.test(a.model))) return false;
  if (!Number.isInteger(a.at) || a.at < 0) return false;
  if (!a.counters || typeof a.counters !== 'object' || Array.isArray(a.counters)) return false;
  return Object.entries(a.counters).every(([k, v]) => ACK_COUNTERS.includes(k) && Number.isInteger(v) && v >= 0 && v <= 1e12);
}

export const validAcks = (v) => Array.isArray(v) && v.length <= MAX_ACKS && v.every(validAck) && new Set(v.map((a) => a.serial)).size === v.length;

export const findAck = (acks, serial) => (serial ? (acks ?? []).find((a) => a.serial === serial) ?? null : null);

export function acknowledged(acks, serial, counters) {
  const ack = findAck(acks, serial);
  if (!ack) return false;
  return ACK_COUNTERS.every((k) => (counters?.[k] ?? 0) <= (ack.counters?.[k] ?? 0));
}

export function markAcknowledged(devices, acks) {
  if (!acks?.length) return devices;
  return devices.map((d) => {
    const s = d.smart;
    if (!s || !findAck(acks, s.serial)) return d;
    return { ...d, smart: { ...s, acknowledged: acknowledged(acks, s.serial, s.counters), ackedAt: findAck(acks, s.serial).at } };
  });
}
