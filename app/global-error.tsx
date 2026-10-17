"use client";

// Last-resort error page, used when the root layout itself fails. It renders
// its own document, so it can't rely on the app's styles.

export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f7f8fa", color: "#0f172a" }}>
        <title>Something went wrong · kubesim</title>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "20vh 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: 28, margin: 0 }}>kubesim hit a bug and stopped</h1>
          <p style={{ color: "#475569", lineHeight: 1.6 }}>Nothing you did caused this. Reload the page to try again.</p>
          <button onClick={() => retry()} style={{ marginTop: 16, height: 40, padding: "0 16px", borderRadius: 12, border: 0, background: "#0f172a", color: "#fff", fontSize: 14, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
