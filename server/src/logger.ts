// One-line JSON events on stdout — greppable and cheap to ship. Callers
// MUST NOT pass origin/destination, keys, bodies, or headers into this
// module (privacy posture: nothing per-user is logged server-side).
//
// GHOST_LOG=off silences events entirely (useful in test output); the
// startup banner via console.log is unaffected.

const enabled = process.env.GHOST_LOG !== "off";

export function logEvent(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!enabled) return;
  try {
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n",
    );
  } catch {
    /* logging must never take the request down */
  }
}
