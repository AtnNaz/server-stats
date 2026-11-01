import { execFile } from 'node:child_process';
import { t } from '../i18n.js';
import { readText } from '../util.js';

export const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9@._:\\-]*$/;

const PROPERTIES = [
  'Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'ActiveEnterTimestampMonotonic',
  'MainPID', 'MemoryCurrent', 'NRestarts', 'UnitFileState',
];

export function parseSystemctlShow(text) {
  return text
    .split(/\n\s*\n/)
    .filter((block) => block.trim())
    .map((block) =>
      Object.fromEntries(
        block
          .split('\n')
          .map((line) => {
            const i = line.indexOf('=');
            return i === -1 ? null : [line.slice(0, i), line.slice(i + 1)];
          })
          .filter(Boolean),
      ),
    );
}

const toNumber = (v) => {
  if (v == null || v === '' || v === '[not set]') return null;
  const n = Number(v);
  return Number.isFinite(n) && n < 2 ** 63 ? n : null; // UINT64_MAX "bilinmiyor" demektir
};

export function toService(name, props, uptimeSeconds) {
  const enteredMicros = toNumber(props.ActiveEnterTimestampMonotonic);
  return {
    name,
    unit: props.Id || name,
    description: props.Description || '',
    load: props.LoadState || 'unknown',
    active: props.ActiveState || 'unknown',
    sub: props.SubState || '',
    activeFor: props.ActiveState === 'active' && enteredMicros ? Math.max(0, Math.round(uptimeSeconds - enteredMicros / 1e6)) : null,
    mainPid: toNumber(props.MainPID) || null,
    memory: toNumber(props.MemoryCurrent),
    restarts: toNumber(props.NRestarts) ?? 0,
    enabled: props.UnitFileState || null,
  };
}

function systemctlShow(units) {
  const args = ['show', '--no-pager', `--property=${PROPERTIES.join(',')}`, '--', ...units];
  return new Promise((resolve, reject) => {
    execFile('systemctl', args, { timeout: 2000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C', SYSTEMD_PAGER: '' } }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error(t('err.systemctlMissing')));
      reject(new Error(t('err.systemctl', { msg: (stderr || err.message).trim().split('\n')[0] })));
    });
  });
}

export function createServiceCollector(units) {
  return {
    async collect() {
      if (!units.length) return { units: [] };
      const [output, uptimeText] = await Promise.all([systemctlShow(units), readText('/proc/uptime')]);
      const uptime = Number(uptimeText.split(' ')[0]);
      // systemctl blokları istenen sırayla yazar.
      const blocks = parseSystemctlShow(output);
      return { units: units.map((name, i) => toService(name, blocks[i] ?? {}, uptime)) };
    },
  };
}
