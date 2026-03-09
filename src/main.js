import { buildExposureMap, chooseNextPair, rememberPair } from "./pair_selector.js";
import { VoteService } from "./vote_service.js";

const els = {
  includePPlus: document.getElementById("include-pplus"),
  poolInfo: document.getElementById("pool-info"),
  status: document.getElementById("status"),
  queueStatus: document.getElementById("queue-status"),
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
  pPlusIds: new Set(),
  activeCharacters: [],
  localVotes: [],
  seenPairs: new Set(),
  currentPair: null,
  pairShownAt: performance.now(),
  skipped: 0,
  sentVotes: 0,
  queuedVotes: 0,
  voteService: null,
};

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

async function updateQueueStatus() {
  state.queuedVotes = await state.voteService.pendingCount();
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

function nextPair() {
  const chars = state.activeCharacters;
  if (chars.length < 2) {
    setPair(null);
    return;
  }

  const exposure = buildExposureMap(state.localVotes, chars.map((c) => c.id));
  const pair = chooseNextPair({
    characters: chars,
    scoresById: {},
    exposureById: exposure,
    seenPairs: state.seenPairs,
    coverageTarget: 20,
  }) || randomPair(chars);

  if (!pair) {
    state.seenPairs.clear();
    setPair(randomPair(chars));
    return;
  }

  setPair(pair);
}

async function handleVote(winnerSide) {
  if (!state.currentPair) return;
  const [left, right] = state.currentPair;
  const winnerId = winnerSide === "left" ? left.id : right.id;

  const responseMs = performance.now() - state.pairShownAt;
  rememberPair(state.seenPairs, left.id, right.id);

  const localVote = {
    left_id: left.id,
    right_id: right.id,
    winner_id: winnerId,
  };
  state.localVotes.push(localVote);

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
    updateStatus("Vote queued (offline/API unavailable). It will retry automatically.");
  }

  await state.voteService.flushPending();
  await updateQueueStatus();
  nextPair();
}

async function handleSkip() {
  state.skipped += 1;
  updateStatus("Skipped. Next matchup loaded.");
  await updateQueueStatus();
  nextPair();
}

async function init() {
  const [characters, pollConfig, pPlusRaw] = await Promise.all([
    fetchJson("data/characters.json", []),
    fetchJson("data/poll_config.json", {}),
    fetchJson("data/p_plus_ids.json", []),
  ]);

  state.allCharacters = characters;
  state.pPlusIds = extractPPlusSet(pPlusRaw);

  const apiBaseRaw = pollConfig.api_base || "";
  const apiBase = apiBaseRaw.includes("REPLACE_ME") ? "" : apiBaseRaw;

  state.voteService = new VoteService(apiBase, pollConfig.site_version || "1.0.0");

  els.includePPlus.addEventListener("change", () => {
    state.seenPairs.clear();
    updatePool();
    nextPair();
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
  await state.voteService.flushPending();
  await updateQueueStatus();
  nextPair();
}

void init();
