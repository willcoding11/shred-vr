// How big a modelled prop should end up. One rule, shared by the runtime loader and the offline
// asset-check tool, because the two disagreeing is exactly the kind of thing nobody notices until
// the thing you ride and the thing you see are different objects.
//
// No axis is ever scaled on its own. If a model's proportions are wrong for the game that is worth
// seeing, not hiding under a squash — so the game bends to the model rather than the other way
// round, and whatever the rail turns out to measure is what the board rides.

// what each prop should measure when the name alone tells us what it is
export const DEFAULT_H = {
  pine: 8.4, fir: 10.2, birch: 7, rock: 1.2, boulder: 2.8,
  rail: 0.38, hut: 5.2, lamp: 3.6, sign: 2.2, snowman: 3.1, fence: 1.3,
};

// `dims` is the model's own [x, y, z] extent. Returns the uniform scale to apply.
export function scaleFor(entry, type, dims) {
  const want = entry?.length != null ? { by: 'length', size: entry.length }
    : entry?.width != null ? { by: 'width', size: entry.width }
      : { by: 'height', size: entry?.height ?? DEFAULT_H[type] ?? 1 };
  const have = want.by === 'length' ? Math.max(dims[0], dims[2])
    : want.by === 'width' ? Math.min(dims[0], dims[2])
      : dims[1];
  if (!(want.size > 0) || !(have > 1e-6)) return 1;
  return want.size / have;
}

// The finished [width, height, length] of a prop, in metres.
export function finalSize(entry, type, dims) {
  const k = scaleFor(entry, type, dims);
  const d = dims.map((v) => v * k);
  return [Math.min(d[0], d[2]), d[1], Math.max(d[0], d[2])];
}

// Push measured sizes into PROP_TYPES, so the headless tools ride the same rail the game draws.
// The browser gets these from the model directly; Node gets them from assets/sizes.json, which
// tools/asset-check.mjs writes. Without this the sim would still be riding the placeholder box
// while the game rode the model, and the two would disagree silently.
export function applySizes(PROP_TYPES, sizes) {
  if (!sizes) return;
  const r = sizes.rail;
  if (r && PROP_TYPES.rail) {
    PROP_TYPES.rail.railW = r[0]; PROP_TYPES.rail.railH = r[1]; PROP_TYPES.rail.len = r[2];
  }
  for (const [t, d] of Object.entries(sizes)) {
    if (t !== 'rail' && PROP_TYPES[t] && d[1] > 0) PROP_TYPES[t].ch = d[1];
  }
}
