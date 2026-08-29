import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { addTag } from "../core/commands.ts";
import { itemMatchesFilter, listItemsPage, wipeLibrary } from "../core/library.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import {
  KitchenConflict,
  LOCAL_LIBRARY_ID,
  MAX_TONIGHT_ENTRIES,
  addTonight,
  captionRevision,
  canWatchItem,
  clearTonight,
  displayTitle,
  exportKitchenRecords,
  getKitchenIndex,
  getKitchenItem,
  getTonight,
  importKitchenRecords,
  kitchenAvailability,
  normalizeCaption,
  projectRecipeScore,
  putRecipeDocument,
  removeRecipeDocument,
  removeTonight,
  reorderTonight,
  validateRecipeDraft,
} from "../server/kitchen/module.ts";

const NOW = "2026-08-29T12:00:00.000Z";
const LIB = LOCAL_LIBRARY_ID;

function db() {
  const value = openDb(join(mkdtempSync(join(tmpdir(), "locus-kitchen-")), "t.db"));
  value.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at) VALUES ('acct', 'instagram', 'u', 'U', ?)`,
  ).run(NOW);
  value.prepare(
    `INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES ('col', 'acct', 'saved', 'Saved', ?)`,
  ).run(NOW);
  return value;
}

function insertItem(
  value: ReturnType<typeof db>,
  id: string,
  opts: { body?: string | null; title?: string | null; url?: string; status?: string; source?: string; media?: string } = {},
): void {
  const url = opts.url ?? `https://www.instagram.com/reel/${id}/`;
  value.prepare(
    `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'reel', ?, ?, ?, 'cook', ?, ?, ?, ?)`,
  ).run(id, opts.title ?? null, opts.body ?? null, url, NOW, opts.media ?? "[]", NOW, NOW);
  const sourceAccount = opts.source === "youtube" ? "yt" : "acct";
  if (opts.source === "youtube") {
    value.prepare(
      `INSERT OR IGNORE INTO source_accounts (id, source, external_id, display_name, created_at) VALUES ('yt', 'youtube', 'y', 'Y', ?)`,
    ).run(NOW);
  }
  value.prepare(
    `INSERT INTO source_records (id, source_account_id, external_id, item_id, first_observed_at, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`r-${id}`, sourceAccount, id, id, NOW, NOW);
  if (opts.status) value.prepare(`INSERT INTO item_state (item_id, status, updated_at) VALUES (?, ?, ?)`).run(id, opts.status, NOW);
}

function food(value: ReturnType<typeof db>, id: string): void {
  addTag(value, id, "food");
}

function draft(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    ingredients: [
      {
        id: "ing-1",
        raw: "200 g paneer",
        quantity: "200",
        unit: "g",
        name: "paneer",
        evidence: { kind: "user" },
      },
    ],
    steps: [
      {
        id: "step-1",
        instruction: "Grill the paneer.",
        ingredientIds: ["ing-1"],
        evidence: { kind: "user" },
      },
    ],
    ...over,
  };
}

test("schema 9 creates Kitchen tables and wipe clears them", () => {
  const value = db();
  assert.equal((value.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
  insertItem(value, "food-1", { body: "mix flour" });
  food(value, "food-1");
  putRecipeDocument(value, LIB, "food-1", { expectedSourceRevision: captionRevision(normalizeCaption("mix flour")), status: "draft", draft: draft() }, "user", NOW);
  addTonight(value, LIB, "food-1", NOW);
  wipeLibrary(value);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM kitchen_recipe_documents`).get() as { n: number }).n, 0);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM kitchen_tonight_entries`).get() as { n: number }).n, 0);
  value.close();
});

test("caption normalize, revision, availability, title fallback, and watch reuse platform helpers", () => {
  assert.equal(normalizeCaption("  hello\r\nthere  "), "hello\nthere");
  assert.equal(captionRevision(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(kitchenAvailability("reviewed", "x", false), "reviewed");
  assert.equal(kitchenAvailability("draft", "x", true), "draft");
  assert.equal(kitchenAvailability(null, "caption", true), "caption");
  assert.equal(kitchenAvailability(null, null, true), "watch");
  assert.equal(kitchenAvailability(null, null, false), "source_only");
  assert.equal(
    canWatchItem({ url: "https://www.instagram.com/reel/abc/", media: [] }),
    true,
  );
  assert.equal(canWatchItem({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", media: [] }), true);
  assert.equal(canWatchItem({ url: "https://example.com/a", media: [{ kind: "video" }] }), true);
  assert.equal(canWatchItem({ url: "https://example.com/a", media: [{ kind: "image" }] }), false);
  const item = {
    id: "x",
    contentType: "reel",
    title: "Paneer",
    body: "Paneer tikka on the grill",
    url: "https://www.instagram.com/reel/abc/",
    authorName: null,
    authorHandle: "cook",
    publishedAt: null,
    sourceSavedAt: null,
    firstObservedAt: NOW,
    capturedAt: null,
    media: [] as { kind: string; url: string }[],
    source: "instagram",
    status: "inbox" as const,
    snoozedUntil: null,
    tags: [],
    collections: [],
    notes: [],
    dateLabel: { kind: "discovered" as const, at: NOW, text: "today" },
  };
  assert.equal(displayTitle(item, "Paneer tikka on the grill"), "Paneer tikka on the grill");
  assert.equal(displayTitle({ ...item, title: null, authorHandle: "name" }, null), "@name’s Reel");
  assert.equal(displayTitle({ ...item, title: null, authorHandle: null, authorName: null }, null), "Saved food Item");
});

test("recipe bounds, ids, evidence spans, and actor policy", () => {
  const caption = "Add 🍕 then rest";
  const start = caption.indexOf("🍕");
  const ok = validateRecipeDraft(
    {
      version: 1,
      ingredients: [
        {
          id: "ing-1",
          raw: "🍕",
          name: "pizza",
          evidence: { kind: "caption", spans: [{ start, end: start + "🍕".length, text: "🍕" }] },
        },
      ],
      steps: [{ id: "step-1", instruction: "Rest.", ingredientIds: [], evidence: { kind: "user" } }],
    },
    caption,
    "user",
  );
  assert.equal(ok.ingredients[0]?.evidence.kind, "caption");
  const score = projectRecipeScore({
    version: 1,
    ingredients: [
      { id: "a", raw: "a", name: "a", evidence: { kind: "user" } },
      { id: "b", raw: "b", name: "b", evidence: { kind: "user" } },
    ],
    steps: [
      { id: "s1", instruction: "use a", ingredientIds: ["a"], evidence: { kind: "user" } },
      { id: "s2", instruction: "use a again", ingredientIds: ["a"], evidence: { kind: "user" } },
    ],
  });
  assert.equal(score.placed[0]?.firstStepId, "s1");
  assert.deepEqual(score.unreferenced.map((row) => row.id), ["b"]);
  assert.equal(score.steps[1]?.ingredients[0]?.id, "a");
  assert.throws(() => validateRecipeDraft({ version: 2, ingredients: [], steps: [] }, caption, "user"), RejectedPayload);
  assert.throws(
    () =>
      validateRecipeDraft(
        {
          version: 1,
          extra: true,
          ingredients: [{ id: "ing-1", raw: "x", name: "x", evidence: { kind: "user" } }],
          steps: [],
        },
        caption,
        "user",
      ),
    RejectedPayload,
  );
  assert.throws(
    () =>
      validateRecipeDraft(
        {
          version: 1,
          ingredients: [
            {
              id: "ing-1",
              raw: "x",
              name: "x",
              evidence: { kind: "caption", spans: [{ start: 0, end: 3, text: "zzz" }] },
            },
          ],
          steps: [],
        },
        caption,
        "agent",
      ),
    RejectedPayload,
  );
  assert.throws(
    () =>
      validateRecipeDraft(
        {
          version: 1,
          ingredients: [{ id: "ing-1", raw: "x", name: "x", evidence: { kind: "user" } }],
          steps: [],
        },
        caption,
        "agent",
      ),
    RejectedPayload,
  );
  const agent = validateRecipeDraft(
    {
      version: 1,
      ingredients: [
        {
          id: "ing-1",
          raw: "Add",
          name: "add",
          evidence: { kind: "caption", spans: [{ start: 0, end: 3, text: "Add" }] },
        },
      ],
      steps: [],
    },
    caption,
    "agent",
  );
  assert.equal(agent.ingredients.length, 1);
});

test("Recipe Box membership matches Desk Food shelf under normal visibility", () => {
  const value = db();
  insertItem(value, "food-ok", { body: "cook this" });
  insertItem(value, "food-arch", { body: "old", status: "archived" });
  insertItem(value, "food-rej", { body: "no", status: "rejected" });
  insertItem(value, "tech", { body: "not food" });
  food(value, "food-ok");
  food(value, "food-arch");
  food(value, "food-rej");
  addTag(value, "tech", "tech");
  const kitchen = getKitchenIndex(value, LIB, {});
  const desk = listItemsPage(value, { view: "recent", shelf: "food" });
  assert.deepEqual(kitchen.items.map((row) => row.item.id), desk.items.map((row) => row.id));
  assert.deepEqual(kitchen.items.map((row) => row.item.id), ["food-ok"]);
  assert.equal(kitchen.counts.foodSaves, 1);
  assert.equal(kitchen.counts.structuredRecipes, 0);
  assert.equal(itemMatchesFilter(value, "food-ok", { view: "recent", shelf: "food" }), true);
  assert.equal(itemMatchesFilter(value, "food-arch", { view: "recent", shelf: "food" }), false);
  value.close();
});

test("recipe create, review, source change, actor rules, and search", () => {
  const value = db();
  const body = "200 g paneer\nGrill it";
  insertItem(value, "food-1", { body, title: "Paneer" });
  insertItem(value, "food-2", { body: "cake", title: "Cake" });
  food(value, "food-1");
  food(value, "food-2");
  const rev = captionRevision(normalizeCaption(body));
  const saved = putRecipeDocument(
    value,
    LIB,
    "food-1",
    { expectedSourceRevision: rev, status: "draft", draft: draft({ title: "Paneer tikka", titleEvidence: { kind: "user" } }) },
    "user",
    NOW,
  );
  assert.equal(saved.status, "draft");
  assert.equal(saved.sourceRevision, rev);
  assert.equal(saved.sourceChanged, false);
  assert.equal(saved.score.placed[0]?.firstStepId, "step-1");
  assert.equal(getKitchenIndex(value, LIB, {}).counts.structuredRecipes, 1);
  const reviewed = putRecipeDocument(
    value,
    LIB,
    "food-1",
    { expectedSourceRevision: rev, status: "reviewed", draft: saved.draft },
    "user",
    NOW,
  );
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.id, saved.id);
  assert.throws(
    () =>
      putRecipeDocument(
        value,
        LIB,
        "food-1",
        { expectedSourceRevision: rev, status: "reviewed", draft: draft() },
        "agent",
        NOW,
      ),
    RejectedPayload,
  );
  const still = getKitchenItem(value, LIB, "food-1");
  assert.equal(still?.recipe && "status" in still.recipe && still.recipe.status, "reviewed");
  value.prepare(`UPDATE items SET body = ? WHERE id = ?`).run("changed caption", "food-1");
  const changed = getKitchenItem(value, LIB, "food-1");
  assert.equal(changed && changed.recipe && "sourceChanged" in changed.recipe && changed.recipe.sourceChanged, true);
  assert.equal(changed && changed.recipe && "draft" in changed.recipe && changed.recipe.draft.title, "Paneer tikka");
  assert.throws(
    () => putRecipeDocument(value, LIB, "food-1", { expectedSourceRevision: rev, status: "draft", draft: draft() }, "user", NOW),
    KitchenConflict,
  );
  const afterConflict = getKitchenItem(value, LIB, "food-1");
  assert.equal(afterConflict && afterConflict.recipe && "status" in afterConflict.recipe && afterConflict.recipe.status, "reviewed");
  const nextRev = captionRevision(normalizeCaption("changed caption"));
  putRecipeDocument(value, LIB, "food-1", { expectedSourceRevision: nextRev, status: "draft", draft: draft() }, "user", NOW);
  const index = getKitchenIndex(value, LIB, { q: "paneer" });
  assert.ok(index.items.some((row) => row.item.id === "food-1"));
  assert.equal(index.items.find((row) => row.item.id === "food-1")?.recipe && !("draft" in (index.items[0]?.recipe ?? {})), true);
  assert.equal(removeRecipeDocument(value, LIB, "food-1"), true);
  assert.equal(getKitchenItem(value, LIB, "food-1")?.recipe, null);
  const bodyAfter = value.prepare(`SELECT body FROM items WHERE id = ?`).get("food-1") as { body: string };
  assert.equal(bodyAfter.body, "changed caption");
  value.close();
});

test("Tonight append, idempotence, cap, reorder atomicity, eligibility, and missing items", () => {
  const value = db();
  insertItem(value, "a", { body: "a" });
  insertItem(value, "b", { body: "b" });
  insertItem(value, "c", { body: "c" });
  insertItem(value, "archived", { body: "z", status: "archived" });
  insertItem(value, "plain", { body: "no tag" });
  food(value, "a");
  food(value, "b");
  food(value, "c");
  food(value, "archived");
  const first = addTonight(value, LIB, "a", NOW);
  const again = addTonight(value, LIB, "a", NOW);
  assert.equal(again.id, first.id);
  addTonight(value, LIB, "b", NOW);
  addTonight(value, LIB, "c", NOW);
  assert.deepEqual(getTonight(value, LIB).map((row) => row.itemId), ["a", "b", "c"]);
  const ids = getTonight(value, LIB).map((row) => row.id);
  reorderTonight(value, LIB, [ids[2]!, ids[0]!, ids[1]!], NOW);
  assert.deepEqual(getTonight(value, LIB).map((row) => row.itemId), ["c", "a", "b"]);
  assert.throws(() => reorderTonight(value, LIB, [ids[0]!, ids[1]!], NOW), KitchenConflict);
  assert.deepEqual(getTonight(value, LIB).map((row) => row.itemId), ["c", "a", "b"]);
  assert.throws(() => addTonight(value, LIB, "missing", NOW), Error);
  assert.throws(() => addTonight(value, LIB, "archived", NOW), KitchenConflict);
  assert.throws(() => addTonight(value, LIB, "plain", NOW), KitchenConflict);
  value.prepare(`DELETE FROM memberships WHERE item_id = 'a'`).run();
  value.prepare(`INSERT INTO item_state (item_id, status, updated_at) VALUES ('b', 'archived', ?)`).run(NOW);
  assert.ok(getTonight(value, LIB).some((row) => row.itemId === "a" && row.item));
  assert.ok(getTonight(value, LIB).some((row) => row.itemId === "b" && row.item?.item.status === "archived"));
  assert.equal(getKitchenItem(value, LIB, "a")?.item.id, "a");
  value.prepare(`DELETE FROM items WHERE id = 'c'`).run();
  const missing = getTonight(value, LIB).find((row) => row.itemId === "c");
  assert.equal(missing?.item, null);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM kitchen_recipe_documents`).get() as { n: number }).n, 0);
  assert.equal(removeTonight(value, LIB, missing!.id), true);
  assert.equal(clearTonight(value, LIB), 2);
  assert.equal(getTonight(value, LIB).length, 0);
  for (let i = 0; i < MAX_TONIGHT_ENTRIES; i += 1) {
    const id = `cap-${i}`;
    insertItem(value, id, { body: "x", url: `https://www.instagram.com/reel/${id}/` });
    food(value, id);
    addTonight(value, LIB, id, NOW);
  }
  insertItem(value, "cap-extra", { body: "x" });
  food(value, "cap-extra");
  assert.throws(() => addTonight(value, LIB, "cap-extra", NOW), KitchenConflict);
  value.close();
});

