export interface PlaceHit {
  place: string;
  region: string;
}

export interface Region {
  name: string;
  slug: string;
  color: string;
  ink: string;
  motif: string;
}

export const REGIONS: Region[] = [
  { name: "Japan", slug: "japan", color: "#c8352e", ink: "#f2f3f0", motif: "torii" },
  { name: "Spain", slug: "spain", color: "#d9a419", ink: "#17191b", motif: "arch" },
  { name: "India", slug: "india", color: "#3a4fb5", ink: "#f2f3f0", motif: "peaks" },
  { name: "Sri Lanka", slug: "srilanka", color: "#1e7a5f", ink: "#f2f3f0", motif: "palms" },
  { name: "Southeast Asia & beyond", slug: "sea", color: "#6d4a9c", ink: "#f2f3f0", motif: "boat" },
];

const JAPAN = "Japan";
const SPAIN = "Spain";
const INDIA = "India";
const SRI = "Sri Lanka";
const SEA = "Southeast Asia & beyond";

// Longer names first so "Sri Lanka" wins over a later one-word overlap.
const PLACES: [string, string][] = [
  ["Universal Studios Japan", JAPAN],
  ["Himachal Pradesh", INDIA],
  ["Jim Corbett", INDIA],
  ["Parc Güell", SPAIN],
  ["Parc Guell", SPAIN],
  ["New York City", SEA],
  ["Andalusía", SPAIN],
  ["Andalusia", SPAIN],
  ["Dharamshala", INDIA],
  ["Uttarakhand", INDIA],
  ["Bengaluru", INDIA],
  ["Bangalore", INDIA],
  ["Rishikesh", INDIA],
  ["Sri Lanka", SRI],
  ["Srilanka", SRI],
  ["Barcelona", SPAIN],
  ["Fatehpur", INDIA],
  ["Himachal", INDIA],
  ["Andaman", INDIA],
  ["Kashmir", INDIA],
  ["Colombo", SRI],
  ["Da Nang", SEA],
  ["Danang", SEA],
  ["New York", SEA],
  ["Portugal", SEA],
  ["Philippines", SEA],
  ["Singapore", SEA],
  ["Indonesia", SEA],
  ["Malaysia", SEA],
  ["Thailand", SEA],
  ["Vietnam", SEA],
  ["Hanoi", SEA],
  ["Lisbon", SEA],
  ["London", SEA],
  ["Europe", SEA],
  ["Mumbai", INDIA],
  ["Kerala", INDIA],
  ["Ladakh", INDIA],
  ["Delhi", INDIA],
  ["Tokyo", JAPAN],
  ["Osaka", JAPAN],
  ["Kyoto", JAPAN],
  ["Japan", JAPAN],
  ["Spain", SPAIN],
  ["India", INDIA],
  ["Ella", SRI],
  ["Goa", INDIA],
  ["USJ", JAPAN],
  ["Bali", SEA],
  ["Dubai", SEA],
  ["Nepal", SEA],
  ["Paris", SEA],
  ["Porto", SEA],
  ["USA", SEA],
];

const COMPILED = PLACES.map(([place, region]) => {
  const esc = place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
  return { place, region, re: new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu") };
});

export function detectPlaces(title: string | null, body: string | null): PlaceHit[] {
  const text = `${title ?? ""} ${body ?? ""}`;
  if (!text.trim()) return [];
  const hits: PlaceHit[] = [];
  const seen = new Set<string>();
  for (const row of COMPILED) {
    if (seen.has(row.place) || !row.re.test(text)) continue;
    seen.add(row.place);
    hits.push({ place: row.place, region: row.region });
  }
  return hits;
}

export function regionByName(name: string): Region | undefined {
  return REGIONS.find((r) => r.name === name);
}
