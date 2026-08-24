export type ShelfKey =
  | "tech"
  | "health"
  | "food"
  | "travel"
  | "career"
  | "sports"
  | "money"
  | "culture"
  | "art"
  | "love"
  | "else";

export type MotifName =
  | "term"
  | "pulse"
  | "bowl"
  | "plane"
  | "clip"
  | "spark"
  | "coin"
  | "book"
  | "camera"
  | "heart";

export interface Shelf {
  key: ShelfKey;
  name: string;
  color: string;
  motif: MotifName;
}

export const SHELVES: Shelf[] = [
  { key: "tech", name: "Tech & Code", color: "#4053b3", motif: "term" },
  { key: "health", name: "Health & Body", color: "#17948a", motif: "pulse" },
  { key: "food", name: "Food", color: "#d64541", motif: "bowl" },
  { key: "travel", name: "Travel", color: "#1e88c9", motif: "plane" },
  { key: "career", name: "Work & Growth", color: "#77803a", motif: "clip" },
  { key: "sports", name: "Sports", color: "#2e6b3e", motif: "spark" },
  { key: "money", name: "Money & Style", color: "#a8861f", motif: "coin" },
  { key: "culture", name: "Screen & Page", color: "#7a4fb5", motif: "book" },
  { key: "art", name: "Art & Design", color: "#5d6b7a", motif: "camera" },
  { key: "love", name: "Relationships", color: "#c9526f", motif: "heart" },
  { key: "else", name: "Everything else", color: "#7d838a", motif: "spark" },
];

const SHELF_TAGS: Record<ShelfKey, string[]> = {
  tech: ["tech", "ai", "programming", "opensource", "security", "socialmedia", "shipping", "tutorial", "guides", "video", "short"],
  health: ["health", "fitness", "grooming", "hair", "haircut", "barber", "beauty", "fragrance"],
  food: ["food", "recipe", "dessert", "airfryer"],
  travel: ["travel"],
  career: ["career", "education", "motivation", "selfimprovement", "lifehacks"],
  sports: ["sports", "bike"],
  money: ["finance", "watches", "watch", "sneakers", "fashion", "style", "lifestyle"],
  culture: ["books", "movies", "tv", "music", "poetry", "dance", "bhangra", "acting", "gaming"],
  art: ["art", "design", "photography", "animation", "craft", "diy", "architecture", "toys"],
  love: ["dating", "relationship", "relationships", "couples", "love", "friendship", "wedding"],
  else: ["comedy", "memes", "quotes", "science", "politics", "social", "trending", "questions", "nsfw", "desk"],
};

const TAG_TO_SHELF: Record<string, ShelfKey> = {};
for (const shelf of SHELVES) {
  for (const tag of SHELF_TAGS[shelf.key]) TAG_TO_SHELF[tag] = shelf.key;
}

const SHELF_BY_KEY = Object.fromEntries(SHELVES.map((s) => [s.key, s])) as Record<ShelfKey, Shelf>;

export function shelfOfTag(name: string): Shelf {
  return SHELF_BY_KEY[TAG_TO_SHELF[name.trim().toLowerCase()] ?? "else"];
}

export function tagsForShelf(key: ShelfKey): string[] {
  return SHELF_TAGS[key];
}

export function shelvesWithCounts(tagsByItem: { tags: string[] }[]): { shelf: Shelf; count: number }[] {
  const counts = new Map<ShelfKey, number>();
  for (const item of tagsByItem) {
    const seen = new Set<ShelfKey>();
    for (const tag of item.tags) {
      const key = shelfOfTag(tag).key;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return SHELVES.map((shelf) => ({ shelf, count: counts.get(shelf.key) ?? 0 }));
}
