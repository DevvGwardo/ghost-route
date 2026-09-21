// Voice guidance announcer for navigation: speaks maneuvers, camera alerts,
// reroute and arrival cues through the browser's speech synthesis.
//
// The logic core is DOM-free (injected SpeechBackend) so the dedupe and
// interrupt behavior is unit-testable; the browser adapter is the only part
// that touches window.speechSynthesis. Speech being blocked or unsupported
// must never break visual guidance, so every failure path is silent.

export interface SpeakableUtterance {
  text: string;
  rate: number;
}

export interface SpeechBackend {
  cancel(): void;
  speak(utterance: SpeakableUtterance): void;
}

/** Same tag inside this window is dropped — GPS fixes must not re-alert. */
const DEDUPE_MS = 10_000;
/** Slightly brisk: driving directions read slow at the default rate. */
const SPEAK_RATE = 1.05;

export interface VoiceAnnouncer {
  say(text: string, opts?: { interrupt?: boolean; tag?: string }): void;
  cancel(): void;
}

export function createVoiceAnnouncer(backend: SpeechBackend | null): VoiceAnnouncer {
  if (!backend) return { say: () => {}, cancel: () => {} };
  const lastByTag = new Map<string, number>();
  return {
    say(text, opts = {}) {
      if (!text) return;
      if (opts.tag) {
        const now = Date.now();
        const last = lastByTag.get(opts.tag) ?? 0;
        if (now - last < DEDUPE_MS) return;
        lastByTag.set(opts.tag, now);
      }
      try {
        if (opts.interrupt) backend.cancel();
        backend.speak({ text, rate: SPEAK_RATE });
      } catch {
        /* speech must never take guidance down */
      }
    },
    cancel() {
      try {
        backend.cancel();
      } catch {
        /* nothing playing */
      }
    },
  };
}

/** Real browser TTS, or null where speechSynthesis is unavailable. */
export function browserSpeechBackend(): SpeechBackend | null {
  try {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return null;
    return {
      cancel: () => synth.cancel(),
      speak: ({ text, rate }) => {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate;
        synth.speak(u);
      },
    };
  } catch {
    return null;
  }
}
