import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";

// Keep this integration test isolated from the app's normal development port.
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8791";
const { listen, MAX_IMPORT_BODY_BYTES, MAX_REQUEST_BODY_BYTES } = await import("../server/http/server.ts");

test("HTTP reports malformed JSON, missing Items, and oversized bodies usefully", async () => {
  const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-")), "http.db"));
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;

  try {
    const sessionResponse = await eventually(() => fetch(`${base}/api/session`));
    assert.equal(sessionResponse.status, 200);
    const session = (await sessionResponse.json()) as { csrf: string };
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const headers = {
      cookie,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    };

    const malformed = await fetch(`${base}/api/collections`, {
      method: "POST",
      headers,
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.match(await malformed.text(), /invalid JSON/i);

    const missingItem = await fetch(`${base}/api/items/missing-item/status`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "accepted" }),
    });
    assert.equal(missingItem.status, 404);
    assert.match(await missingItem.text(), /item not found/i);

    const oversizedNormal = await fetch(`${base}/api/collections`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "x".repeat(MAX_REQUEST_BODY_BYTES) }),
    });
    assert.equal(oversizedNormal.status, 413);
    assert.match(await oversizedNormal.text(), /body too large/i);

    const oversizedImport = await postWithDeclaredLength(
      `${base}/api/import/jsonl`,
      MAX_IMPORT_BODY_BYTES + 1,
      headers,
    );
    assert.equal(oversizedImport.status, 413);
    assert.match(await oversizedImport.text(), /body too large/i);
  } finally {
    await app.close();
    database.close();
  }
});

async function eventually(request: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("unreachable");
}

async function postWithDeclaredLength(
  url: string,
  length: number,
  headers: Record<string, string>,
): Promise<{ status: number; text: () => Promise<string> }> {
  // The server must reject from Content-Length before parsing or invoking the
  // importer; a tiny body keeps this regression test fast and memory-safe.
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: { ...headers, "content-length": String(length) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: async () => Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    // Match the declared length so the server can drain and close the request
    // cleanly after returning 413 (without waiting for an incomplete body).
    request.end(Buffer.alloc(length, 32));
  });
}
