import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { parseCpuStat, cpuUsage, parseMeminfo, memoryFromMeminfo, parseMounts, selectDisks } from '../src/collectors/system.js';
import { parseNetDev, parseSockets, groupPorts, hexToIPv6, globMatcher, exposure } from '../src/collectors/network.js';
import { parseProcStat } from '../src/collectors/processes.js';
import { parseSystemctlShow, toService } from '../src/collectors/services.js';
import { summarizePorts } from '../src/collectors/docker.js';
import { parseGpus, parseGpuApps, findExecutable } from '../src/collectors/gpu.js';

const littleEndian = os.endianness() === 'LE';

test('CPU kullanımı iki /proc/stat örneğinin farkından hesaplanır', () => {
  const a = parseCpuStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\ncpu1 50 0 25 400 25 0 0 0 0 0\nintr 1 2 3\n');
  const b = parseCpuStat('cpu  150 0 75 850 50 0 0 0 0 0\ncpu0 100 0 50 400 25 0 0 0 0 0\ncpu1 50 0 25 450 25 0 0 0 0 0\n');
  assert.equal(a.cores.length, 2);
  assert.deepEqual(cpuUsage(a.total, b.total), { usage: 60, iowait: 0, steal: 0 });
  assert.equal(cpuUsage(a.cores[0], b.cores[0]).usage, 100);
  assert.equal(cpuUsage(a.cores[1], b.cores[1]).usage, 0);
  assert.equal(cpuUsage(a.total, a.total), null);
});

test('bellek MemAvailable üzerinden hesaplanır', () => {
  const mem = memoryFromMeminfo(
    parseMeminfo(
      [
        'MemTotal:       16000000 kB',
        'MemFree:         2000000 kB',
        'MemAvailable:    8000000 kB',
        'Buffers:          500000 kB',
        'Cached:          4000000 kB',
        'Active(anon):    1000000 kB',
        'SReclaimable:     250000 kB',
        'SwapTotal:       2000000 kB',
        'SwapFree:        1500000 kB',
        'HugePages_Total:       0',
      ].join('\n'),
    ),
  );
  assert.equal(mem.total, 16000000 * 1024);
  assert.equal(mem.percent, 50);
  assert.equal(mem.swapPercent, 25);
  assert.equal(mem.cached, (4000000 + 250000 + 500000) * 1024);
});

test('sanal dosya sistemleri elenir, aynı aygıt tek satırda birleşir', () => {
  const mounts = parseMounts(
    [
      '/dev/sda1 /var/lib/docker ext4 rw,relatime 0 0',
      '/dev/sda1 / ext4 rw,relatime 0 0',
      'proc /proc proc rw 0 0',
      'tmpfs /run tmpfs rw 0 0',
      '/dev/sdb1 /mnt/yedek\\040disk xfs ro,noatime 0 0',
      'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0',
      '/dev/loop0 /snap/core/1 squashfs ro 0 0',
    ].join('\n'),
  );
  const disks = selectDisks(mounts);
  assert.deepEqual(
    disks.map((d) => [d.mount, d.alsoMounted, d.readOnly]),
    [
      ['/', ['/var/lib/docker'], false],
      ['/mnt/yedek disk', [], true],
    ],
  );
});

test('gizlenen bağlama noktaları (/boot, /boot/efi) disk listesine girmez', () => {
  const mounts = parseMounts(
    [
      '/dev/mapper/vg-root / ext4 rw 0 0',
      '/dev/nvme0n1p2 /boot ext4 rw 0 0',
      '/dev/nvme0n1p1 /boot/efi vfat rw 0 0',
      '/dev/sdb1 /mnt/data ext4 rw 0 0',
      '/dev/sdc1 /mnt/yedek-eski ext4 rw 0 0',
    ].join('\n'),
  );
  const hidden = globMatcher(['/boot', '/boot/efi', '/mnt/yedek*']);
  assert.deepEqual(selectDisks(mounts, hidden).map((d) => d.mount), ['/', '/mnt/data']);
  assert.equal(selectDisks(mounts).length, 5); // gizleme listesi yoksa hepsi görünür
});

test('/proc/net/dev sayaçları okunur', () => {
  const text = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo:    1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0',
    '  eth0: 5000000    4000    1    2    0     0          0         0  2000000    3000    3    4    0     0       0          0',
  ].join('\n');
  const dev = parseNetDev(text);
  assert.deepEqual(dev.eth0, { rxBytes: 5000000, rxErrors: 1, rxDrop: 2, txBytes: 2000000, txErrors: 3, txDrop: 4 });
  assert.equal(dev.lo.rxBytes, 1000);
});

