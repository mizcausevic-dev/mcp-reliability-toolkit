import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
  resolve: {
    // Tests import via `../src/foo.js` (NodeNext ESM convention). Strip the .js
    // suffix at resolution time so vitest can find the .ts source.
    extensions: [".ts", ".js"],
    alias: [
      { find: /^(\.\.\/src\/.*)\.js$/, replacement: "$1.ts" },
    ],
  },
});
