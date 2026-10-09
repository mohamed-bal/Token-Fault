import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { ErrorBanner } from './ui';

/**
 * Exchanges the control token for an HttpOnly session cookie. The token is kept only in this
 * component's state while typing; it is never stored in the browser.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(token.trim());
      setToken('');
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center p-6">
      <form
        onSubmit={(e) => void submit(e)}
        className="panel w-full max-w-md space-y-4 p-6"
        aria-labelledby="signin-title"
      >
        <div>
          <h1 id="signin-title" className="text-[15px] font-semibold">
            Sign in to TokenFault Studio
          </h1>
          <p className="mt-1 text-[12px] text-muted">
            Paste the <span className="font-mono text-fg">control token</span> printed by{' '}
            <code className="font-mono">tokenfault proxy</code> in your terminal. It protects
            captured responses from other local processes. The Studio keeps only an HttpOnly session
            cookie, never the token.
          </p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="label">Control token</span>
          <input
            className="input font-mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
            data-testid="control-token"
          />
        </label>
        <ErrorBanner error={error} />
        <button
          type="submit"
          className="btn btn-primary w-full justify-center"
          disabled={busy || token.trim() === ''}
          data-testid="sign-in"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
