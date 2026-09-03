import { useEffect, useState } from "react";
import { App } from "./App.tsx";
import { api, setApiCsrf } from "./api.ts";
import { HostedAuthContext } from "./hosted-auth.ts";
import { hostedDefaultHash } from "./hosted-entry.ts";
import {
  enterExample,
  exampleGeneration,
  exitExample,
} from "./example-library.ts";
import { LandingPage } from "./LandingPage.tsx";
import {
  consumeCallbackError,
  loadSession,
  signOutHosted,
  startGoogleSignIn,
  type SessionState,
} from "./session.ts";
import { BrandLockup } from "./Brand.tsx";

export function HostedApp() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [callbackFailed, setCallbackFailed] = useState(false);
  const [signInFailed, setSignInFailed] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const [signedOutView, setSignedOutView] = useState<"landing" | "signin">("landing");
  const [entryReady, setEntryReady] = useState(false);
  const [exampleOn, setExampleOn] = useState(false);
  const [exampleGen, setExampleGen] = useState(0);

  async function refresh() {
    const next = await loadSession("hosted");
    if (next.kind === "hosted-ready") setApiCsrf(next.csrfToken);
    else setApiCsrf("");
    setSession(next);
  }

  useEffect(() => {
    if (consumeCallbackError(new URL(location.href), (href) => history.replaceState(null, "", href))) {
      setCallbackFailed(true);
      setSignedOutView("signin");
    }
    void refresh();
  }, []);

  const readyLibraryId = session?.kind === "hosted-ready" ? session.library.id : null;

  useEffect(() => {
    if (!readyLibraryId) {
      setEntryReady(false);
      return;
    }
    let alive = true;
    void (async () => {
      const raw = location.hash.replace(/^#/, "");
      let total = 1;
      if (raw === "" || raw === "/") {
        try {
          total = (await api.itemCounts()).counts.total;
        } catch {
          total = 1;
        }
      }
      const next = hostedDefaultHash(location.hash, total);
      const dest = `${location.pathname}${location.search}${next}`;
      const current = `${location.pathname}${location.search}${location.hash}`;
      if (dest !== current) history.replaceState(null, "", dest);
      if (alive) setEntryReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [readyLibraryId]);

  useEffect(() => {
    const leaveExample = (next: "landing" | "signin") => {
      exitExample();
      setExampleOn(false);
      setSignedOutView(next);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    };
    const onReset = () => setExampleGen(exampleGeneration());
    const onExit = () => leaveExample("landing");
    const onGetStarted = () => leaveExample("signin");
    window.addEventListener("locus:example-reset", onReset);
    window.addEventListener("locus:example-exit", onExit);
    window.addEventListener("locus:example-get-started", onGetStarted);
    return () => {
      window.removeEventListener("locus:example-reset", onReset);
      window.removeEventListener("locus:example-exit", onExit);
      window.removeEventListener("locus:example-get-started", onGetStarted);
    };
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
    setSignInBusy(true);
    const result = await startGoogleSignIn();
    if (!result.ok) {
      setSignInBusy(false);
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
    setSignInBusy(false);
    setSignInFailed(false);
    setCallbackFailed(false);
    setSignedOutView("landing");
    setSession({ kind: "hosted-signed-out" });
  }

  if (!session) {
    return (
      <div className="shell hosted-session">
        <BrandLockup />
        <p className="quiet">Checking session…</p>
      </div>
    );
  }

  if (session.kind === "load-failed") {
    return (
      <div className="shell hosted-session">
        <BrandLockup />
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
        <BrandLockup />
        <p className="bad" role="alert">Access denied.</p>
        {signOutFailed ? <p className="bad" role="alert">Could not sign out. Try again.</p> : null}
        <button type="button" className="btn" onClick={() => void onSignOut()}>
          Sign out
        </button>
      </div>
    );
  }

  if (session.kind === "hosted-signed-out" && exampleOn) {
    return <App key={exampleGen} />;
  }

  if (session.kind === "hosted-signed-out") {
    return (
      <LandingPage
        view={signedOutView}
        signInFailed={callbackFailed || signInFailed}
        signInBusy={signInBusy}
        onGetStarted={() => {
          setSignInFailed(false);
          setSignedOutView("signin");
        }}
        onGoogle={() => void onGoogle()}
        onBack={() => {
          setSignInFailed(false);
          setCallbackFailed(false);
          setSignedOutView("landing");
        }}
        onTryExample={(room) => {
          enterExample(room);
          setExampleGen(exampleGeneration());
          setExampleOn(true);
        }}
      />
    );
  }

  if (session.kind !== "hosted-ready") return null;

  if (!entryReady) {
    return (
      <div className="shell hosted-session">
        <BrandLockup />
        <p className="quiet">Checking session…</p>
      </div>
    );
  }

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
