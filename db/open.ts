import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateSchema, SCHEMA_SQL } from "./schema.ts";

export type Db = DatabaseSync;

export function locusHome(): string {
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/Locus");
  if (process.platform === "win32") return join(process.env.APPDATA || homedir(), "Locus");
  return join(homedir(), ".local/share/Locus");
}

export function browserProfileDir(source: string, accountId: string): string {
  return join(locusHome(), "browsers", source, accountId);
}

export function openDb(path = join(locusHome(), "locus.db")): Db {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}
