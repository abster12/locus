import { parentPort, workerData } from "node:worker_threads";
import { extractPage } from "./extract.ts";

const input = workerData as { html: string; finalUrl: string; fallbackTitle: string | null };
try {
  parentPort?.postMessage({ ok: true, value: extractPage(input.html, input.finalUrl, input.fallbackTitle) });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
