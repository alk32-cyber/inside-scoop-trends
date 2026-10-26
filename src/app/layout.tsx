import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Inside Scoop Topic Finder",
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
                <span className="brand-sub"> · Topic Finder</span>
              </span>
            </a>
            <Nav />
          </header>
          {children}
          <footer className="footer">
            Topics come from public news feeds and link to the original articles. Times shown are relative to now.
          </footer>
        </div>
      </body>
    </html>
  );
}
