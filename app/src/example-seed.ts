import type {
  AtlasPlace,
  ItemCard,
  RecipeDocument,
  TripContext,
  TripDocument,
  TripStop,
} from "./api.ts";

export type ExampleReading = {
  minutes: number;
  pub: string;
  state: "unread" | "finished";
  removed?: boolean;
};

export type ExampleMeta = {
  food: boolean;
  caption: string | null;
  recipe: RecipeDocument | null;
  placeId: string | null;
  atlas: boolean;
  reading: ExampleReading | null;
};

export type TonightRow = {
  id: string;
  itemId: string;
  order: number;
  createdAt: string;
};

export type ExampleStore = {
  items: ItemCard[];
  meta: Record<string, ExampleMeta>;
  places: AtlasPlace[];
  homePlaceId: string | null;
  tonight: TonightRow[];
  tonightRevision: number;
  tonightMutationId: string | null;
  trips: TripDocument[];
  readingUndo: { token: string; itemId: string } | null;
};

const EMPTY_CONTEXT: TripContext = {
  lodgingAnchors: [],
  pace: null,
  mobility: null,
  budget: null,
  mealPreferences: [],
  interests: [],
  mustDos: [],
  hardConstraints: [],
};

const ACCENT = { color: "#1e88c9", ink: "#ffffff" };

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function card(input: {
  id: string;
  source: "x" | "instagram" | "youtube" | "reddit";
  title: string;
  body: string;
  author: string;
  handle: string;
  url: string;
  tags: string[];
  daysAgo: number;
}): ItemCard {
  const at = isoDaysAgo(input.daysAgo);
  return {
    id: input.id,
    contentType: input.source === "youtube" ? "video" : "post",
    title: input.title,
    body: input.body,
    url: input.url,
    authorName: input.author,
    authorHandle: input.handle,
    publishedAt: at,
    sourceSavedAt: at,
    firstObservedAt: at,
    capturedAt: at,
    source: input.source,
    status: "inbox",
    snoozedUntil: null,
    tags: input.tags.map((name) => ({ id: `tag-${name}`, name, color: null })),
    collections: [],
    notes: [],
    dateLabel: { kind: "relative", at, text: input.daysAgo === 0 ? "Today" : input.daysAgo === 1 ? "Yesterday" : at.slice(0, 10) },
    media: [],
    intakeActor: "user",
  };
}

function place(id: string, name: string, kind: string, parentId: string | null = null): AtlasPlace {
  return { id, name, kind, parentId, ancestors: [], altNames: [], accent: ACCENT };
}

function evidence(): RecipeDocument["draft"]["ingredients"][number]["evidence"] {
  return { kind: "caption", spans: [] };
}

