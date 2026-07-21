import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // The parent repo has its own package-lock.json; pin the tracing root so
  // Next does not infer the parent directory as the workspace root.
  outputFileTracingRoot: path.join(process.cwd())
};

export default withNextIntl(nextConfig);
