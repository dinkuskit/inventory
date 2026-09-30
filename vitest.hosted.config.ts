import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.hosted.jsonc" } })], test: { include: ["tests/hosted-runtime/**/*.test.mjs"], maxWorkers: 1 } });
