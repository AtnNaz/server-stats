export const ALL_DISKS = '*';

export function diskMounts(snapshot) {
  const seen = new Set();
  return (snapshot?.system?.disks ?? [])
    .filter((d) => !d.error && typeof d.mount === 'string' && d.mount.startsWith('/'))
    .map((d) => d.mount)
    .filter((m) => !seen.has(m) && seen.add(m));
}

export function combineUsage(parts, failed = []) {
  const ok = parts.filter((p) => p?.tree);
  const sum = (k) => ok.reduce((n, p) => n + (p[k] ?? 0), 0);
  const capacities = ok.map((p) => p.capacity).filter(Boolean);
  const children = ok.map((p) => ({ ...p.tree, n: p.path })).sort((a, b) => b.s - a.s);
  return {
    path: ALL_DISKS,
    tree: { n: ALL_DISKS, s: children.reduce((n, c) => n + c.s, 0), f: children.reduce((n, c) => n + (c.f ?? 0), 0), d: children },
    total: sum('total'),
    files: sum('files'),
    dirs: sum('dirs'),
    errors: sum('errors'),
    partial: ok.some((p) => p.partial),
    mounts: [],
    largest: ok
      .flatMap((p) => p.largest ?? [])
      .sort((a, b) => b.size - a.size)
      .slice(0, 50),
    capacity: capacities.length ? { size: capacities.reduce((n, c) => n + c.size, 0), free: capacities.reduce((n, c) => n + c.free, 0) } : null,
    seconds: Math.round(ok.reduce((n, p) => n + (p.seconds ?? 0), 0) * 10) / 10,
    disks: ok.map((p) => p.path),
    failed,
  };
}
