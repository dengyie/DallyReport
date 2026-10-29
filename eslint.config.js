import globals from "globals";

export default [
  {
    // node_modules/reports-cache are belt-and-braces. The two ai-daily entries
    // are a guard, not dead config: unreachable under the current `npm run
    // lint` globs, but if those globs are ever widened, the workflow template
    // and the generated product (top-level `return`, non-Node realm) must NOT
    // be linted — ai-daily is gated by its own build.mjs --check-only + tests.
    ignores: [
      "node_modules/**",
      "reports-cache/**",
      "ai-daily/.claude/workflows/**",
      "ai-daily/scripts/ai-daily/ai-daily.template.js",
      "**/*.min.js",
    ],
  },
  {
    files: ["src/**/*.mjs", "test/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        WebSocket: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
];
