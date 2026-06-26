/** @type {import('next').NextConfig} */
const nextConfig = {
  // Compile the workspace types/helpers package from source (no build step).
  transpilePackages: ["@orchestrator/shared"],
};

export default nextConfig;
