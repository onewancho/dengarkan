"use client";

// ============================================
// DENGARKAN — Global Error Boundary (/global-error)
// Completely independent root-level error boundary.
// Wraps its own <html> and <body> without any external context/providers.
// ============================================

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="id">
      <body
        style={{
          backgroundColor: "#0b0b0c",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          fontFamily: "sans-serif",
          margin: 0,
          padding: "1rem",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: "400px" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "0.5rem" }}>
            Terjadi kesalahan fatal
          </h2>
          {error?.digest && (
            <p style={{ fontSize: "0.75rem", color: "#8E8E93", marginBottom: "1rem" }}>
              Kode: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: "0.5rem",
              padding: "0.625rem 1.25rem",
              borderRadius: "12px",
              background: "#39FF14",
              color: "#000",
              fontWeight: "bold",
              border: "none",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            Coba Lagi
          </button>
        </div>
      </body>
    </html>
  );
}
