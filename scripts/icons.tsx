// Regenerates the site's icons and social card from the kubesim hexagon logo:
//   app/favicon.ico            16/32/48 px PNGs in an ICO
//   public/apple-touch-icon.png 180 px, white background
//   public/og.png              1200×630 social card (OpenGraph / Twitter)
// Run: bun scripts/icons.tsx   (static PNGs, so any static host serves them with the right type)

import { ImageResponse } from "next/og";

const SITE_NAME = "kubesim";
const root = `${import.meta.dir}/..`;

const Hexagon = ({ size }: { size: number }) => (
  <svg viewBox="0 0 28 28" width={size} height={size}>
    <path d="M14 2.5l10 5.75v11.5L14 25.5 4 19.75V8.25L14 2.5z" fill="#0f172a" />
    <path d="M14 8l5.2 3v6L14 20l-5.2-3v-6L14 8z" fill="none" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
  </svg>
);

const png = async (el: React.ReactElement, width: number, height: number) => new Uint8Array(await new ImageResponse(el, { width, height }).arrayBuffer());

async function favicon() {
  const sizes = [16, 32, 48];
  const imgs = await Promise.all(sizes.map((s) => png(<div style={{ width: s, height: s, display: "flex" }}><Hexagon size={s} /></div>, s, s)));
  const header = new Uint8Array(6 + 16 * sizes.length);
  const dv = new DataView(header.buffer);
  dv.setUint16(2, 1, true);
  dv.setUint16(4, sizes.length, true);
  let off = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    header[e] = s;
    header[e + 1] = s;
    dv.setUint16(e + 4, 1, true);
    dv.setUint16(e + 6, 32, true);
    dv.setUint32(e + 8, imgs[i].length, true);
    dv.setUint32(e + 12, off, true);
    off += imgs[i].length;
  });
  await Bun.write(`${root}/app/favicon.ico`, new Blob([header, ...imgs]));
}

const POD = (x: number, y: number, fill: string) => <div key={`${x}-${y}`} style={{ position: "absolute", left: x, top: y, width: 64, height: 40, borderRadius: 10, background: fill, display: "flex" }} />;

function openGraph() {
  return png(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#f7f8fa", padding: 72, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 620 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <Hexagon size={64} />
            <div style={{ fontSize: 44, fontWeight: 700, color: "#0f172a" }}>{SITE_NAME}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 68, lineHeight: 1.05, fontWeight: 700, color: "#0f172a" }}>Learn Kubernetes in your browser.</div>
            <div style={{ marginTop: 24, fontSize: 30, lineHeight: 1.35, color: "#475569" }}>A simulated cluster you can break, fix and watch. Lessons, challenges, practice exams. Nothing to install.</div>
          </div>
        </div>
        <div style={{ position: "relative", display: "flex", marginLeft: 48, width: 380, height: 486 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ position: "absolute", left: 0, top: i * 162, width: 380, height: 140, borderRadius: 22, background: "#ffffff", border: "2px solid #e2e8f0", display: "flex" }} />
          ))}
          {[POD(24, 64, "#3b82f6"), POD(108, 64, "#14b8a6"), POD(24, 226, "#3b82f6"), POD(108, 226, "#3b82f6"), POD(192, 226, "#ef4444"), POD(24, 388, "#14b8a6")]}
        </div>
      </div>
    ),
    1200,
    630,
  );
}

await favicon();
await Bun.write(
  `${root}/public/apple-touch-icon.png`,
  await png(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#ffffff" }}><Hexagon size={132} /></div>, 180, 180),
);
await Bun.write(`${root}/public/og.png`, await openGraph());
console.log("wrote app/favicon.ico, public/apple-touch-icon.png, public/og.png");
