import { useEffect, useState } from "react";
import { App } from "./App.tsx";
import { setApiCsrf } from "./api.ts";
import { HostedAuthContext } from "./hosted-auth.ts";
import {
  consumeCallbackError,
  loadSession,
  signOutHosted,
  startGoogleSignIn,
  type SessionState,
} from "./session.ts";

export function HostedApp() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [callbackFailed, setCallbackFailed] = useState(false);
  const [signInFailed, setSignInFailed] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  async function refresh() {
    const next = await loadSession("hosted");
    if (next.kind === "hosted-ready") setApiCsrf(next.csrfToken);
    else setApiCsrf("");
    setSession(next);
  }

  useEffect(() => {
    if (consumeCallbackError(new URL(location.href), (href) => history.replaceState(null, "", href))) {
      setCallbackFailed(true);
    }
    void refresh();
  }, []);

  useEffect(() => {
    if (session?.kind !== "hosted-ready") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const ms = Date.parse(session.session.expiresAt) - Date.now();
    const wait = Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 2_147_000_000) : 2_147_000_000;
    const timer = window.setTimeout(() => {
      void refresh();
    }, wait);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(timer);
    };
  }, [session]);

  async function onGoogle() {
    setSignInFailed(false);
    const result = await startGoogleSignIn();
    if (!result.ok) {
      setSignInFailed(true);
      return;
    }
    location.assign(result.url);
  }

  async function onSignOut() {
    setSignOutFailed(false);
    const result = await signOutHosted();
    if (!result.ok) {
      setSignOutFailed(true);
      return;
    }
    setApiCsrf("");
    setSession({ kind: "hosted-signed-out" });
  }

  if (!session) {
    return (
      <div className="shell hosted-session">
        <p className="wordmark">Locus</p>
        <p className="quiet">Checking session…</p>
      </div>
    );
  }

  if (session.kind === "load-failed") {
    return (
      <div className="shell hosted-session">
        <p className="wordmark">Locus</p>
        <p className="bad" role="alert">Could not load session.</p>
        <button type="button" className="btn primary" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  if (session.kind === "hosted-access-denied") {
    return (
      <div className="shell hosted-session">
        <p className="wordmark">Locus</p>
        <p className="bad" role="alert">Access denied.</p>
        {signOutFailed ? <p className="bad" role="alert">Could not sign out. Try again.</p> : null}
        <button type="button" className="btn" onClick={() => void onSignOut()}>
          Sign out
        </button>
      </div>
    );
  }

  if (session.kind === "hosted-signed-out") {
    const failed = callbackFailed || signInFailed;
    return (
      <div className="shell hosted-session">
        <p className="wordmark">Locus</p>
        {failed ? <p className="bad" role="alert">Google sign-in failed. Try again.</p> : null}
        <button type="button" className="btn primary" onClick={() => void onGoogle()}>
          Continue with Google
        </button>
      </div>
    );
  }

  if (session.kind !== "hosted-ready") return null;

  return (
    <HostedAuthContext.Provider
      value={{
        user: session.user,
        library: session.library,
        signOut: () => void onSignOut(),
        signOutFailed,
      }}
    >
      <App />
    </HostedAuthContext.Provider>
  );
}
