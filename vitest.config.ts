import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      "tests/**/*.test.ts",
      "web/tests/**/*.test.ts",
      "web/tests/**/*.test.tsx",
    ],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    reporters: ["default"],
  },
});
