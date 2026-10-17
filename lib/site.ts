// The site's public identity, in one place. Set NEXT_PUBLIC_SITE_URL at build
// time to the production origin (no trailing slash); canonical URLs, the
// sitemap, robots.txt and social cards are all built from it.

import type { Metadata } from "next";

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://kubesim.vercel.app").replace(/\/+$/, "");
export const SITE_NAME = "kubesim";
export const SITE_TITLE = "kubesim · learn Kubernetes in your browser";
export const SITE_DESCRIPTION = "A simulated Kubernetes cluster you can break, fix and watch, running entirely in your browser. Free, open source, nothing to install.";
export const THEME_COLOR = "#0f172a";
/** Social card (public/og.png, made by scripts/icons.tsx). */
export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "kubesim: a simulated Kubernetes cluster that runs in your browser" };

/** Per-page metadata: title, description, canonical URL and social cards that all agree. `path` is the route with its trailing slash. */
export function pageMetadata({ path, title, description = SITE_DESCRIPTION, noindex = false }: { path: string; title: string; description?: string; noindex?: boolean }): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: SITE_NAME, url: path, title, description, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE.url] },
    ...(noindex ? { robots: { index: false, follow: true } } : {}),
  };
}