function recipe(input: {
  id: string;
  itemId: string;
  status: "draft" | "reviewed";
  title: string;
  caption: string;
  servings: string;
  totalTime: string;
  ingredients: { id: string; raw: string; name: string; quantity?: string; unit?: string }[];
  steps: { id: string; instruction: string; ingredientIds: string[] }[];
}): RecipeDocument {
  const now = isoDaysAgo(0);
  const ingredients = input.ingredients.map((row) => ({
    ...row,
    evidence: evidence(),
  }));
  const steps = input.steps.map((row) => ({ ...row, evidence: evidence() }));
  return {
    id: input.id,
    itemId: input.itemId,
    status: input.status,
    sourceChanged: false,
    title: input.title,
    servings: input.servings,
    totalTime: input.totalTime,
    sourceRevision: "seed",
    sourceCaption: input.caption,
    updatedBy: "user",
    provenance: "caption",
    draft: { version: 1, title: input.title, servings: input.servings, totalTime: input.totalTime, ingredients, steps },
    score: {
      placed: ingredients.map((ingredient) => ({
        ingredient,
        firstStepId: steps.find((step) => step.ingredientIds.includes(ingredient.id))?.id ?? steps[0]!.id,
      })),
      unreferenced: [],
      steps: steps.map((step) => ({
        step,
        ingredients: ingredients.filter((ingredient) => step.ingredientIds.includes(ingredient.id)),
      })),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function stop(input: {
  id: string;
  dayId: string | null;
  position: number;
  content: TripStop["content"];
  resolved: TripStop["resolved"];
  timeWindow?: string | null;
}): TripStop {
  const now = "2026-03-12T12:00:00.000Z";
  return {
    id: input.id,
    dayId: input.dayId,
    position: input.position,
    content: input.content,
    resolved: input.resolved,
    broken: false,
    state: "confirmed",
    provenance: { actor: "user", via: "seed" },
    publicNotes: "",
    privateNotes: "",
    timeWindow: input.timeWindow ?? null,
    durationMinutes: null,
    reservation: null,
    storedFacts: [],
    alternatives: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneExampleStore(): ExampleStore {
  const cacioCaption = "120g spaghetti. 80g pecorino romano. Lots of black pepper. Pasta water, off the heat, no cream.";
  const dalCaption = "1 cup masoor dal, turmeric, cumin, ghee, lemon.";
  const nataCaption = "Manteigaria, Rua do Loreto. Eat them standing. Cinnamon, not sugar first.";
  const items: ItemCard[] = [
    card({
      id: "cacio",
      source: "instagram",
      title: "Cacio e pepe for two",
      body: "120g spaghetti, pecorino, pepper, pasta water. No cream.",
      author: "pasta.files",
      handle: "@pasta.files",
      url: "https://www.instagram.com/p/cacio/",
      tags: ["food"],
      daysAgo: 0,
    }),
    card({
      id: "dal",
      source: "instagram",
      title: "Red lentil dal, weeknight",
      body: "Masoor, turmeric, ghee, lemon. Twenty-five minutes.",
      author: "weeknight.pot",
      handle: "@weeknight.pot",
      url: "https://www.instagram.com/p/dal/",
      tags: ["food"],
      daysAgo: 1,
    }),
    card({
      id: "nata",
      source: "instagram",
      title: "Pastéis de nata at Manteigaria",
      body: "Still warm. Eat standing up.",
      author: "pasteis.note",
      handle: "@pasteis.note",
      url: "https://www.instagram.com/p/nata/",
      tags: ["food", "travel"],
      daysAgo: 2,
    }),
    card({
      id: "lisbon-yt",
      source: "youtube",
      title: "48 hours in Lisbon",
      body: "Alfama morning, tram 28, Time Out Market, then west.",
      author: "Walks with Nia",
      handle: "Walks with Nia",
      url: "https://www.youtube.com/watch?v=lisbon48",
      tags: ["travel"],
      daysAgo: 3,
    }),
    card({
      id: "sintra",
      source: "reddit",
      title: "Quiet loop above Sintra",
      body: "4.2 km · granite · cork oak · one fountain.",
      author: "ridgehour",
      handle: "u/ridgehour",
      url: "https://www.reddit.com/r/solotravel/comments/sintra/",
      tags: ["travel"],
      daysAgo: 4,
    }),
    card({
      id: "bertrand",
      source: "instagram",
      title: "Livraria Bertrand",
      body: "Oldest operating bookstore. Chiado. Go early.",
      author: "shelf.cities",
      handle: "@shelf.cities",
      url: "https://www.instagram.com/p/bertrand/",
      tags: ["travel"],
      daysAgo: 5,
    }),
    card({
      id: "timeout",
      source: "reddit",
      title: "Time Out Market is a trap after 7",
      body: "Go at 11. After work it is a queue with branded tiles.",
      author: "lisbonfood",
      handle: "u/lisbonfood",
      url: "https://www.reddit.com/r/lisbon/comments/timeout/",
      tags: ["travel", "food"],
      daysAgo: 6,
    }),
    card({
      id: "walking",
      source: "x",
      title: "The case for walking meetings",
      body: "The best notes happen between blocks. A 20-minute loop beats another sit-down.",
      author: "slowoffice",
      handle: "@slowoffice",
      url: "https://x.com/slowoffice/status/walking",
      tags: ["books"],
      daysAgo: 7,
    }),
    card({
      id: "agents-read",
      source: "x",
      title: "How coding agents read your code",
      body: "Retrieval-shaped code, signposting, and why clever abstractions cost tokens.",
      author: "modemdev",
      handle: "@modemdev",
      url: "https://x.com/modemdev/status/agents-read",
      tags: ["books"],
      daysAgo: 8,
    }),
    card({
      id: "human-loop",
      source: "x",
      title: "The human is the loop",
      body: "Stay the decision-maker while agents multiply around you.",
      author: "loop",
      handle: "@loop",
      url: "https://x.com/loop/status/human-loop",
      tags: ["books"],
      daysAgo: 9,
    }),
    card({
      id: "columbia",
      source: "instagram",
      title: "Sunday on Columbia Road",
      body: "Cut flowers, coffee, walk home along the canal.",
      author: "east.market",
      handle: "@east.market",
      url: "https://www.instagram.com/p/columbia/",
      tags: ["travel"],
      daysAgo: 10,
    }),
    card({
      id: "courtyard",
      source: "instagram",
      title: "This courtyard cafe",
      body: "No name in the caption. Tile, shade, one orange tree.",
      author: "somewhere.tables",
      handle: "@somewhere.tables",
      url: "https://www.instagram.com/p/courtyard/",
      tags: ["travel"],
      daysAgo: 4,
    }),
  ];

  const cacioRecipe = recipe({
    id: "recipe-cacio",
    itemId: "cacio",
    status: "reviewed",
    title: "Cacio e pepe for two",
    caption: cacioCaption,
    servings: "2",
    totalTime: "20 min",
    ingredients: [
      { id: "cacio-ing-1", raw: "120g spaghetti", name: "spaghetti", quantity: "120", unit: "g" },
      { id: "cacio-ing-2", raw: "80g pecorino romano", name: "pecorino romano", quantity: "80", unit: "g" },
      { id: "cacio-ing-3", raw: "black pepper", name: "black pepper" },
      { id: "cacio-ing-4", raw: "pasta water", name: "pasta water" },
    ],
    steps: [
      { id: "cacio-st-1", instruction: "Boil in well-salted water.", ingredientIds: ["cacio-ing-1"] },
      { id: "cacio-st-2", instruction: "Emulsify pecorino off the heat with pasta water.", ingredientIds: ["cacio-ing-2", "cacio-ing-4"] },
      { id: "cacio-st-3", instruction: "Finish with pepper.", ingredientIds: ["cacio-ing-3"] },
    ],
  });
  const dalRecipe = recipe({
    id: "recipe-dal",
    itemId: "dal",
    status: "draft",
    title: "Red lentil dal, weeknight",
    caption: dalCaption,
    servings: "4",
    totalTime: "25 min",
    ingredients: [
      { id: "dal-ing-1", raw: "1 cup masoor dal", name: "masoor dal", quantity: "1", unit: "cup" },
      { id: "dal-ing-2", raw: "turmeric", name: "turmeric" },
      { id: "dal-ing-3", raw: "ghee", name: "ghee" },
      { id: "dal-ing-4", raw: "lemon", name: "lemon" },
    ],
    steps: [
      { id: "dal-st-1", instruction: "Simmer dal with turmeric until soft.", ingredientIds: ["dal-ing-1", "dal-ing-2"] },
      { id: "dal-st-2", instruction: "Finish with ghee and lemon.", ingredientIds: ["dal-ing-3", "dal-ing-4"] },
    ],
  });

  const london = place("place-london", "London", "city");
  const lisbon = place("place-lisbon", "Lisbon", "city");
  const sintra = place("place-sintra", "Sintra", "town", "place-lisbon");

  const fri = "day-fri";
  const sat = "day-sat";
  const trip: TripDocument = {
    id: "lisbon",
    libraryId: "example",
    title: "48 hours in Lisbon",
    destination: "Lisbon",
    timezone: "Europe/Lisbon",
    startDate: "2026-05-16",
    endDate: "2026-05-18",
    durationDays: 3,
    travelers: null,
    context: EMPTY_CONTEXT,
    inferences: [],
    revision: 4,
    archivedAt: null,
    days: [
      {
        id: fri,
        position: 0,
        date: "2026-05-16",
        label: "Friday 16 May",
        theme: null,
        stops: [
          stop({
            id: "stop-alfama",
            dayId: fri,
            position: 0,
            timeWindow: "09:30",
            content: { kind: "item", itemId: "lisbon-yt" },
            resolved: { kind: "item", title: "48 hours in Lisbon", source: "youtube", url: "https://www.youtube.com/watch?v=lisbon48" },
          }),
          stop({
            id: "stop-tram",
            dayId: fri,
            position: 1,
            timeWindow: "11:00",
            content: { kind: "outside", title: "Tram 28", notes: null, url: null },
            resolved: null,
          }),
          stop({
            id: "stop-timeout",
            dayId: fri,
            position: 2,
            timeWindow: "13:00",
            content: { kind: "item", itemId: "timeout" },
            resolved: { kind: "item", title: "Time Out Market is a trap after 7", source: "reddit", url: "https://www.reddit.com/r/lisbon/comments/timeout/" },
          }),
        ],
      },
      {
        id: sat,
        position: 1,
        date: "2026-05-17",
        label: "Saturday 17 May",
        theme: null,
        stops: [
          stop({
            id: "stop-belem",
            dayId: sat,
            position: 0,
            timeWindow: "09:00",
            content: { kind: "item", itemId: "nata" },
            resolved: { kind: "item", title: "Pastéis de nata at Manteigaria", source: "instagram", url: "https://www.instagram.com/p/nata/" },
          }),
          stop({
            id: "stop-dinner",
            dayId: sat,
            position: 1,
            content: { kind: "hole", request: "dinner" },
            resolved: null,
          }),
        ],
      },
    ],
    unscheduled: [
      stop({
        id: "stop-bertrand",
        dayId: null,
        position: 0,
        content: { kind: "item", itemId: "bertrand" },
        resolved: { kind: "item", title: "Livraria Bertrand", source: "instagram", url: "https://www.instagram.com/p/bertrand/" },
      }),
      stop({
        id: "stop-sintra",
        dayId: null,
        position: 1,
        content: { kind: "item", itemId: "sintra" },
        resolved: { kind: "item", title: "Quiet loop above Sintra", source: "reddit", url: "https://www.reddit.com/r/solotravel/comments/sintra/" },
      }),
    ],
    advisories: [],
    createdAt: "2026-03-12T12:00:00.000Z",
    updatedAt: "2026-03-12T12:00:00.000Z",
  };

  return structuredClone({
    items,
    meta: {
      cacio: { food: true, caption: cacioCaption, recipe: cacioRecipe, placeId: null, atlas: false, reading: null },
      dal: { food: true, caption: dalCaption, recipe: dalRecipe, placeId: null, atlas: false, reading: null },
      nata: { food: true, caption: nataCaption, recipe: null, placeId: "place-lisbon", atlas: true, reading: null },
      "lisbon-yt": { food: false, caption: null, recipe: null, placeId: null, atlas: false, reading: null },
      sintra: { food: false, caption: null, recipe: null, placeId: "place-sintra", atlas: true, reading: null },
      bertrand: { food: false, caption: null, recipe: null, placeId: "place-lisbon", atlas: true, reading: null },
      timeout: { food: true, caption: null, recipe: null, placeId: "place-lisbon", atlas: true, reading: null },
      walking: {
        food: false,
        caption: null,
        recipe: null,
        placeId: null,
        atlas: false,
        reading: { minutes: 12, pub: "slowoffice", state: "unread" },
      },
      "agents-read": {
        food: false,
        caption: null,
        recipe: null,
        placeId: null,
        atlas: false,
        reading: { minutes: 18, pub: "modem.dev", state: "unread" },
      },
      "human-loop": {
        food: false,
        caption: null,
        recipe: null,
        placeId: null,
        atlas: false,
        reading: { minutes: 9, pub: "brentfitzgerald.com", state: "finished" },
      },
      columbia: { food: false, caption: null, recipe: null, placeId: "place-london", atlas: true, reading: null },
      courtyard: { food: false, caption: null, recipe: null, placeId: null, atlas: true, reading: null },
    },
    places: [london, lisbon, sintra],
    homePlaceId: "place-london",
    tonight: [],
    tonightRevision: 1,
    tonightMutationId: null,
    trips: [trip],
    readingUndo: null,
  });
}
