/** @type {import('next').NextConfig} */
const nextConfig = {
  // PGlite ships WASM and must not be bundled into server chunks.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  poweredByHeader: false,
};
export default nextConfig;
