import { getOrCreateWorkerId, fetchLiveStats, requestNextPair } from "./api.js";
import { buildExposureMap, chooseNextPair, rememberPair } from "./pair_selector.js";
import { VoteService } from "./vote_service.js";

const COVERAGE_TARGET = 20;
const STATS_POLL_MS = 15000;

const els = {
  includePPlus: document.getElementById("include-pplus"),
  poolInfo: document.getElementById("pool-info"),
  status: document.getElementById("status"),
  queueStatus: document.getElementById("queue-status"),
  liveFeedback: document.getElementById("live-feedback"),
  leftName: document.getElementById("left-name"),
  rightName: document.getElementById("right-name"),
  leftImage: document.getElementById("left-image"),
  rightImage: document.getElementById("right-image"),
  leftVote: document.getElementById("left-vote"),
  rightVote: document.getElementById("right-vote"),
  skipVote: document.getElementById("skip-vote"),
};

const state = {
  allCharacters: [],
  charById: new Map(),
  pPlusIds: new Set(),
  activeCharacters: [],
  localVotes: [],
  seenPairs: new Set(),
  currentPair: null,
  pairShownAt: performance.now(),
  skipped: 0,
  sentVotes: 0,
  voteService: null,
  apiBase: "",
  loadingPair: false,
  lastPairSource: "local",
  globalStats: {
    phase: "coverage",
    totalVotes: 0,
    modelUpdatedAt: null,
    scoresById: {},
    exposureById: new Map(),
    pairCountsByKey: new Map(),
  },
};

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function randomPair(chars) {
  if (chars.length < 2) return null;
  const a = chars[Math.floor(Math.random() * chars.length)];
  let b = chars[Math.floor(Math.random() * chars.length)];
  let guard = 0;
  while (b.id === a.id && guard < 20) {
    b = chars[Math.floor(Math.random() * chars.length)];
    guard += 1;
  }
  return a.id !== b.id ? [a, b] : null;
}

function parseIsoTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function sinceLabel(value) {
  const d = parseIsoTime(value);
  if (!d) return "not computed yet";
  const deltaSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

async function fetchJson(path, fallback) {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

function extractPPlusSet(raw) {
  if (Array.isArray(raw)) return new Set(raw);
  if (raw && Array.isArray(raw.ids)) return new Set(raw.ids);
  return new Set();
}

function updatePool() {
  if (els.includePPlus.checked) {
    state.activeCharacters = [...state.allCharacters];
  } else {
    state.activeCharacters = state.allCharacters.filter((c) => !state.pPlusIds.has(c.id));
  }
  els.poolInfo.textContent = `Pool: ${state.activeCharacters.length} characters`;
}

function updateStatus(text) {
  els.status.textContent = text;
}

function updateLiveFeedback() {
  const phase = state.globalStats.phase || "coverage";
  const votes = state.globalStats.totalVotes || 0;
  const modelSince = sinceLabel(state.globalStats.modelUpdatedAt);
  const source = state.lastPairSource;
  els.liveFeedback.textContent = `Live: ${votes} votes | Phase: ${phase} | Model: ${modelSince} | Pairing: ${source}`;
}

async function updateQueueStatus() {
  els.queueStatus.textContent = `Sent: ${state.sentVotes} | Skipped: ${state.skipped}`;
}

function setPair(pair) {
  if (!pair) {
    els.leftName.textContent = "No character";
    els.rightName.textContent = "No character";
    els.leftImage.removeAttribute("src");
    els.rightImage.removeAttribute("src");
    els.leftVote.disabled = true;
    els.rightVote.disabled = true;
    els.skipVote.disabled = true;
    updateStatus("Not enough characters in the current pool.");
    state.currentPair = null;
    return;
  }

  const [left, right] = pair;
  state.currentPair = pair;
  state.pairShownAt = performance.now();

  els.leftName.textContent = left.name;
  els.rightName.textContent = right.name;
  els.leftImage.src = left.image;
  els.rightImage.src = right.image;
  els.leftImage.alt = left.name;
  els.rightImage.alt = right.name;
  els.leftVote.textContent = `Vote for ${left.name}`;
  els.rightVote.textContent = `Vote for ${right.name}`;
  els.leftVote.disabled = false;
  els.rightVote.disabled = false;
  els.skipVote.disabled = false;
  updateStatus("Choose the better character.");
}

function applyStatsPayload(stats) {
  state.globalStats.phase = stats.phase || state.globalStats.phase;
  state.globalStats.totalVotes = Number(stats.total_votes || 0);
  state.globalStats.modelUpdatedAt = stats.model_updated_at || null;
  const nextScores = {};
  if (stats.scores_by_id && typeof stats.scores_by_id === "object") {
    Object.assign(nextScores, stats.scores_by_id);
  }

  const exposureMap = new Map();
  const pairCountMap = new Map();

  if (Array.isArray(stats.characters)) {
    for (const row of stats.characters) {
      if (row && row.id) {
        nextScores[row.id] = {
          score: Number(row.score || 0),
          uncertainty: Number(row.uncertainty || 1),
          exposure: Number(row.exposure || 0),
        };
        exposureMap.set(row.id, Number(row.exposure || 0));
      }
    }
  } else {
    for (const [id, row] of Object.entries(nextScores)) {
      exposureMap.set(id, Number(row.exposure || 0));
    }
  }

  state.globalStats.scoresById = nextScores;

  if (stats.pair_counts && typeof stats.pair_counts === "object") {
    for (const [key, value] of Object.entries(stats.pair_counts)) {
      pairCountMap.set(key, Number(value || 0));
    }
  }

  state.globalStats.exposureById = exposureMap;
  state.globalStats.pairCountsByKey = pairCountMap;
}

async function refreshLiveStats() {
  if (!state.apiBase) {
    updateLiveFeedback();
    return;
  }

  try {
    const res = await fetchLiveStats(state.apiBase, { includePPlus: els.includePPlus.checked });
    if (res.ok && res.data) {
      applyStatsPayload(res.data);
    }
  } catch {
    // keep last known stats
  }

  updateLiveFeedback();
}

function mapPairIdsToCharacters(leftId, rightId) {
  if (!leftId || !rightId) return null;
  const left = state.charById.get(leftId);
  const right = state.charById.get(rightId);
  if (!left || !right) return null;

  const active = new Set(state.activeCharacters.map((c) => c.id));
  if (!active.has(leftId) || !active.has(rightId)) return null;
  return [left, right];
}

async function pickServerPair() {
  if (!state.apiBase || state.activeCharacters.length < 2) return null;

  const payload = {
    worker_id: getOrCreateWorkerId(),
    include_pplus: els.includePPlus.checked,
    coverage_target: COVERAGE_TARGET,
    character_ids: state.activeCharacters.map((c) => c.id),
    seen_pairs: Array.from(state.seenPairs).slice(0, 300),
  };

  try {
    const res = await requestNextPair(state.apiBase, payload);
    if (!res.ok || !res.data || !res.data.left_id || !res.data.right_id) return null;
    if (res.data.phase) state.globalStats.phase = res.data.phase;
    if (res.data.model_updated_at) state.globalStats.modelUpdatedAt = res.data.model_updated_at;
    return mapPairIdsToCharacters(res.data.left_id, res.data.right_id);
  } catch {
    return null;
  }
}

function pickLocalPair() {
  const chars = state.activeCharacters;
  if (chars.length < 2) return null;

  const localExposure = buildExposureMap(state.localVotes, chars.map((c) => c.id));
  const exposureById = state.globalStats.exposureById.size > 0 ? state.globalStats.exposureById : localExposure;

  const pair = chooseNextPair({
    characters: chars,
    scoresById: state.globalStats.scoresById,
    exposureById,
    pairCountsByKey: state.globalStats.pairCountsByKey,
    seenPairs: state.seenPairs,
    coverageTarget: COVERAGE_TARGET,
  });

  return pair || randomPair(chars);
}

async function nextPair() {
  if (state.loadingPair) return;
  state.loadingPair = true;
  els.leftVote.disabled = true;
  els.rightVote.disabled = true;
  els.skipVote.disabled = true;

  try {
    if (state.activeCharacters.length < 2) {
      setPair(null);
      return;
    }

    let pair = await pickServerPair();
    if (pair) {
      state.lastPairSource = "server-optimized";
      setPair(pair);
      updateLiveFeedback();
      return;
    }

    pair = pickLocalPair();
    if (pair) {
      state.lastPairSource = "local-fallback";
      setPair(pair);
      updateLiveFeedback();
      return;
    }

    state.seenPairs.clear();
    setPair(randomPair(state.activeCharacters));
  } finally {
    state.loadingPair = false;
  }
}

async function handleVote(winnerSide) {
  if (!state.currentPair) return;
  const [left, right] = state.currentPair;
  const winnerId = winnerSide === "left" ? left.id : right.id;

  const responseMs = performance.now() - state.pairShownAt;
  rememberPair(state.seenPairs, left.id, right.id);

  state.localVotes.push({
    left_id: left.id,
    right_id: right.id,
    winner_id: winnerId,
  });

  const result = await state.voteService.recordVote({
    leftId: left.id,
    rightId: right.id,
    winnerId,
    responseMs,
  });

  if (result.sent) {
    state.sentVotes += 1;
    updateStatus("Vote submitted.");
  } else {
    updateStatus("Vote queued (temporary network/API issue).");
  }

  const flushed = await state.voteService.flushPending();
  state.sentVotes += Number(flushed || 0);
  await updateQueueStatus();
  await refreshLiveStats();
  await nextPair();
}

async function handleSkip() {
  state.skipped += 1;
  updateStatus("Skipped. Next matchup loaded.");
  await updateQueueStatus();
  await nextPair();
}

async function init() {
  const [characters, pollConfig, pPlusRaw] = await Promise.all([
    fetchJson("data/characters.json", []),
    fetchJson("data/poll_config.json", {}),
    fetchJson("data/p_plus_ids.json", []),
  ]);

  state.allCharacters = characters;
  state.charById = new Map(characters.map((c) => [c.id, c]));
  state.pPlusIds = extractPPlusSet(pPlusRaw);

  const apiBaseRaw = pollConfig.api_base || "";
  state.apiBase = apiBaseRaw.includes("REPLACE_ME") ? "" : apiBaseRaw;
  state.voteService = new VoteService(state.apiBase, pollConfig.site_version || "1.0.0");

  els.includePPlus.addEventListener("change", async () => {
    state.seenPairs.clear();
    updatePool();
    await refreshLiveStats();
    await nextPair();
  });

  els.leftVote.addEventListener("click", () => {
    void handleVote("left");
  });

  els.rightVote.addEventListener("click", () => {
    void handleVote("right");
  });

  els.skipVote.addEventListener("click", () => {
    void handleSkip();
  });

  updatePool();
  const flushed = await state.voteService.flushPending();
  state.sentVotes += Number(flushed || 0);
  await updateQueueStatus();
  await refreshLiveStats();

  setInterval(() => {
    void refreshLiveStats();
  }, STATS_POLL_MS);

  await nextPair();
}

void init();
