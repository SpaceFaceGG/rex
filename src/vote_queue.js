const DB_NAME = "rex_vote_queue";
const DB_VERSION = 1;
const STORE = "votes";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "vote_id" });
        store.createIndex("created_at", "created_at", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class VoteQueue {
  constructor() {
    this.dbPromise = openDb();
  }

  async enqueue(vote) {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(vote);
    await txDone(tx);
  }

  async getBatch(limit = 25) {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const index = store.index("created_at");

    return new Promise((resolve, reject) => {
      const out = [];
      const req = index.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cursor.value);
        cursor.continue();
      };

      req.onerror = () => reject(req.error);
    });
  }

  async remove(voteIds) {
    if (!voteIds || voteIds.length === 0) return;

    const db = await this.dbPromise;
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const id of voteIds) {
      store.delete(id);
    }
    await txDone(tx);
  }

  async size() {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);

    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }

  async flush(sendVote, batchSize = 25) {
    let sent = 0;

    while (true) {
      const batch = await this.getBatch(batchSize);
      if (batch.length === 0) break;

      const okIds = [];
      for (const vote of batch) {
        const ok = await sendVote(vote);
        if (!ok) {
          // Stop flush on first transient failure to avoid thrashing.
          await this.remove(okIds);
          return sent;
        }
        okIds.push(vote.vote_id);
      }

      await this.remove(okIds);
      sent += okIds.length;
    }

    return sent;
  }
}
