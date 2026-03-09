function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function sampleOne(list) {
  if (!list || list.length === 0) return null;
  return list[randomInt(list.length)];
}

function scoreGap(a, b) {
  return Math.abs((a.score ?? 0) - (b.score ?? 0));
}

function uncertaintyValue(item) {
  return item.uncertainty ?? 1;
}

export function buildExposureMap(votes, characterIds) {
  const map = new Map(characterIds.map((id) => [id, 0]));
  for (const v of votes) {
    map.set(v.left_id, (map.get(v.left_id) ?? 0) + 1);
    map.set(v.right_id, (map.get(v.right_id) ?? 0) + 1);
  }
  return map;
}

export function chooseNextPair({
  characters,
  scoresById = {},
  exposureById = new Map(),
  pairCountsByKey = new Map(),
  seenPairs = new Set(),
  coverageTarget = 20,
}) {
  if (!characters || characters.length < 2) return null;

  const enriched = characters.map((c) => ({
    ...c,
    score: scoresById[c.id]?.score ?? 0,
    uncertainty: scoresById[c.id]?.uncertainty ?? 1,
    exposure: exposureById.get(c.id) ?? 0,
  }));

  const underexposed = enriched.filter((c) => c.exposure < coverageTarget);

  // Stage 1: coverage-first
  if (underexposed.length > 0) {
    const a = sampleOne(underexposed);
    // Prefer an opponent from a different exposure bucket.
    const low = enriched.filter((c) => c.exposure < coverageTarget);
    const mid = enriched.filter((c) => c.exposure >= coverageTarget && c.exposure < coverageTarget * 2);
    const high = enriched.filter((c) => c.exposure >= coverageTarget * 2);

    let bucket = high;
    if (a.exposure >= coverageTarget * 2) bucket = low;
    else if (a.exposure >= coverageTarget) bucket = Math.random() < 0.5 ? low : high;

    let candidates = bucket.filter((c) => c.id !== a.id && !seenPairs.has(pairKey(a.id, c.id)));
    if (candidates.length === 0) {
      candidates = enriched.filter((c) => c.id !== a.id && !seenPairs.has(pairKey(a.id, c.id)));
    }
    const b = sampleOne(candidates);
    if (b) return [a, b];
  }

  // Stage 2: uncertainty-driven with exploration.
  const roll = Math.random();

  // 20% exploration.
  if (roll < 0.2) {
    for (let tries = 0; tries < 30; tries += 1) {
      const a = sampleOne(enriched);
      const b = sampleOne(enriched);
      if (!a || !b || a.id === b.id) continue;
      if (seenPairs.has(pairKey(a.id, b.id))) continue;
      return [a, b];
    }
  }

  // 80% exploit uncertainty among close-score neighbors with low pair-count preference.
  const sorted = [...enriched].sort((x, y) => uncertaintyValue(y) - uncertaintyValue(x));
  const top = sorted.slice(0, Math.max(8, Math.floor(sorted.length * 0.3)));

  let best = null;
  let bestUtility = -Infinity;
  for (let i = 0; i < top.length; i += 1) {
    for (let j = i + 1; j < top.length; j += 1) {
      const a = top[i];
      const b = top[j];
      const key = pairKey(a.id, b.id);
      if (seenPairs.has(key)) continue;

      const u = uncertaintyValue(a) + uncertaintyValue(b);
      const gap = scoreGap(a, b);
      const closeScore = 1 / (1 + gap);
      const pairCount = pairCountsByKey.get(key) ?? 0;
      const sparseBonus = 1 / Math.sqrt(pairCount + 1);
      const utility = (1.4 * u) + (1.1 * closeScore) + sparseBonus;

      if (utility > bestUtility) {
        bestUtility = utility;
        best = [a, b];
      }
    }
  }

  if (best) return best;

  // Final fallback.
  const a = sampleOne(enriched);
  const b = sampleOne(enriched.filter((c) => c.id !== a.id));
  return a && b ? [a, b] : null;
}

export function rememberPair(seenPairs, leftId, rightId) {
  seenPairs.add(pairKey(leftId, rightId));
}
