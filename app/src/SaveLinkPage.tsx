import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Collection, type IntakePreview, type ItemCard, type SaveLinkInput } from "./api.ts";
import { shelfOfTag } from "../../core/categories.ts";
import { localDay } from "../../core/dates.ts";

const MAX_TAGS = 12;
const MAX_COLLECTIONS = 5;

export function SaveLinkDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (item: ItemCard) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const urlField = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [publishedAt, setPublishedAt] = useState(() => localDay(new Date()));
  const [media, setMedia] = useState("");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [newTags, setNewTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [preview, setPreview] = useState<IntakePreview | null>(null);
  const [previewedKey, setPreviewedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    urlField.current?.focus();
    return () => {
      if (el.open) el.close();
      previouslyFocused?.focus();
    };
  }, []);

  const mediaItems = media
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((href) => ({ kind: "unknown", url: href }));
  const draft: SaveLinkInput = {
    url: url.trim(),
    ...(title.trim() ? { title: title.trim() } : {}),
    ...(body.trim() ? { body: body.trim() } : {}),
    ...(authorName.trim() ? { authorName: authorName.trim() } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(mediaItems.length ? { media: mediaItems } : {}),
    ...(tagIds.length ? { tagIds } : {}),
    ...(collectionIds.length ? { collectionIds } : {}),
    ...(newTags.length ? { newTags } : {}),
  };

  useEffect(() => {
    api
      .collections()
      .then((result) => {
        setCollections(result.collections);
        setTags(result.tags);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const previewKey = JSON.stringify(draft);
  const previewReady = preview !== null && previewedKey === previewKey;

  useEffect(() => {
    if (!draft.url) {
      setPreview(null);
      setPreviewedKey(null);
      return;
    }
    const controller = new AbortController();
    const payload = draft;
    const key = JSON.stringify(payload);
    const timer = window.setTimeout(() => {
      api
        .previewLink(payload, controller.signal)
        .then((shown) => {
          setPreview(shown);
          setPreviewedKey(key);
          setErr(null);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setPreview(null);
          setPreviewedKey(null);
          setErr(error instanceof Error ? error.message : String(error));
        });
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [url, title, body, authorName, publishedAt, media, tagIds, collectionIds, newTags]);

  function toggle(id: string, selected: string[], setSelected: (next: string[]) => void, max: number) {
    if (selected.includes(id)) {
      setSelected(selected.filter((value) => value !== id));
      return;
    }
    if (selected.length >= max) return;
    setSelected([...selected, id]);
  }

  function createTag() {
    const name = tagDraft.trim();
    if (!name) return;
    const existing = tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!tagIds.includes(existing.id) && tagIds.length + newTags.length < MAX_TAGS) {
        setTagIds([...tagIds, existing.id]);
      }
      setTagDraft("");
      return;
    }
    if (newTags.some((tag) => tag.toLowerCase() === name.toLowerCase())) {
      setTagDraft("");
      return;
    }
    if (tagIds.length + newTags.length >= MAX_TAGS) return;
    setNewTags([...newTags, name]);
    setTagDraft("");
  }

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (busy || !previewReady) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await api.saveLink(draft);
      onSaved(result.item);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
      urlField.current?.focus();
    }
  }

  return (
    <dialog
      ref={dialog}
      className="trip-add-dialog save-link"
      aria-labelledby="save-link-title"
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="trip-add-head">
        <h1 id="save-link-title">Save a link</h1>
        <button type="button" className="btn trip-add-close" aria-label="Close save a link" disabled={busy} onClick={onClose}>
          ×
        </button>
      </div>
      <p className="pagesub">URL is required. Other details are optional. Opening this form does not fetch the page.</p>
      <form className="trip-form" onSubmit={submit}>
        {err ? (
          <p className="bad" role="alert" id="save-link-error">
            {err}
          </p>
        ) : null}
        <label className="trip-field">
          URL <span className="trip-req">required</span>
          <input
            ref={urlField}
            type="url"
            name="url"
            autoComplete="url"
            inputMode="url"
            required
            value={url}
            aria-invalid={Boolean(err) || undefined}
            aria-describedby={err ? "save-link-error" : undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label className="trip-field">
          Title
          <input name="title" value={title} maxLength={500} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="trip-field">
          Source text
          <textarea name="body" rows={5} value={body} maxLength={20000} onChange={(event) => setBody(event.target.value)} />
        </label>
        <label className="trip-field">
          Author
          <input name="authorName" value={authorName} maxLength={200} onChange={(event) => setAuthorName(event.target.value)} />
        </label>
        <label className="trip-field">
          Publication date
          <input type="date" name="publishedAt" value={publishedAt} onChange={(event) => setPublishedAt(event.target.value)} />
        </label>
        <label className="trip-field">
          Media URLs
          <textarea
            name="media"
            rows={3}
            value={media}
            onChange={(event) => setMedia(event.target.value)}
            aria-describedby="save-link-media-hint"
          />
          <span id="save-link-media-hint" className="trip-hint">
            Up to 8 HTTP(S) links, one per line.
          </span>
        </label>
        <fieldset className="save-org" name="destinations">
          <legend>Collections</legend>
          <p className="trip-hint" id="save-collections-hint">
            Destination for this Item. Does not change status, snooze, notes, or Reading progress.
          </p>
          {collections.length === 0 ? (
            <p className="trip-hint">No Collections yet.</p>
          ) : (
            <div className="save-choices" role="group" aria-describedby="save-collections-hint">
              {collections.map((collection) => (
                <label className="save-choice" key={collection.id}>
                  <input
                    type="checkbox"
                    name="collectionIds"
                    value={collection.id}
                    checked={collectionIds.includes(collection.id)}
                    disabled={!collectionIds.includes(collection.id) && collectionIds.length >= MAX_COLLECTIONS}
                    onChange={() => toggle(collection.id, collectionIds, setCollectionIds, MAX_COLLECTIONS)}
                  />
                  <span>
                    {collection.name}
                    {collection.description ? <span className="save-consequence">{collection.description}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset className="save-org" name="classification">
          <legend>Tags</legend>
          <p className="trip-hint" id="save-tags-hint">
            Classification for this Item. Does not change status, snooze, notes, or Reading progress.
          </p>
          {tags.length === 0 && newTags.length === 0 ? (
            <p className="trip-hint">No tags yet. Create one below.</p>
          ) : (
            <div className="save-choices" role="group" aria-describedby="save-tags-hint">
              {tags.map((tag) => (
                <label className="save-choice" key={tag.id}>
                  <input
                    type="checkbox"
                    name="tagIds"
                    value={tag.id}
                    checked={tagIds.includes(tag.id)}
                    disabled={!tagIds.includes(tag.id) && tagIds.length + newTags.length >= MAX_TAGS}
                    onChange={() => toggle(tag.id, tagIds, setTagIds, MAX_TAGS - newTags.length)}
                  />
                  <span>
                    {tag.name}
                    {shelfOfTag(tag.name).key === "food" ? (
                      <span className="save-consequence">Appears in Recipe Box</span>
                    ) : null}
                  </span>
                </label>
              ))}
              {newTags.map((name) => (
                <label className="save-choice" key={`new:${name}`}>
                  <input
                    type="checkbox"
                    name="newTags"
                    value={name}
                    checked
                    onChange={() => setNewTags(newTags.filter((tag) => tag !== name))}
                  />
                  <span>
                    {name}
                    {shelfOfTag(name).key === "food" ? (
                      <span className="save-consequence">Appears in Recipe Box</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="save-create-tag">
            <label className="trip-field">
              New tag
              <input
                name="newTag"
                value={tagDraft}
                maxLength={40}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    createTag();
                  }
                }}
              />
            </label>
            <button className="btn" type="button" name="createTag" disabled={!tagDraft.trim()} onClick={createTag}>
              Create tag
            </button>
          </div>
        </fieldset>
        <section className="save-preview" id="save-link-preview" aria-labelledby="save-link-preview-title">
          <h2 id="save-link-preview-title">Preview</h2>
          <dl>
            <dt>URL</dt>
            <dd>{preview?.item.url || <Missing />}</dd>
            <dt>Title</dt>
            <dd>{preview?.item.title || <Missing />}</dd>
            <dt>Source text</dt>
            <dd>{preview?.item.body || <Missing />}</dd>
            <dt>Author</dt>
            <dd>{preview?.item.authorName || <Missing />}</dd>
            <dt>Publication date</dt>
            <dd>{preview?.item.publishedAt || <Missing />}</dd>
            <dt>Media</dt>
            <dd>{preview?.item.media.length ? preview.item.media.map((item) => item.url).join(", ") : <Missing />}</dd>
            <dt>Collections</dt>
            <dd>{preview?.collections.length ? preview.collections.map((collection) => collection.name).join(", ") : "None selected"}</dd>
            <dt>Tags</dt>
            <dd>{preview?.tags.length ? preview.tags.map((tag) => tag.name).join(", ") : "None selected"}</dd>
          </dl>
        </section>
        <div className="trip-form-actions">
          <button className="btn" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !previewReady} type="submit">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Missing() {
  return <span className="save-missing">Missing</span>;
}
