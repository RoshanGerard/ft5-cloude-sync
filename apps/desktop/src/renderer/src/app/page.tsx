"use client";

import { useEffect, useState } from "react";

export default function PingPage() {
  const [ts, setTs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.ping().then((response) => {
      if (!cancelled) {
        setTs(response.ts);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <main>{ts == null ? "Pinging…" : String(ts)}</main>;
}
