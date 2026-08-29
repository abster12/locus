import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { addTag } from "../core/commands.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { kitchenAiStatus, makeCookable, type KitchenInferenceProvider, type KitchenAiProposal } from "../server/kitchen/ai.ts";

const NOW = "2026-08-29T12:00:00.000Z";

function fixture(body: string | null, title = "Paneer tikka") {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "locus-kitchen-ai-")), "t.db"));
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES ('food-1', 'reel', ?, ?, 'https://www.instagram.com/reel/food-1/', ?, '[]', ?, ?)`,
  ).run(title, body, NOW, NOW, NOW);
  addTag(db, "food-1", "food");
  return db;
}

function provider(proposal: KitchenAiProposal): KitchenInferenceProvider {
  return { id: "fake", model: "test", propose: async () => proposal };
}

test("Kitchen inference accepts only the Locus-owned deployment credential", () => {
  const previousProvider = process.env.LOCUS_KITCHEN_PROVIDER_KEY;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  try {
    delete process.env.LOCUS_KITCHEN_PROVIDER_KEY;
    process.env.OPENAI_API_KEY = "user-key-must-not-enable-kitchen";
    assert.deepEqual(kitchenAiStatus(), { available: false, detail: "Locus AI isn't available on this deployment yet." });
    process.env.LOCUS_KITCHEN_PROVIDER_KEY = "locus-deployment-secret";
    assert.deepEqual(kitchenAiStatus(), { available: true, detail: "Locus AI is ready." });
  } finally {
    if (previousProvider === undefined) delete process.env.LOCUS_KITCHEN_PROVIDER_KEY;
    else process.env.LOCUS_KITCHEN_PROVIDER_KEY = previousProvider;
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
  }
});

test("Make this cookable stores a caption-backed draft with exact evidence", async () => {
  const db = fixture("200 g paneer\nGrill the paneer until charred");
  const result = await makeCookable(
    db,
    "local",
    "food-1",
    false,
    NOW,
    provider({
      outcome: "recipe",
      provenance: "caption",
      title: null,
      titleQuote: null,
      servings: null,
      servingsQuote: null,
      totalTime: null,
      totalTimeQuote: null,
      ingredients: [{ raw: "200 g paneer", name: "paneer", quantity: "200", unit: "g", preparation: null, group: null, sourceQuote: "200 g paneer" }],
      steps: [{ instruction: "Grill the paneer until charred", ingredientIndexes: [0], duration: null, temperature: null, sourceQuote: "Grill the paneer until charred" }],
    }),
  );
  assert.equal(result.outcome, "created");
  if (result.outcome === "created") {
    assert.equal(result.document.status, "draft");
    assert.equal(result.document.provenance, "caption");
    assert.deepEqual(result.document.draft.ingredients[0]?.evidence, {
      kind: "caption",
      spans: [{ start: 0, end: 12, text: "200 g paneer" }],
    });
  }
  db.close();
});

test("sparse source stops for consent, then stores a clearly generated draft", async () => {
  const db = fixture(null, "Crispy chilli potatoes");
  const first = await makeCookable(
    db,
    "local",
    "food-1",
    false,
    NOW,
    provider({ outcome: "needs_generation", dish: "crispy chilli potatoes" }),
  );
  assert.deepEqual(first, { outcome: "needs_generation", dish: "crispy chilli potatoes" });
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM kitchen_recipe_documents`).get() as { n: number }).n, 0);

  const generated = await makeCookable(
    db,
    "local",
    "food-1",
    true,
    NOW,
    provider({
      outcome: "recipe",
      provenance: "generated",
      title: "Crispy chilli potatoes",
      titleQuote: null,
      servings: "2 servings",
      servingsQuote: null,
      totalTime: "35 minutes",
      totalTimeQuote: null,
      ingredients: [{ raw: "500 g potatoes", name: "potatoes", quantity: "500", unit: "g", preparation: null, group: null, sourceQuote: null }],
      steps: [{ instruction: "Roast until crisp.", ingredientIndexes: [0], duration: "25 minutes", temperature: "220°C", sourceQuote: null }],
    }),
  );
  assert.equal(generated.outcome, "created");
  if (generated.outcome === "created") {
    assert.equal(generated.document.provenance, "generated");
    assert.deepEqual(generated.document.draft.steps[0]?.evidence, { kind: "generated" });
  }
  db.close();
});

test("provider cannot generate before the user consents", async () => {
  const db = fixture(null);
  await assert.rejects(
    () => makeCookable(
      db,
      "local",
      "food-1",
      false,
      NOW,
      provider({
        outcome: "recipe",
        provenance: "generated",
        title: null,
        titleQuote: null,
        servings: null,
        servingsQuote: null,
        totalTime: null,
        totalTimeQuote: null,
        ingredients: [{ raw: "salt", name: "salt", quantity: null, unit: null, preparation: null, group: null, sourceQuote: null }],
        steps: [],
      }),
    ),
    RejectedPayload,
  );
  db.close();
});
