import { test } from "node:test";
import assert from "node:assert/strict";
import { SHELVES, shelfOfTag, shelvesWithCounts, tagsForShelf } from "../core/categories.ts";

const EXPECTED: Record<string, string> = {
  tech: "tech",
  ai: "tech",
  programming: "tech",
  opensource: "tech",
  security: "tech",
  socialmedia: "tech",
  shipping: "tech",
  tutorial: "tech",
  guides: "tech",
  video: "tech",
  short: "tech",
  health: "health",
  fitness: "health",
  grooming: "health",
  hair: "health",
  haircut: "health",
  barber: "health",
  beauty: "health",
  fragrance: "health",
  food: "food",
  recipe: "food",
  dessert: "food",
  airfryer: "food",
  travel: "travel",
  career: "career",
  education: "career",
  motivation: "career",
  selfimprovement: "career",
  lifehacks: "career",
  sports: "sports",
  bike: "sports",
  finance: "money",
  watches: "money",
  watch: "money",
  sneakers: "money",
  fashion: "money",
  style: "money",
  lifestyle: "money",
  books: "culture",
  movies: "culture",
  tv: "culture",
  music: "culture",
  poetry: "culture",
  dance: "culture",
  bhangra: "culture",
  acting: "culture",
  gaming: "culture",
  art: "art",
  design: "art",
  photography: "art",
  animation: "art",
  craft: "art",
  diy: "art",
  architecture: "art",
  toys: "art",
  dating: "love",
  relationship: "love",
  relationships: "love",
  couples: "love",
  love: "love",
  friendship: "love",
  wedding: "love",
  comedy: "else",
  memes: "else",
  quotes: "else",
  science: "else",
  politics: "else",
  social: "else",
  trending: "else",
  questions: "else",
  nsfw: "else",
  desk: "else",
};

test("every listed tag maps to exactly one shelf", () => {
  assert.equal(Object.keys(EXPECTED).length, 72);
  assert.equal(SHELVES.length, 11);
  for (const [tag, key] of Object.entries(EXPECTED)) {
    assert.equal(shelfOfTag(tag).key, key, tag);
  }
});

test("unknown tags and whitespace fall back to else", () => {
  assert.equal(shelfOfTag("unknown-xyz").key, "else");
  assert.equal(shelfOfTag("  AI ").key, "tech");
  assert.equal(shelfOfTag("").key, "else");
});

test("shelvesWithCounts counts an item once per shelf", () => {
  const counts = Object.fromEntries(
    shelvesWithCounts([
      { tags: ["tech", "ai", "food"] },
      { tags: ["food"] },
      { tags: ["nope"] },
      { tags: [] },
    ]).map((row) => [row.shelf.key, row.count]),
  );
  assert.equal(counts.tech, 1);
  assert.equal(counts.food, 2);
  assert.equal(counts.else, 1);
  assert.equal(counts.travel, 0);
  assert.equal(tagsForShelf("food").includes("airfryer"), true);
});
