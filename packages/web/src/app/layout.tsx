import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

// Public-facing metadata is deliberately generic (no protocol keywords) — this
// dashboard is private research tooling, not something to surface in search.
export const metadata: Metadata = {
  title: "lattice",
  description: "Internal analytics dashboard.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
