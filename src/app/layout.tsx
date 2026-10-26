import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Inside Scoop Trends",
  description: "Trending-topic intelligence for the Inside Scoop podcast: what is gaining attention, why, and how to cover it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <a className="brand" href="/">
              <span className="brand-mark" aria-hidden="true">IS</span>
              <span>
                <span className="brand-name">Inside Scoop</span>
                <span className="brand-sub"> · Trend Intelligence</span>
              </span>
            </a>
            <Nav />
          </header>
          {children}
          <footer className="footer">
            Scores are computed from measured changes over time. All times are shown in UTC. Search interest is a relative 0–100 index, not search volume.
          </footer>
        </div>
      </body>
    </html>
  );
}
