export default [
  {
    ignores: ["node_modules"],

    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module"
    },

    linterOptions: {
      reportUnusedDisableDirectives: true
    },

    rules: {
      "no-unused-vars": "warn",
      "semi": ["error", "always"],
      "quotes": "off"
    }
  }
];