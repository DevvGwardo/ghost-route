// Request supersession ("last intent wins"). Pure + DOM-free so it is unit
// testable in the node test environment (see tests/request-guard.test.ts).
//
// Every request takes a ticket from begin(). begin() also aborts the previous
// ticket, so a superseded request stops streaming. Callers gate EVERY state
// write on isCurrent(ticket): abort is best-effort (a response can already be
// in flight when abort lands), so the sequence check is the real guarantee
// that a slow older response never overwrites a newer one.

export interface RequestTicket {
  readonly seq: number;
  readonly signal: AbortSignal;
}

export interface RequestGuard {
  /** Start a new request, cancelling any previous one. */
  begin(): RequestTicket;
  /** True while `ticket` is still the newest request. */
  isCurrent(ticket: RequestTicket): boolean;
  /**
   * Invalidate the in-flight request WITHOUT starting a replacement, so a
   * response already on the wire can never apply. Use this when the input the
   * request was built from changed but the replacement is still debounced —
   * otherwise the stale response would land in that gap.
   */
  invalidate(): void;
  /** Cancel the in-flight request without invalidating its ticket. */
  abort(): void;
  /** Sequence number of the newest request (0 before any). */
  readonly seq: number;
}

export function createRequestGuard(): RequestGuard {
  let current = 0;
  let ctrl: AbortController | null = null;
  return {
    begin(): RequestTicket {
      current += 1;
      ctrl?.abort();
      ctrl = new AbortController();
      return { seq: current, signal: ctrl.signal };
    },
    isCurrent(ticket: RequestTicket): boolean {
      return ticket.seq === current;
    },
    invalidate(): void {
      current += 1;
      ctrl?.abort();
      ctrl = null;
    },
    abort(): void {
      ctrl?.abort();
    },
    get seq(): number {
      return current;
    },
  };
}
