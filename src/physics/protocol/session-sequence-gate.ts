import { sessionIdSchema } from './schemas';

export interface SequencedSessionMessage {
  readonly sequence: number;
  readonly sessionId: string;
}

export type SessionSequenceRejectionReason = 'sessionMismatch' | 'nonIncreasingSequence';

export type SessionSequenceDecision =
  | {
      readonly accepted: true;
      readonly lastAcceptedSequence: number;
      readonly sessionId: string;
    }
  | {
      readonly accepted: false;
      readonly lastAcceptedSequence: number | null;
      readonly reason: SessionSequenceRejectionReason;
      readonly sessionId: string;
    };

export class SessionSequenceGate {
  #currentSessionId: string;
  #lastAcceptedSequence: number | null = null;
  readonly #retiredSessionIds = new Set<string>();

  constructor(sessionId: string) {
    this.#currentSessionId = sessionIdSchema.parse(sessionId);
  }

  get currentSessionId(): string {
    return this.#currentSessionId;
  }

  get lastAcceptedSequence(): number | null {
    return this.#lastAcceptedSequence;
  }

  accept(message: SequencedSessionMessage): SessionSequenceDecision {
    if (message.sessionId !== this.#currentSessionId) {
      return {
        accepted: false,
        lastAcceptedSequence: this.#lastAcceptedSequence,
        reason: 'sessionMismatch',
        sessionId: this.#currentSessionId,
      };
    }

    if (this.#lastAcceptedSequence !== null && message.sequence <= this.#lastAcceptedSequence) {
      return {
        accepted: false,
        lastAcceptedSequence: this.#lastAcceptedSequence,
        reason: 'nonIncreasingSequence',
        sessionId: this.#currentSessionId,
      };
    }

    this.#lastAcceptedSequence = message.sequence;
    return {
      accepted: true,
      lastAcceptedSequence: message.sequence,
      sessionId: this.#currentSessionId,
    };
  }

  resetForWorkerRestart(nextSessionId: string): void {
    const parsedSessionId = sessionIdSchema.parse(nextSessionId);
    if (
      parsedSessionId === this.#currentSessionId ||
      this.#retiredSessionIds.has(parsedSessionId)
    ) {
      throw new Error('Worker 重启必须使用从未使用过的 sessionId');
    }

    this.#retiredSessionIds.add(this.#currentSessionId);
    this.#currentSessionId = parsedSessionId;
    this.#lastAcceptedSequence = null;
  }
}
