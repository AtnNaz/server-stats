import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DISKS, diskMounts, combineUsage } from '../src/usage.js';

const part = (path, size, files, extra = {}) => ({
  path,
  tree: { n: path === '/' ? '/' : path.split('/').pop(), s: size, f: files, d: [{ n: 'data', s: size, f: files }] },
  total: size,
  files,
  dirs: 1,
  errors: 0,
  partial: false,
  mounts: [],
  largest: [{ path: `${path === '/' ? '' : path}/data/big.bin`, size: size / 2 }],
  capacity: { size: size * 4, free: size * 3 },
  seconds: 1.5,
  ...extra,
});

test('tüm disklerin tarama sonuçları tek ağaçta birleşir', () => {
  const out = combineUsage([part('/', 100, 10), part('/mnt/veri', 300, 5, { partial: true, errors: 2 }), null], [{ path: '/mnt/yedek', error: 'timeout' }]);
  assert.equal(out.path, ALL_DISKS);
  assert.equal(out.tree.s, 400);
  assert.equal(out.tree.f, 15);
  assert.deepEqual(out.tree.d.map((c) => c.n), ['/mnt/veri', '/'], 'en büyük disk önce, adları bağlama noktası');
  assert.equal(out.tree.d[0].d[0].n, 'data');
  assert.equal(out.files, 15);
  assert.equal(out.errors, 2);
  assert.equal(out.partial, true);
  assert.deepEqual(out.capacity, { size: 1600, free: 1200 });
  assert.equal(out.largest[0].path, '/mnt/veri/data/big.bin');
  assert.equal(out.seconds, 3);
  assert.deepEqual(out.failed, [{ path: '/mnt/yedek', error: 'timeout' }]);
});

test('taranacak diskler anlık görüntüden alınır; hatalı ve tekrar edenler atlanır', () => {
  const snapshot = { system: { disks: [{ mount: '/' }, { mount: '/mnt/veri' }, { mount: '/mnt/veri' }, { mount: '/mnt/bozuk', error: 'x' }, { mount: 'relative' }] } };
  assert.deepEqual(diskMounts(snapshot), ['/', '/mnt/veri']);
  assert.deepEqual(diskMounts(null), []);
});
