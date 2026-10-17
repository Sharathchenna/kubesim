"use client";

// Boots the home page's live cluster only when it scrolls into view, and pauses it when it scrolls away.

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const TryIt = dynamic(() => import("./TryIt"), { ssr: false, loading: () => <Placeholder /> });

/** Boots the cluster when the section first comes near the screen, and only runs its clock while it's visible. */

function Placeholder() {
  return <div className="grid h-full place-items-center text-[13px] text-slate-500">Starting a cluster…</div>;
}

export function TryItSection() {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        setVisible(e.isIntersecting);
        if (e.isIntersecting) setOn(true);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="h-[420px] md:h-[640px] lg:h-[520px]">
      {on ? <TryIt active={visible} /> : <Placeholder />}
    </div>
  );
}
