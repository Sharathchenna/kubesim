"use client";

// Boots the home page's live cluster only when it scrolls into view.

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const TryIt = dynamic(() => import("./TryIt"), { ssr: false, loading: () => <Placeholder /> });

function Placeholder() {
  return <div className="grid h-full place-items-center text-[13px] text-slate-400">Starting a cluster…</div>;
}

export function TryItSection() {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        setOn(true);
        io.disconnect();
      }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="h-[420px] md:h-[640px] lg:h-[520px]">
      {on ? <TryIt /> : <Placeholder />}
    </div>
  );
}
