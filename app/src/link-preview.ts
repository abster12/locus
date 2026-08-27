import { useEffect, useState } from "react";
import { api, type LinkPreview } from "./api.ts";
import { hostOf } from "./item-content.ts";

export function usefulPreview(p: LinkPreview, url: string): boolean {
  if (p.status !== "ok" || !(p.title || p.description)) return false;
  const t = (p.title || "").trim().toLowerCase();
  return t !== hostOf(url) && t !== "reddit" && t !== "instagram" && t !== "x" && t !== "youtube";
}

export function useLinkPreview(url: string | null): { preview: LinkPreview | null; done: boolean } {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [done, setDone] = useState(!url);
  useEffect(() => {
    if (!url) {
      setPreview(null);
      setDone(true);
      return;
    }
    let alive = true;
    setDone(false);
    setPreview(null);
    api.linkPreview(url)
      .then((r) => {
        if (alive) setPreview(r.preview);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setDone(true);
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return { preview, done };
}
