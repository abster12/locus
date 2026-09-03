import { Worker } from "node:worker_threads";
import type { ExtractedPage } from "./extract-page.ts";

export { extractPage, qualifiesAsReadable, type ExtractedPage } from "./extract-page.ts";

export async function extractPageBounded(
  html: string,
  finalUrl: string,
  fallbackTitle: string | null,
  timeoutMs = 2_000,
): Promise<ExtractedPage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract-task.ts", import.meta.url), {
      workerData: { html, finalUrl, fallbackTitle },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("reading extraction timed out"));
    }, timeoutMs);
    worker.once("message", (message: { ok: boolean; value?: ExtractedPage; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.ok && message.value) resolve(message.value);
      else reject(new Error(message.error || "reading extraction failed"));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
