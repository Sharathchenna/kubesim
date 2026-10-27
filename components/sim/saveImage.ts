"use client";

// Saves the Cluster View as a PNG, for posting what you built. The diagram is styled by CSS classes,
// which an SVG drawn as an image can't see, so the styles that matter are copied inline first.

const PROPS = ["fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "letter-spacing", "text-anchor", "dominant-baseline", "display", "visibility", "transform", "transform-origin"];
const SCALE = 2;
const PAD = 32;
const FOOTER = 44;

/** Draws the Cluster View in `root` to a PNG and downloads it. */
export async function saveClusterImage(root: ParentNode, file = "kubesim-cluster.png"): Promise<void> {
  const svg = root.querySelector<SVGSVGElement>('svg[aria-label="Cluster diagram"]');
  const scene = svg?.querySelector<SVGGElement>(":scope > g");
  if (!svg || !scene) throw new Error("No cluster on screen.");

  // The scene in its own units, whatever the current pan and zoom.
  const box = scene.getBBox();
  const clone = scene.cloneNode(true) as SVGGElement;
  inlineStyles(scene, clone);
  clone.removeAttribute("transform");
  clone.style.transform = "";
  clone.style.transition = "";
  // Animations don't run in an image: drop the moving parts, keep the wires and numbers.
  clone.querySelectorAll("animate, animateMotion, .cv-signal, .cv-packet, .cv-ripple").forEach((n) => n.remove());

  const w = Math.ceil(box.width + PAD * 2);
  const h = Math.ceil(box.height + PAD * 2);
  const out = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  out.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  out.setAttribute("viewBox", `${box.x - PAD} ${box.y - PAD} ${w} ${h}`);
  out.setAttribute("width", String(w * SCALE));
  out.setAttribute("height", String(h * SCALE));
  out.appendChild(clone);

  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(out)], { type: "image/svg+xml" }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("The browser couldn't draw the diagram."));
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w * SCALE;
    canvas.height = (h + FOOTER) * SCALE;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#f6f7f9";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    // A footer that says where it came from.
    ctx.fillStyle = "#326ce5";
    ctx.fillRect(0, h * SCALE, canvas.width, FOOTER * SCALE);
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${15 * SCALE}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText("kubesim", 20 * SCALE, (h + FOOTER / 2) * SCALE);
    ctx.font = `400 ${13 * SCALE}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(`a Kubernetes cluster in your browser · ${location.host}`, canvas.width - 20 * SCALE, (h + FOOTER / 2) * SCALE);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("The browser couldn't make the image.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(png);
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Copies the computed styles that change how the diagram looks onto the clone, element by element. */
function inlineStyles(src: Element, dst: Element) {
  const cs = getComputedStyle(src);
  const style = PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
  dst.setAttribute("style", style);
  const a = src.children;
  const b = dst.children;
  for (let i = 0; i < a.length; i++) if (b[i]) inlineStyles(a[i], b[i]);
}
