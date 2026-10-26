"use client";
import { usePathname } from "next/navigation";

export function Nav() {
  const path = usePathname();
  const link = (href: string, label: string) => (
    <a href={href} aria-current={(href === "/" ? path === "/" || path.startsWith("/topics") : path.startsWith(href)) ? "page" : undefined}>
      {label}
    </a>
  );
  return (
    <nav className="nav" aria-label="Main">
      {link("/", "Topics")}
      {link("/advanced", "Nerd view")}
    </nav>
  );
}
