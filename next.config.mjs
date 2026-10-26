/** @type {import('next').NextConfig} */
const nextConfig = {
  // PGlite ships WASM and must not be bundled into server chunks.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  // Files read at runtime that the bundler cannot discover on its own.
  outputFileTracingIncludes: {
    "/**": ["./db/migrations/**", "./demo/**", "./config/**", "./node_modules/@electric-sql/pglite/dist/**"],
  },
  poweredByHeader: false,
};
export default nextConfig;
