import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

export function useProse(scope: "item" | "day" | "collection", scopeRef: string) {
  const [prose, setProse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    setProse(null);
    setError(null);
    setBusy(false);
  }, [scope, scopeRef]);

  const generate = async () => {
    const request = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.prose(scope, scopeRef);
      if (request === requestId.current) setProse(result.prose.prose);
    } catch (cause) {
      if (request === requestId.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestId.current) setBusy(false);
    }
  };

  return { prose, error, busy, generate };
}