test("Kitchen archive validates recipes and keeps broken Tonight pins", () => {
  const value = db();
  insertItem(value, "food-1", { body: "mix" });
  food(value, "food-1");
  const rev = captionRevision(normalizeCaption("mix"));
  putRecipeDocument(value, LIB, "food-1", { expectedSourceRevision: rev, status: "reviewed", draft: draft() }, "user", NOW);
  addTonight(value, LIB, "food-1", NOW);
  const exported = exportKitchenRecords(value, LIB);
  const other = db();
  insertItem(other, "food-1", { body: "mix" });
  food(other, "food-1");
  importKitchenRecords(other, {
    recipes: exported.records.filter((row) => row.kind === "kitchenRecipeDocument"),
    tonight: [
      ...exported.records.filter((row) => row.kind === "kitchenTonightEntry"),
      { kind: "kitchenTonightEntry", id: "broken", itemId: "gone", position: 1, createdAt: NOW, updatedAt: NOW },
    ],
    itemIds: new Set(["food-1"]),
  });
  assert.equal(getKitchenItem(other, LIB, "food-1")?.recipe && "status" in (getKitchenItem(other, LIB, "food-1")!.recipe ?? {}) && (getKitchenItem(other, LIB, "food-1")!.recipe as { status: string }).status, "reviewed");
  assert.equal(getTonight(other, LIB).some((row) => row.itemId === "gone" && row.item === null), true);
  const empty = db();
  assert.throws(
    () =>
      importKitchenRecords(empty, {
        recipes: exported.records.filter((row) => row.kind === "kitchenRecipeDocument"),
        tonight: [],
        itemIds: new Set(),
      }),
    RejectedPayload,
  );
  insertItem(empty, "food-1", { body: "mix" });
  food(empty, "food-1");
  const agentReviewed = exported.records
    .filter((row) => row.kind === "kitchenRecipeDocument")
    .map((row) => ({ ...row, updatedBy: "agent", status: "reviewed" }));
  assert.throws(
    () => importKitchenRecords(empty, { recipes: agentReviewed, tonight: [], itemIds: new Set(["food-1"]) }),
    RejectedPayload,
  );
  value.close();
  other.close();
  empty.close();
});

