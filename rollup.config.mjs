import dts from "rollup-plugin-dts";

const config = [
  {
    input: "build/es6/groovr.js",
    external: ["@1pizzateam/spock"],
    output: {
      file: "build/groovr.mjs",
      format: "es",
      generatedCode: "es2015",
    },
  },
  {
    input: "build/es6/groovr.d.ts",
    output: {
      file: "build/groovr.d.mts",
      format: "es",
    },
    plugins: [dts()],
  },
];

export default config;
