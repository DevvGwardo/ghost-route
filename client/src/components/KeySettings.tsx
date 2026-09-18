import { useState } from 'react';
import { KeyRound } from 'lucide-react';

export const TYPESAFE_KEY_STORAGE = 'ghostroute.typesafeKey';

interface KeySettingsProps {
  typesafeKey: string;
  onKeyChange: (key: string) => void;
}

export default function KeySettings({ typesafeKey, onKeyChange }: KeySettingsProps) {
  const [draft, setDraft] = useState(typesafeKey);
  const [error, setError] = useState<string | null>(null);
  const saved = typesafeKey.length > 0;

  function save() {
    const key = draft.trim();
    if (!key) {
      setError('Enter a key before saving.');
      return;
    }
    setError(null);
    onKeyChange(key);
  }

  function clear() {
    setDraft('');
    setError(null);
    onKeyChange('');
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
          type="password"
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
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
          }}
        />
        <button type="button" className="gm-key-save" aria-label="Save TypeSafe key" onClick={save}>
          Save
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
      {saved && !error && (
        <p className="gm-key-saved" role="status">
          Key saved on this device.
        </p>
      )}
      <p className="gm-key-hint" id="gr-jev-hint">
        Get a key at typesafe.ai (early access)
      </p>
    </div>
  );
}
