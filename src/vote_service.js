import { createVote, submitVote, submitQueuedVote } from "./api.js";
import { VoteQueue } from "./vote_queue.js";

export class VoteService {
  constructor(apiBase, siteVersion = "1.0.0") {
    this.apiBase = apiBase;
    this.siteVersion = siteVersion;
    this.queue = new VoteQueue();
  }

  async recordVote({ leftId, rightId, winnerId, responseMs }) {
    const vote = createVote({
      leftId,
      rightId,
      winnerId,
      responseMs,
      siteVersion: this.siteVersion,
    });

    if (!this.apiBase) {
      await this.queue.enqueue(vote);
      return { saved: true, sent: false, vote, reason: "missing_api_base" };
    }

    try {
      const res = await submitVote(vote, { apiBase: this.apiBase });
      if (res.ok) {
        return { saved: true, sent: true, vote, response: res };
      }
      await this.queue.enqueue(vote);
      return { saved: true, sent: false, vote, response: res };
    } catch (error) {
      await this.queue.enqueue(vote);
      return { saved: true, sent: false, vote, error: String(error) };
    }
  }

  async flushPending(batchSize = 25) {
    if (!this.apiBase) return 0;
    return this.queue.flush((vote) => submitQueuedVote(vote, this.apiBase), batchSize);
  }

  async pendingCount() {
    return this.queue.size();
  }
}
