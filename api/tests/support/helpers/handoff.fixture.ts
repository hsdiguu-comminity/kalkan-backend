import { createHandoffService, type SupportActor, type SupportOutboxEvent,
  type SupportSession, type SupportStore, type SupportTransaction,
} from "../../../src/modules/support/handoff.service.js";

/**
 * TR: Yalnızca test: rollback ve seri transaction davranışı. Üretim deposu değildir.
 * EN: Test-only rollback and serialized transactions. Never use this store in production.
 */
export class TestSupportStore implements SupportStore {
  private sessions = new Map<string, SupportSession>();
  private events = new Map<string, SupportOutboxEvent>();
  private offers = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  failNextOutbox = false;
  offline = false;

  offer(sessionId: string, agentId: string): void {
    this.offers.add(`${sessionId}:${agentId}`);
  }
  removeOffer(sessionId: string, agentId: string): void {
    this.offers.delete(`${sessionId}:${agentId}`);
  }
  snapshot() {
    return structuredClone({ sessions: [...this.sessions.values()], events: [...this.events.values()] });
  }
  async transaction<T>(work: (tx: SupportTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.offline) throw new Error("private-database-connection-string");
      const sessions = structuredClone(this.sessions);
      const events = structuredClone(this.events);
      const result = await work({
        findByConversationId: async (id) => structuredClone(
          [...sessions.values()].find((session) => session.conversationId === id) ?? null,
        ),
        findById: async (id) => structuredClone(sessions.get(id) ?? null),
        hasAgentOffer: async (id, agentId) => this.offers.has(`${id}:${agentId}`),
        saveSession: async (session) => {
          if ([...sessions.values()].some((existing) =>
            existing.conversationId === session.conversationId && existing.id !== session.id)) {
            throw new Error("unique conversationId");
          }
          sessions.set(session.id, structuredClone(session));
        },
        appendOutbox: async (event) => {
          if (this.failNextOutbox) {
            this.failNextOutbox = false;
            throw new Error("private-outbox-failure");
          }
          if (events.has(event.id)) throw new Error("unique outbox.id");
          events.set(event.id, structuredClone(event));
        },
      });
      this.sessions = sessions;
      this.events = events;
      return result;
    } finally {
      release();
    }
  }
}

export function makeHandoffFixture() {
  let time = Date.now();
  const user: SupportActor = { userId: "user_1", role: "user", expiresAt: time + 60_000 };
  const expert: SupportActor = { userId: "expert_1", role: "expert", expiresAt: user.expiresAt };
  const expert2: SupportActor = { ...expert, userId: "expert_2" };
  const otherUser: SupportActor = { ...user, userId: "user_2" };
  const admin: SupportActor = { ...user, userId: "admin_1", role: "admin" };
  const owners = new Map([["chat_1", user.userId], ["chat_2", otherUser.userId]]);
  const store = new TestSupportStore();
  const conversations = { getOwnerId: async (id: string) => owners.get(id) ?? null };
  const service = createHandoffService({ store, conversations, now: () => new Date(time) });
  return { service, store, user, expert, expert2, otherUser, admin, owners, conversations,
    advanceTime: (ms: number) => { time += ms; } };
}
