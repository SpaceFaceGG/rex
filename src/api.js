const WORKER_COOKIE = "rex_worker_id";
const COOKIE_DAYS = 400;

function randomId() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(name) {
  const prefix = `${name}=`;
  const parts = document.cookie.split(";").map((s) => s.trim());
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

function writeCookie(name, value, days = COOKIE_DAYS) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; Expires=${expires}; Path=/; SameSite=Lax`;
}

export function getOrCreateWorkerId() {
  const fromCookie = readCookie(WORKER_COOKIE);
  if (fromCookie) return fromCookie;

  const created = randomId();
  writeCookie(WORKER_COOKIE, created);
  return created;
}

export function createVote({ leftId, rightId, winnerId, responseMs, siteVersion = "1.0.0" }) {
  if (!leftId || !rightId || !winnerId) {
    throw new Error("leftId/rightId/winnerId are required");
  }
  if (leftId === rightId) {
    throw new Error("leftId and rightId must differ");
  }
  if (winnerId !== leftId && winnerId !== rightId) {
    throw new Error("winnerId must match one of the shown characters");
  }

  const voteId = randomId();
  const workerId = getOrCreateWorkerId();
  return {
    vote_id: voteId,
    worker_id: workerId,
    left_id: leftId,
    right_id: rightId,
    winner_id: winnerId,
    loser_id: winnerId === leftId ? rightId : leftId,
    shown_order: [leftId, rightId],
    response_ms: Number.isFinite(responseMs) ? Math.max(0, Math.round(responseMs)) : 0,
    client_ts: new Date().toISOString(),
    site_version: siteVersion,
  };
}

export async function submitVote(vote, { apiBase, signal } = {}) {
  if (!apiBase) {
    throw new Error("apiBase is required (e.g. https://your-worker.workers.dev)");
  }

  const res = await fetch(`${apiBase.replace(/\/$/, "")}/vote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(vote),
    signal,
  });

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { ok: true, status: res.status, data };
}

export async function submitQueuedVote(vote, apiBase) {
  const result = await submitVote(vote, { apiBase });
  return result.ok;
}