test('dinlenen portlar bulunur, kurulu bağlantılar ve geçici UDP portları elenir', { skip: !littleEndian }, () => {
  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 12346 1 0000000000000000 100 0 0 10 0',
    '   2: 0F02000A:0016 0202000A:D2F0 01 00000000:00000000 02:00000000 00000000     0        0 12347 4 0000000000000000 20 4 30 10 -1',
  ].join('\n');
  const tcp6 = [
    '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22345 1 0000000000000000 100 0 0 10 0',
    '   1: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22346 1 0000000000000000 100 0 0 10 0',
  ].join('\n');
  const udp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops',
    '  100: 3500007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000   101        0 3456 2 0000000000000000 0',
    '  101: 00000000:8F2A 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 3457 2 0000000000000000 0',
    '  102: 0F02000A:9C40 08080808:0035 01 00000000:00000000 00:00000000 00000000     0        0 3458 2 0000000000000000 0',
  ].join('\n');

  const sockets = [...parseSockets(tcp, 'tcp'), ...parseSockets(tcp6, 'tcp6'), ...parseSockets(udp, 'udp')];
  const ports = groupPorts(sockets, [32768, 60999]);
  assert.deepEqual(ports, [
    { proto: 'tcp', port: 22, addresses: ['0.0.0.0', '::'], exposure: 'all' },
    { proto: 'udp', port: 53, addresses: ['127.0.0.53'], exposure: 'local' },
    { proto: 'tcp', port: 3306, addresses: ['127.0.0.1'], exposure: 'local' },
    { proto: 'tcp', port: 8080, addresses: ['::1'], exposure: 'local' },
  ]);
});

test('IPv6 adresleri kısaltılarak yazılır', { skip: !littleEndian }, () => {
  assert.equal(hexToIPv6('00000000000000000000000000000000'), '::');
  assert.equal(hexToIPv6('00000000000000000000000001000000'), '::1');
  assert.equal(hexToIPv6('B80D0120000000000000000001000000'), '2001:db8::1');
  assert.equal(hexToIPv6('0000000000000000FFFF00000100007F'), '::ffff:127.0.0.1');
  assert.equal(exposure('::ffff:127.0.0.1'), 'local');
  assert.equal(exposure('192.168.1.10'), 'specific');
});

test('arayüz gizleme kalıpları', () => {
  const re = globMatcher(['lo', 'veth*', 'br-*']);
  assert.ok(re.test('lo'));
  assert.ok(re.test('veth12ab'));
  assert.ok(re.test('br-1a2b'));
  assert.ok(!re.test('eth0'));
  assert.ok(!re.test('lo0x'));
  assert.ok(!globMatcher([]).test('eth0'));
});

test('süreç adı boşluk ve parantez içerse de /proc/[pid]/stat doğru okunur', () => {
  const p = parseProcStat('1234 (my (weird) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 3 0 5000 12345678 2560 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0');
  assert.deepEqual(p, { pid: 1234, comm: 'my (weird) proc', state: 'S', ppid: 1, ticks: 300, threads: 3, start: 5000, rssPages: 2560 });
});

test('systemctl show çıktısı servis durumlarına dönüştürülür', () => {
  const blocks = parseSystemctlShow(
    [
      'Id=ssh.service',
      'Description=OpenBSD Secure Shell server',
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      'ActiveEnterTimestampMonotonic=5000000',
      'MainPID=812',
      'MemoryCurrent=6291456',
      'NRestarts=0',
      'UnitFileState=enabled',
      '',
      'Id=yok.service',
      'Description=yok.service',
      'LoadState=not-found',
      'ActiveState=inactive',
      'SubState=dead',
      'ActiveEnterTimestampMonotonic=0',
      'MainPID=0',
      'MemoryCurrent=[not set]',
      'NRestarts=0',
      'UnitFileState=',
      '',
    ].join('\n'),
  );
  assert.equal(blocks.length, 2);
  const ssh = toService('ssh', blocks[0], 3605);
  assert.equal(ssh.activeFor, 3600);
  assert.equal(ssh.memory, 6291456);
  assert.equal(ssh.mainPid, 812);
  const missing = toService('yok', blocks[1], 3605);
  assert.equal(missing.load, 'not-found');
  assert.equal(missing.activeFor, null);
  assert.equal(missing.memory, null);
  assert.equal(toService('x', { MemoryCurrent: '18446744073709551615' }, 0).memory, null);
});

