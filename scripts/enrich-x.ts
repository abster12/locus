import { openDb } from "../db/open.ts";
import { enrichXItems } from "../server/enrich.ts";

const n = await enrichXItems(openDb());
console.log(`enriched ${n}`);
