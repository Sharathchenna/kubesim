// Serves the static export (out/) the way a static host would, for the E2E tests.
const root = `${import.meta.dir}/../out`;
const port = Number(process.env.PORT ?? 4173);

Bun.serve({
  port,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    for (const candidate of [path, `${path}/index.html`, `${path}.html`, `${path}index.html`]) {
      const f = Bun.file(`${root}${candidate}`);
      if (candidate.includes("..")) break;
      if (await f.exists()) return new Response(f);
    }
    return new Response(Bun.file(`${root}/404.html`), { status: 404 });
  },
});
console.log(`serving out/ on http://localhost:${port}`);
