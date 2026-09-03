import { useEffect, useRef } from "react";
import { BrandLockup } from "./Brand.tsx";

export type LandingRoom = "kitchen" | "reading" | "atlas" | "trips";

export type LandingPageProps = {
  view: "landing" | "signin";
  signInFailed?: boolean;
  signInBusy?: boolean;
  onGetStarted: () => void;
  onGoogle: () => void;
  onBack: () => void;
  onTryExample?: (room?: LandingRoom) => void;
};

const LIFE: { room: LandingRoom; kicker: string; title: string; body: string }[] = [
  {
    room: "kitchen",
    kicker: "Kitchen",
    title: "Tonight is empty.",
    body: "Four food saves wait in the Recipe Box. An agent can add to Tonight. Only you cook.",
  },
  {
    room: "reading",
    kicker: "Reading",
    title: "Three unread.",
    body: "Essays saved from X. The agent can recommend. It cannot mark them finished for you.",
  },
  {
    room: "atlas",
    kicker: "Atlas",
    title: "Home is London.",
    body: "Lisbon and Sintra already placed. One courtyard cafe still needs a Place.",
  },
  {
    room: "trips",
    kicker: "Trips",
    title: "Lisbon, Friday dinner is a hole.",
    body: "A Trip Document with days, stops, and one need still open. Three options — you choose.",
  },
];

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.3-.2-1.9H9v3.6h4.8A4.1 4.1 0 0 1 12 13.2v2.3h2.7c1.6-1.5 2.9-3.7 2.9-6.3z" />
      <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.7-2.3c-.8.5-1.8.9-3.3.9-2.5 0-4.6-1.7-5.4-4H.8v2.3A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.6 10.4A5.4 5.4 0 0 1 3.3 9c0-.5.1-1 .3-1.4V5.3H.8A9 9 0 0 0 0 9c0 1.5.4 2.8.8 3.7l2.8-2.3z" />
      <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3L14.7 3C13.5 1.8 11.4.9 9 .9A9 9 0 0 0 .8 5.3l2.8 2.3C4.4 5.3 6.5 3.6 9 3.6z" />
    </svg>
  );
}

function Mast({ lede }: { lede: string }) {
  return (
    <header className="masthead">
      <div>
        <BrandLockup />
        <p className="lede">{lede}</p>
      </div>
      <div className="mast-right">
        <div className="datebox">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 8l1.8 4L12 16l-1.8-4z" />
          </svg>
          <span>{todayLabel()}</span>
        </div>
      </div>
    </header>
  );
}

export function LandingPage({
  view,
  signInFailed = false,
  signInBusy = false,
  onGetStarted,
  onGoogle,
  onBack,
  onTryExample,
}: LandingPageProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    headingRef.current?.focus({ preventScroll: reduce });
  }, [view]);

  if (view === "signin") {
    return (
      <div className="shell landing" data-page="signin">
        <a className="visually-hidden" href="#landing-main">Skip to content</a>
        <Mast lede="One Library per Google account" />
        <main id="landing-main" className="landing-signin">
          <h1 ref={headingRef} tabIndex={-1}>Sign in to open your desk</h1>
          <p className="body">
            Continue with Google. The first time, that creates your account and one private Library. Next time you
            return to the same Library. Google is identity only — Locus does not keep Google tokens.
          </p>
          {signInFailed ? <p className="bad" role="alert">Google sign-in failed. Try again.</p> : null}
          <button type="button" className="btn primary landing-google" data-act="google" disabled={signInBusy} onClick={onGoogle}>
            <GoogleMark />
            {signInBusy ? "Opening your Library…" : "Continue with Google"}
          </button>
          {signInBusy ? (
            <p className="landing-status" role="status">
              Creating your account if this is the first sign-in, then opening Account.
            </p>
          ) : null}
          <div className="landing-actions">
            <button
              type="button"
              className="btn ghost"
              data-act="example"
              disabled={signInBusy}
              onClick={() => onTryExample?.()}
            >
              Try the example library
            </button>
            <button type="button" className="btn ghost" data-act="landing" disabled={signInBusy} onClick={onBack}>
              Back
            </button>
          </div>
          <p className="note">No separate signup form. Sign-in is account creation.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="shell landing" data-page="landing">
      <a className="visually-hidden" href="#landing-main">Skip to content</a>
      <Mast lede="Your saves, in one place." />
      <main id="landing-main">
        <div className="landing-hero">
          <div className="landing-hero-copy">
            <h1 ref={headingRef} className="landing-enter" tabIndex={-1}>
              The desk for the life you already saved.
            </h1>
            <p className="body landing-enter">
              Bookmarks, Saved, Watch Later — captured into one private Library. The same Items become dinner, a
              reading pile, a map of places, and a trip with a hole still in it.
            </p>
            <div className="landing-actions landing-enter">
              <button type="button" className="btn primary" data-act="example" onClick={() => onTryExample?.()}>
                Try the example library
              </button>
              <button type="button" className="btn ghost" data-act="signin" onClick={onGetStarted}>
                Get started
              </button>
            </div>
            <p className="note landing-enter">
              Capture, not sync. One Library. Your browser agent only receives help for the tab that is open.
            </p>
          </div>
          <aside className="landing-explainer landing-enter">
            <span className="landing-mark" aria-hidden="true">✦</span>
            <div>
              <h2>Agent-friendly means page-scoped.</h2>
              <p>
                There is no separate agent workspace. While Kitchen is open, the agent can search the Recipe Box and
                change Tonight. While a trip is open, it can offer three options for a hole — and cannot pick for you.
                Close the tab, that help goes with it.
              </p>
              <ul className="landing-tool-map">
                <li>Desk — search and file; you confirm</li>
                <li>Kitchen — tonight and draft recipes; you keep them</li>
                <li>Reading — recommend from your pile; you choose</li>
                <li>Trips — three options for a hole; you choose</li>
                <li>Atlas — you assign places</li>
              </ul>
            </div>
          </aside>
        </div>
        <div className="landing-life" aria-label="A day on the desk">
          {LIFE.map((col) => (
            <button
              key={col.room}
              type="button"
              data-act="example"
              data-room={col.room}
              onClick={() => onTryExample?.(col.room)}
            >
              <small>{col.kicker}</small>
              <h2>{col.title}</h2>
              <p>{col.body}</p>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
