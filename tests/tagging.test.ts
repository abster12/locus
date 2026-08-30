import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeClassifications, parseClassifications, parseTags } from "../optional/tagging/pi.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { oauthAccess, preferOpencodeModel } from "../optional/summaries/pi/index.ts";

const ids = new Set(["a", "b"]);

test("parseTags keeps only known ids and clean tags", () => {
  const out = parseTags(
    'Some prose {"tags":{"a":["Tech","ai","tech","travel"],"b":["food"],"evil":["x"]}} trailing',
    ids,
  );
  assert.deepEqual(out, { a: ["tech", "ai", "travel"], b: ["food"] });
});

test("preferOpencodeModel injects deepseek-v4-flash when the catalog is stale", () => {
  const out = preferOpencodeModel([
    { provider: "opencode-go", id: "kimi-k2.5", name: "Kimi" },
    { provider: "xai", id: "grok-4" },
  ]);
  assert.equal(out[0]?.id, "deepseek-v4-flash");
  assert.equal(out[0]?.provider, "opencode-go");
  assert.equal(out.some((m) => m.id === "kimi-k2.5"), true);
  const zen = preferOpencodeModel([{ provider: "opencode", id: "gpt-5" }]);
  assert.equal(zen.some((m) => m.id === "deepseek-v4-flash"), false);
});

test("oauthAccess uses a live token and ignores expired ones", () => {
  assert.equal(oauthAccess({ type: "oauth", access: "tok", expires: Date.now() + 60_000 }), "tok");
  assert.equal(oauthAccess({ type: "oauth", access: "tok", expires: Date.now() - 1 }), undefined);
  assert.equal(oauthAccess({ type: "api_key" }), undefined);
});

test("parseTags rejects junk", () => {
  assert.deepEqual(parseTags("no json here", ids), {});
  assert.deepEqual(parseTags('{"tags":{"a":["<script>", "ok-tag", ""]}}', ids), { a: ["ok-tag"] });
  assert.deepEqual(parseTags('{"tags":"nope"}', ids), {});
});

test("parseClassifications validates a batched topic and Atlas screen response", () => {
  const out = parseClassifications(
    'prefix {"items":{"a":{"tags":["Food","food","bad/tag"],"atlasCandidate":true},"b":{"tags":[],"atlasCandidate":false},"evil":{"tags":["tech"],"atlasCandidate":true}}} suffix',
    ids,
  );
  assert.deepEqual(out, {
    a: { tags: ["food"], atlasCandidate: true },
    b: { tags: [], atlasCandidate: false },
  });
  assert.deepEqual(parseClassifications('{"items":{"a":{"tags":["food"]}}}', ids), {});
});

test("classification batches require one bounded corrective retry for missing ids", () => {
  const initial = parseClassifications('{"items":{"a":{"tags":["food"],"atlasCandidate":true}}}', ids);
  const retry = parseClassifications('{"items":{"b":{"tags":["travel"],"atlasCandidate":false}}}', new Set(["b"]));
  assert.throws(() => mergeClassifications(initial, {}, ids), RejectedPayload);
  assert.deepEqual(mergeClassifications(initial, retry, ids), {
    a: { tags: ["food"], atlasCandidate: true },
    b: { tags: ["travel"], atlasCandidate: false },
  });
});
