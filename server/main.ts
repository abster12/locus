import { openDb } from "../db/open.ts";
import { listen } from "./http/server.ts";

const db = openDb();
const { port } = listen(db);
console.info(`Locus desk: http://127.0.0.1:${port}`);
