import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "coverage", ".next"],
  },
  ...tseslint.configs.recommended,
);