test('Docker port etiketleri tekilleştirilir', () => {
  assert.deepEqual(
    summarizePorts([
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
      { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
      { PrivatePort: 5432, Type: 'tcp' },
    ]),
    ['8080→80/tcp', '5432/tcp'],
  );
});

test('nvidia-smi çıktısı okunur; virgüllü ad ve desteklenmeyen değerler doğru işlenir', () => {
  const gpus = parseGpus(
    [
      '0, GPU-0a41, NVIDIA Example GPU 12GB, 595.91.07, 0, 3, 12282, 7793, 36, 6.57, 70.00, 30, 210, 2100, P8',
      '1, GPU-ffff, Tesla T4, PCIe, 595.91.07, 87, 40, 15360, 1024, 71, [N/A], [Not Supported], [N/A], 1590, 1590, P0',
    ].join('\n'),
  );
  assert.equal(gpus.length, 2);
  assert.deepEqual(
    { name: gpus[0].name, util: gpus[0].utilization, temp: gpus[0].temperature, power: gpus[0].powerDraw, vram: gpus[0].memoryPercent, used: gpus[0].memoryUsed },
    { name: 'NVIDIA Example GPU 12GB', util: 0, temp: 36, power: 6.57, vram: 63.5, used: 7793 * 1024 * 1024 },
  );
  assert.equal(gpus[1].name, 'Tesla T4, PCIe');
  assert.equal(gpus[1].utilization, 87);
  assert.equal(gpus[1].powerDraw, null);
  assert.equal(gpus[1].powerLimit, null);
  assert.equal(gpus[1].fan, null);
  assert.equal(gpus[1].pstate, 'P0');

  const apps = parseGpuApps('GPU-0a41, 6312, /opt/example/bin/inference-server, 7776\nGPU-0a41, [N/A], [N/A], [N/A]\n');
  assert.deepEqual(apps, [{ uuid: 'GPU-0a41', pid: 6312, name: 'inference-server', command: '/opt/example/bin/inference-server', memory: 7776 * 1024 * 1024 }]);
});

test('çalıştırılabilir dosya PATH içinde aranır', () => {
  assert.equal(findExecutable('node', path.dirname(process.execPath)), process.execPath);
  assert.equal(findExecutable('kesinlikle-olmayan-arac', '/usr/bin:/bin'), null);
});

test('kalıp eşleme geri izlemesizdir: çok yıldızlı kalıp uzun yolda takılmaz', () => {
  const m = globMatcher(['/mnt/*a*a*a*a*a*a*b']);
  const started = Date.now();
  assert.equal(m.test(`/mnt/${'a'.repeat(4000)}`), false);
  assert.ok(Date.now() - started < 500);
  assert.ok(globMatcher(['/mnt/*/yedek*']).test('/mnt/disk1/yedek-2026'));
  assert.ok(!globMatcher(['/mnt/*/yedek*']).test('/mnt/disk1/diger'));
  assert.ok(globMatcher(['*']).test(''));
});

test('statfs koruması: aynı anda sorgulanan sağlam diskler "yanıt vermiyor" sayılmaz', async () => {
  const { createStatfsGuard } = await import('../src/collectors/system.js');
  const ok = { blocks: 100, bfree: 50, bavail: 50, bsize: 4096, files: 10, ffree: 5 };
  const hung = new Set(['/mnt/nfs1', '/mnt/nfs2', '/mnt/nfs3']);
  let clock = 0;
  const query = createStatfsGuard({ statfsImpl: (m) => (hung.has(m) ? new Promise(() => {}) : new Promise((r) => setTimeout(() => r(ok), 5))), timeoutMs: 50, now: () => clock });
  const mounts = ['/', '/a', '/b', '/c', '/d', '/e'];
  const results = await Promise.allSettled(mounts.map(query));
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'altı sağlam disk birlikte sorgulanabilmeli');
  // İki takılı disk sınırı doldurunca başka sorgu başlatılmaz; sağlam diskler de beklemez.
  const stuck = ['/mnt/nfs1', '/mnt/nfs2'].map((m) => query(m).catch(() => 'zaman aşımı'));
  clock = 100;
  assert.equal(await stuck[0], 'zaman aşımı');
  await assert.rejects(query('/mnt/nfs3'));
  await assert.rejects(query('/'));
});
