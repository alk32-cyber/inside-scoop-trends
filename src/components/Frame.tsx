"use client";
import { usePathname } from "next/navigation";
import { Nav } from "./Nav";

/** The home page is a full-screen app; every other page gets the simple header and footer. */
export function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  if (path === "/") return <>{children}</>;
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/">
          <img className="brand-mark" src="/logo.png" alt="" width={34} height={34} />
          <span>
            <span className="brand-name">Inside Scoop</span>
            <span className="brand-sub"> · Topic Finder</span>
          </span>
        </a>
        <Nav />
      </header>
      {children}
      <footer className="footer">Topics come from public news feeds and link to the original articles. Times shown are relative to now.</footer>
    </div>
  );
}
