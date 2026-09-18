import { useCallback, useRef, useState } from "react";

function stableKey(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`)
    .join(",")}}`;
}

export function useRoute<TReq, TRes>(postRoute: (req: TReq) => Promise<TRes>) {
  const [data, setData] = useState<TRes | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const reqId = useRef(0);
  const inFlight = useRef(new Map<string, Promise<TRes>>());
  const fnRef = useRef(postRoute);
  fnRef.current = postRoute;

  const request = useCallback(async (req: TReq): Promise<TRes | undefined> => {
    const key = stableKey(req);
    const existing = inFlight.current.get(key);
    if (existing) return existing;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const p = fnRef
      .current(req)
      .then((res: TRes) => {
        if (id === reqId.current) {
          setData(res);
          setLoading(false);
        }
        return res;
      })
      .catch((e: unknown) => {
        if (id === reqId.current) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
        }
        throw e;
      })
      .finally(() => {
        inFlight.current.delete(key);
      });
    inFlight.current.set(key, p);
    return p;
  }, []);

  return { data, loading, error, request };
}

export default useRoute;
