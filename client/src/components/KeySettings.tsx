import { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { ApiError, verifySystemKey } from '../lib/api';
import { verifyMessage } from '../lib/verifyMessage';

export const TYPESAFE_KEY_STORAGE = 'ghostroute.typesafeKey';

export type KeyValid = boolean | null;

interface KeySettingsProps {
  typesafeKey: string;
  onKeyChange: (key: string) => void;
  keyValid: KeyValid;
  onKeyValidChange: (v: KeyValid) => void;
}

export default function KeySettings({ typesafeKey, onKeyChange, keyValid, onKeyValidChange }: KeySettingsProps) {
  const [draft, setDraft] = useState(typesafeKey);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const saved = typesafeKey.length > 0;

  // Keep draft in sync when key changes externally (clear, storage restore).
  useEffect(() => {
    setDraft(typesafeKey);
  }, [typesafeKey]);

  function save() {
    const key = draft.trim();
    if (!key) {
      setError('Enter a key before saving.');
      return;
    }
    setError(null);
    onKeyValidChange(null);
    onKeyChange(key);
  }

  function clear() {
    setDraft('');
    setError(null);
    onKeyValidChange(null);
    onKeyChange('');
  }

  async function test() {
    const key = (saved ? typesafeKey : draft).trim();
    if (!key) {
      setError('Paste a key first, then Test.');
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const out = await verifySystemKey(key);
      if (out.valid) {
        onKeyValidChange(true);
        // Persist the working key so Find uses it.
        if (key !== typesafeKey) onKeyChange(key);
      } else {
        onKeyValidChange(false);
        setError(verifyMessage(out));
      }
    } catch (err) {
      onKeyValidChange(false);
      // This catch is about the Ghost Route server, not TypeSafe — say so
      // precisely. A 429 here is our own limiter, which is not "unreachable".
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many key checks right now. Wait a minute, then Test again.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError('Paste a key first, then Test.');
      } else {
        setError('Could not reach the Ghost Route server. Is it running?');
      }
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="gm-key">
      <label className="gm-key-label" htmlFor="gr-jev-key">
        <KeyRound size={16} aria-hidden="true" />
        TypeSafe JEV key
      </label>
      <div className="gm-key-row">
        <input
          id="gr-jev-key"
          type={showKey ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste your key"
          aria-label="TypeSafe JEV key"
          aria-describedby="gr-jev-hint"
          aria-invalid={error ? true : undefined}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
            if (keyValid !== null) onKeyValidChange(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
          }}
        />
        <button
          type="button"
          className="gm-key-clear"
          aria-label={showKey ? 'Hide key' : 'Show key'}
          aria-pressed={showKey}
          title={showKey ? 'Hide key' : 'Show key'}
          onClick={() => setShowKey((v) => !v)}
        >
          {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        <button type="button" className="gm-key-save" aria-label="Save TypeSafe key" onClick={save}>
          Save
        </button>
        <button
          type="button"
          className="gm-key-save"
          aria-label="Test TypeSafe key"
          onClick={test}
          disabled={verifying}
        >
          {verifying ? 'Testing…' : 'Test'}
        </button>
        {saved && (
          <button
            type="button"
            className="gm-key-clear"
            aria-label="Clear saved TypeSafe key"
            onClick={clear}
          >
            Clear
          </button>
        )}
      </div>
      {error && (
        <p className="gm-key-error" role="alert">
          {error}
        </p>
      )}
      {saved && !error && keyValid === true && (
        <p className="gm-key-saved" role="status">
          Key verified — JEV live ranking on.
        </p>
      )}
      {saved && !error && keyValid === false && (
        <p className="gm-key-error" role="status">
          Key saved but not verified — routes use heuristic fallback.
        </p>
      )}
      {saved && !error && keyValid === null && (
        <p className="gm-key-saved" role="status">
          Key saved on this device. Hit Test to verify.
        </p>
      )}
      <p className="gm-key-hint" id="gr-jev-hint">
        Get a key at typesafe.ai (early access). Without a key, clean-route search still works via heuristic.
      </p>
    </div>
  );
}
