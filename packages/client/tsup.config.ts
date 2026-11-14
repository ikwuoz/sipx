import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    pi: "src/pi.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ["@near402/protocol"],
  external: [
    "near-api-js",
    "@noble/curves",
    "@noble/hashes",
  ],
});
