import { isExampleActive, resetExample } from "./example-library.ts";

export function ExampleBanner() {
  if (!isExampleActive()) return null;
  return (
    <div className="example-bar" data-example-banner>
      <span>
        <b>Example library</b> · not your captures
      </span>
      <span className="example-bar-actions">
        <button
          type="button"
          className="btn"
          data-act="signin"
          onClick={() => window.dispatchEvent(new Event("locus:example-get-started"))}
        >
          Get started
        </button>
        <button type="button" className="btn ghost" data-act="example-reset" onClick={() => resetExample()}>
          Reset example
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="example-back"
          onClick={() => window.dispatchEvent(new Event("locus:example-exit"))}
        >
          Back to landing
        </button>
      </span>
    </div>
  );
}

export function ExampleAccountPage() {
  return (
    <section className="stack">
      <div className="pagehead">
        <h1>Account</h1>
      </div>
      <p className="pagesub">
        This example is not paired with your Chrome. Sign in to create your own Library, then connect a Source.
      </p>
      <button
        type="button"
        className="btn primary"
        data-act="signin"
        onClick={() => window.dispatchEvent(new Event("locus:example-get-started"))}
      >
        Get started with your own
      </button>
    </section>
  );
}
