import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0f172a",
};

export const metadata: Metadata = {
  title: "PayNGo POS",
  description: "Point-of-sale checkout for smart shelf stores.",
};

const STALE_CHUNK_SNIPPET = `
(function () {
  function isStaleChunkError(msg) {
    if (!msg) return false;
    return (
      msg.indexOf("reading 'call'") !== -1 ||
      msg.indexOf("is not a function") !== -1 ||
      msg.indexOf("ChunkLoadError") !== -1 ||
      msg.indexOf("Loading chunk") !== -1 ||
      msg.indexOf("Cannot find module") !== -1
    );
  }
  function reloadOnce() {
    if (window.sessionStorage.getItem("payngo-reloaded")) return;
    window.sessionStorage.setItem("payngo-reloaded", "1");
    window.location.reload();
  }
  window.addEventListener("error", function (e) {
    if (isStaleChunkError(e.message)) reloadOnce();
  });
  window.addEventListener("unhandledrejection", function (e) {
    if (e && e.reason && isStaleChunkError(String(e.reason.message || e.reason))) reloadOnce();
  });
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: STALE_CHUNK_SNIPPET }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