test("structured search is Library-scoped and index payloads stay bounded", () => {
  const value = db();
  insertItem(value, "food-1", { body: "mix flour", title: "Mix" });
  food(value, "food-1");
  const secret = "zaatar-sumac-blend";
  value.prepare(
    `INSERT INTO kitchen_recipe_documents (
       id, library_id, item_id, schema_version, status, source_revision, source_caption,
       updated_by, draft_json, created_at, updated_at
     ) VALUES ('rec-other', 'other', 'food-1', 1, 'draft', ?, 'mix flour', 'user', ?, ?, ?)`,
  ).run(
    captionRevision(normalizeCaption("mix flour")),
    JSON.stringify(draft({ ingredients: [{ id: "ing-1", raw: secret, name: secret, evidence: { kind: "user" } }], steps: [] })),
    NOW,
    NOW,
  );
  assert.equal(getKitchenIndex(value, LIB, { q: secret }).items.length, 0);
  putRecipeDocument(
    value,
    LIB,
    "food-1",
    { expectedSourceRevision: captionRevision(normalizeCaption("mix flour")), status: "draft", draft: draft() },
    "user",
    NOW,
  );
  const index = getKitchenIndex(value, LIB, {});
  assert.equal(index.items[0]?.item.body, null);
  assert.equal(index.items[0]?.item.notes.length, 0);
  assert.equal(index.items[0]?.recipe && "draft" in index.items[0]!.recipe, false);
  assert.ok(index.sources.includes("instagram"));
  value.close();
});

test("Kitchen operations do not mutate Item organization", () => {
  const value = db();
  insertItem(value, "food-1", { body: "mix", title: "Mix" });
  food(value, "food-1");
  const before = value.prepare(`SELECT title, body FROM items WHERE id = 'food-1'`).get() as { title: string; body: string };
  const tags = value.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE item_id = 'food-1'`).get() as { n: number };
  putRecipeDocument(
    value,
    LIB,
    "food-1",
    { expectedSourceRevision: captionRevision(normalizeCaption("mix")), status: "reviewed", draft: draft() },
    "user",
    NOW,
  );
  addTonight(value, LIB, "food-1", NOW);
  const after = value.prepare(`SELECT title, body FROM items WHERE id = 'food-1'`).get() as { title: string; body: string };
  assert.deepEqual(after, before);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE item_id = 'food-1'`).get() as { n: number }).n, tags.n);
  value.close();
});
