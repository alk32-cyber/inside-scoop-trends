import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Frame } from "@/components/Frame";

export const metadata: Metadata = {
  title: "Inside Scoop Topic Finder",
  description: "Trending-topic intelligence for the Inside Scoop podcast: what is gaining attention, why, and how to cover it.",
};

export const viewport: Viewport = { themeColor: "#0b0c0e" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Frame>{children}</Frame>
      </body>
    </html>
  );
}
