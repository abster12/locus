import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type IntakeContext, type PresentedIntakeDraft } from "./api.ts";
import { shelfOfTag } from "../../core/categories.ts";

const MAX_TAGS = 12;
const MAX_COLLECTIONS = 5;

export function IntakeDraftsSheet({
  drafts,
  context: presentedContext,
  onClose,
  onSaved,
}: {
  drafts: PresentedIntakeDraft[];
  context: IntakeContext;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const [active, setActive] = useState(0);
  const [context, setContext] = useState(presentedContext);
  const [selected, setSelected] = useState(() => drafts.map(() => true));
  const [tagIds, setTagIds] = useState(() => drafts.map(existingTagIds));
  const [collectionIds, setCollectionIds] = useState(() =>
    drafts.map((draft) => draft.collections.map((collection) => collection.id)),
  );
  const [proposed, setProposed] = useState(() =>
    drafts.map((draft) => draft.tags.filter((tag) => tag.proposed).map((tag) => tag.name)),
  );
  const [ghosts, setGhosts] = useState<{ tags: IntakeContext["tags"]; collections: IntakeContext["collections"] }>({
    tags: [],
    collections: [],
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState(
    `${drafts.length} proposed item${drafts.length === 1 ? "" : "s"} from your browser agent. Not saved.`,
  );

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    const focusFrame = window.requestAnimationFrame(() => dismiss.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (el.open) el.close();
      previouslyFocused?.focus();
    };
  }, []);

  const chosen = selected.reduce((count, on) => count + (on ? 1 : 0), 0);
  const blocked = selected.some(
    (on, index) =>
      on
      && (hasMissing(tagIds[index] ?? [], context.tags) || hasMissing(collectionIds[index] ?? [], context.collections)),
  );

  function onListKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const last = drafts.length - 1;
    const next =
      event.key === "ArrowDown" ? Math.min(last, active + 1)
      : event.key === "ArrowUp" ? Math.max(0, active - 1)
      : event.key === "Home" ? 0
      : last;
    setActive(next);
    const item = event.currentTarget.querySelectorAll<HTMLElement>("[data-draft]")[next];
    item?.focus();
  }

  function toggleId(list: string[], id: string, max: number): string[] {
    if (list.includes(id)) return list.filter((value) => value !== id);
    if (list.length >= max) return list;
    return [...list, id];
  }

  async function confirmTag(name: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await api.createIntakeTag(name);
      const needle = name.toLowerCase();
      setContext(result.context);
      setProposed((current) => current.map((list) => list.filter((entry) => entry.toLowerCase() !== needle)));
      setTagIds((current) =>
        current.map((ids, index) => {
          if (!proposed[index]?.some((entry) => entry.toLowerCase() === needle)) return ids;
          if (ids.includes(result.tag.id) || ids.length >= MAX_TAGS) return ids;
          return [...ids, result.tag.id];
        }),
      );
      setStatus(`Created tag ${result.tag.name}.`);
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy || chosen === 0 || blocked) return;
    setBusy(true);
    setErr(null);
    try {
      await api.saveReviewedDrafts({
        clientMutationId: crypto.randomUUID(),
        contextVersion: context.version,
        drafts: drafts.flatMap((draft, index) => {
          if (!selected[index]) return [];
          const item = draft.item;
          return [{
            url: item.url,
            ...(item.title ? { title: item.title } : {}),
            ...(item.body ? { body: item.body } : {}),
            ...(item.authorName ? { authorName: item.authorName } : {}),
            ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
            ...(item.media.length ? { media: item.media } : {}),
            ...(tagIds[index]?.length ? { tagIds: tagIds[index] } : {}),
            ...(collectionIds[index]?.length ? { collectionIds: collectionIds[index] } : {}),
          }];
        }),
      });
      onSaved();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("stale context")) {
        try {
          const next = await api.intakeContext();
          const selectedTagIds = new Set(tagIds.flat());
          const selectedCollectionIds = new Set(collectionIds.flat());
          setGhosts((current) => ({
            tags: leftovers([...context.tags, ...current.tags], next.tags, selectedTagIds),
            collections: leftovers(
              [...context.collections, ...current.collections],
              next.collections,
              selectedCollectionIds,
            ),
          }));
          setContext(next);
          setErr("Tags or Collections changed. Remove or replace unavailable ones, then save.");
          setStatus("Tags or Collections changed. Remove or replace unavailable ones, then save.");
        } catch (refreshError: unknown) {
          setErr(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
      } else {
        setErr(message);
      }
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="intake-drafts"
      aria-labelledby="intake-drafts-title"
      aria-describedby="intake-drafts-sub"
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="intake-drafts-head">
        <div>
          <p className="intake-drafts-kicker">Browser agent</p>
          <h2 id="intake-drafts-title">Proposed items</h2>
        </div>
        <button
          ref={dismiss}
          type="button"
          className="intake-drafts-dismiss"
          aria-label="Dismiss proposed items"
          disabled={busy}
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <p id="intake-drafts-sub" className="intake-drafts-sub">
        {drafts.length} proposal{drafts.length === 1 ? "" : "s"} · {chosen} selected · source fields stay as presented.
        Dismiss to leave Items unchanged.
      </p>
      <p className="visually-hidden" aria-live="polite">
        {status}
      </p>
      {err ? (
        <p className="bad" role="alert" id="intake-drafts-error">
          {err}
        </p>
      ) : null}
      <ul className="intake-draft-list" onKeyDown={onListKeyDown}>
        {drafts.map((draft, index) => {
          const collections = withGhosts(context.collections, ghosts.collections, collectionIds[index] ?? []);
          const tags = withGhosts(context.tags, ghosts.tags, tagIds[index] ?? []);
          return (
          <li key={`${draft.item.url}:${index}`}>
            <article
              data-draft
              className="intake-draft"
              tabIndex={index === active ? 0 : -1}
              aria-labelledby={`intake-draft-${index}-title`}
              onFocus={() => setActive(index)}
            >
              <label className="save-choice">
                <input
                  type="checkbox"
                  name="includeDraft"
                  checked={selected[index] ?? false}
                  onChange={() => setSelected((current) => current.map((on, i) => (i === index ? !on : on)))}
                />
                <span>Include</span>
              </label>
              <h3 id={`intake-draft-${index}-title`}>{draft.item.title || draft.item.url}</h3>
              <dl>
                <dt>URL</dt>
                <dd>
                  <a href={draft.item.url} target="_blank" rel="noopener noreferrer">
                    {draft.item.url}
                  </a>
                </dd>
                <Field label="Title" value={draft.item.title} missing={draft.missing.includes("title")} />
                <Field label="Source text" value={draft.item.body} missing={draft.missing.includes("source text")} />
                <Field label="Author" value={draft.item.authorName} missing={draft.missing.includes("author")} />
                <Field
                  label="Publication date"
                  value={draft.item.publishedAt}
                  missing={draft.missing.includes("publication date")}
                />
                <Field
                  label="Media"
                  value={draft.item.media.length ? draft.item.media.map((entry) => entry.url).join(", ") : null}
                  missing={draft.missing.includes("media")}
                />
                <dt>Notes</dt>
                <dd>
                  <Notes draft={draft} />
                </dd>
              </dl>
              <fieldset className="save-org">
                <legend>Collections</legend>
                <p className="trip-hint">Destination. Source details stay as presented.</p>
                {collections.length === 0 ? (
                  <p className="trip-hint">No Collections yet.</p>
                ) : (
                  <div className="save-choices" role="group">
                    {collections.map((collection) => {
                      const unavailable = !context.collections.some((entry) => entry.id === collection.id);
                      return (
                      <label className="save-choice" key={collection.id}>
                        <input
                          type="checkbox"
                          name="collectionIds"
                          value={collection.id}
                          checked={collectionIds[index]?.includes(collection.id) ?? false}
                          disabled={
                            !collectionIds[index]?.includes(collection.id)
                            && (collectionIds[index]?.length ?? 0) >= MAX_COLLECTIONS
                          }
                          onChange={() =>
                            setCollectionIds((current) =>
                              current.map((ids, i) => (i === index ? toggleId(ids, collection.id, MAX_COLLECTIONS) : ids)),
                            )
                          }
                        />
                        <span>
                          {collection.name}
                          {unavailable ? (
                            <span className="save-consequence">No longer available</span>
                          ) : collection.description ? (
                            <span className="save-consequence">{collection.description}</span>
                          ) : null}
                        </span>
                      </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
              <fieldset className="save-org">
                <legend>Tags</legend>
                <p className="trip-hint">Classification. Source details stay as presented.</p>
                {tags.length === 0 && (proposed[index]?.length ?? 0) === 0 ? (
                  <p className="trip-hint">No tags yet.</p>
                ) : (
                  <div className="save-choices" role="group">
                    {tags.map((tag) => {
                      const unavailable = !context.tags.some((entry) => entry.id === tag.id);
                      return (
                      <label className="save-choice" key={tag.id}>
                        <input
                          type="checkbox"
                          name="tagIds"
                          value={tag.id}
                          checked={tagIds[index]?.includes(tag.id) ?? false}
                          disabled={!tagIds[index]?.includes(tag.id) && (tagIds[index]?.length ?? 0) >= MAX_TAGS}
                          onChange={() =>
                            setTagIds((current) =>
                              current.map((ids, i) => (i === index ? toggleId(ids, tag.id, MAX_TAGS) : ids)),
                            )
                          }
                        />
                        <span>
                          {tag.name}
                          {unavailable ? (
                            <span className="save-consequence">No longer available</span>
                          ) : tag.consequence || shelfOfTag(tag.name).key === "food" ? (
                            <span className="save-consequence">{tag.consequence ?? "Appears in Recipe Box"}</span>
                          ) : null}
                        </span>
                      </label>
                      );
                    })}
                    {(proposed[index] ?? []).map((name) => (
                      <div key={`new:${name}`} className="intake-draft-proposed">
                        <span className="intake-draft-new-tag">{name} · proposed new tag, not saved</span>
                        <button type="button" className="btn" name="confirmTag" disabled={busy} onClick={() => confirmTag(name)}>
                          Create tag
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() =>
                            setProposed((current) =>
                              current.map((list, i) => (i === index ? list.filter((entry) => entry !== name) : list)),
                            )
                          }
                        >
                          Skip
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </fieldset>
              <p className="intake-draft-origin">Agent-observed details. Locus did not fetch this page.</p>
            </article>
          </li>
          );
        })}
      </ul>
      <div className="intake-drafts-actions">
        <button className="btn" type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" type="button" name="saveSelected" disabled={busy || chosen === 0 || blocked} onClick={() => void save()}>
          {busy ? "Saving…" : chosen === 1 ? "Save 1 selected" : `Save ${chosen} selected`}
        </button>
      </div>
    </dialog>
  );
}

function existingTagIds(draft: PresentedIntakeDraft): string[] {
  return draft.tags.flatMap((tag) => (tag.id && !tag.proposed ? [tag.id] : []));
}

function leftovers<T extends { id: string }>(known: T[], live: T[], selected: Set<string>): T[] {
  const liveIds = new Set(live.map((item) => item.id));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of known) {
    if (!selected.has(item.id) || liveIds.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function withGhosts<T extends { id: string }>(live: T[], ghosts: T[], selected: string[]): T[] {
  const liveIds = new Set(live.map((item) => item.id));
  return [...live, ...ghosts.filter((item) => selected.includes(item.id) && !liveIds.has(item.id))];
}

function hasMissing(selected: string[], live: { id: string }[]): boolean {
  const liveIds = new Set(live.map((item) => item.id));
  return selected.some((id) => !liveIds.has(id));
}

function Notes({ draft }: { draft: PresentedIntakeDraft }) {
  const lines = [
    draft.rationale,
    draft.evidenceBasis ? `Evidence: ${draft.evidenceBasis}` : null,
    draft.uncertainty,
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) return <>None given</>;
  return (
    <span className="intake-draft-notes">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

function Field({ label, value, missing }: { label: string; value: string | null; missing: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {missing || !value ? <span className="intake-draft-missing">Missing</span> : value}
        {!missing && value ? <span className="visually-hidden"> Agent-observed.</span> : null}
      </dd>
    </>
  );
}
