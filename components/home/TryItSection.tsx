"use client";

// Boots the home page's live cluster only when it scrolls into view, and pauses it when it scrolls away.

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { TryItSkeleton } from "./TryItSkeleton";

const TryIt = dynamic(() => import("./TryIt"), { ssr: false, loading: () => <Placeholder /> });

/** Boots the cluster when the section first comes near the screen, and only runs its clock while it's visible. */

const Placeholder = TryItSkeleton;

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
    <div ref={ref} className="h-[560px] md:h-[720px] lg:h-[760px]">
      {on ? <TryIt active={visible} /> : <Placeholder />}
    </div>
  );
}
