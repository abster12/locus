import assert from "node:assert/strict";
import { test } from "node:test";
import { publicHttpUrl, ReadingFetchError } from "../src/reading-fetch.ts";

test("publicHttpUrl rejects private, local, and credentialed targets", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://localhost/article",
    "http://10.0.0.4/internal",
    "http://192.168.1.9/page",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "ftp://example.com/file",
    "https://user:pass@example.com/secret",
  ];
  for (const url of blocked) {
    assert.throws(() => publicHttpUrl(url), (error: unknown) => {
      assert.ok(error instanceof ReadingFetchError, url);
      assert.equal(error.code, "unsafe_target", url);
      return true;
    });
  }
});

test("publicHttpUrl accepts ordinary https articles", () => {
  const parsed = publicHttpUrl("https://example.com/essays/one");
  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.hostname, "example.com");
  assert.equal(parsed.pathname, "/essays/one");
});
