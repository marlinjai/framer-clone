import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  // Never lint build artifacts or generated output. `eslint .` would
  // otherwise pick up the `.next/` bundle (and any out/ build/ coverage
  // output) when lint runs after `next build`, or the `docs-dist/` Clearify
  // docs bundle (minified vendor chunks) after `docs:build`. Both are
  // gitignored generated output.
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "docs-dist/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
