// Voice guidance announcer (dedupe + interrupt logic, DOM-free core).
// The backend is injected, so behavior is exercised without a browser.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createVoiceAnnouncer,
  type SpeechBackend,
} from '../client/src/lib/voice';

function fakeBackend() {
  const spoken: string[] = [];
  let cancels = 0;
  const backend: SpeechBackend = {
    speak: (u) => {
      spoken.push(u.text);
    },
    cancel: () => {
      cancels += 1;
    },
  };
  return { backend, spoken, cancelCount: () => cancels };
}

describe('createVoiceAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('null backend → no-op say/cancel that never throw', () => {
    const a = createVoiceAnnouncer(null);
    expect(() => {
      a.say('In 400 m, turn left');
      a.cancel();
    }).not.toThrow();
  });

  it('speaks the given text', () => {
    const { backend, spoken } = fakeBackend();
    const a = createVoiceAnnouncer(backend);
    a.say('Camera ahead in 500 m');
    expect(spoken).toEqual(['Camera ahead in 500 m']);
  });

  it('same tag inside the dedupe window is dropped, after it speaks again', () => {
    const { backend, spoken } = fakeBackend();
    const a = createVoiceAnnouncer(backend);
    const t0 = Date.now();
    a.say('Camera ahead in 500 m', { tag: 'cam-x' });
    a.say('Camera ahead in 480 m', { tag: 'cam-x' });
    expect(spoken).toHaveLength(1);
    vi.setSystemTime(t0 + 10_001);
    a.say('Camera ahead in 200 m', { tag: 'cam-x' });
    expect(spoken).toHaveLength(2);
  });

  it('different tags never dedupe each other', () => {
    const { backend, spoken } = fakeBackend();
    const a = createVoiceAnnouncer(backend);
    a.say('In 400 m, turn left', { tag: 'step' });
    a.say('Camera ahead in 300 m', { tag: 'cam-y' });
    expect(spoken).toHaveLength(2);
  });

  it('untagged text always speaks (interrupts rely on explicit cancel)', () => {
    const { backend, spoken } = fakeBackend();
    const a = createVoiceAnnouncer(backend);
    a.say('You have arrived');
    a.say('You have arrived');
    expect(spoken).toHaveLength(2);
  });

  it('interrupt cancels current speech before speaking', () => {
    const { backend, spoken, cancelCount } = fakeBackend();
    const a = createVoiceAnnouncer(backend);
    a.say('In 400 m, turn left');
    a.say('Rerouting', { interrupt: true });
    expect(spoken).toEqual(['In 400 m, turn left', 'Rerouting']);
    expect(cancelCount()).toBe(1);
  });

  it('empty text is dropped', () => {
    const { backend, spoken } = fakeBackend();
    const a = createVoiceAnnouncer(backend);
    a.say('');
    expect(spoken).toHaveLength(0);
  });

  it('a throwing backend never takes the caller down', () => {
    const hostile: SpeechBackend = {
      speak: () => {
        throw new Error('tts blocked');
      },
      cancel: () => {
        throw new Error('tts blocked');
      },
    };
    const a = createVoiceAnnouncer(hostile);
    expect(() => {
      a.say('In 400 m, turn left');
      a.say('Rerouting', { interrupt: true });
      a.cancel();
    }).not.toThrow();
  });
});
