import globals from "globals";

export default [
  {
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
