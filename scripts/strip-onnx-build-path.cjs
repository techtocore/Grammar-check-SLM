'use strict';

module.exports = function stripOnnxBuildPath(source) {
  const replacements = [
    {
      expression: 'w=import.meta.url,S=""',
      replacement: 'w=globalThis.location?.href??"",S=""',
    },
    {
      expression: 'return import.meta.url}},ye=',
      replacement: 'return globalThis.location?.href??""}},ye=',
    },
    {
      expression: 'new URL(import.meta.url)',
      replacement: 'new URL("ort.webgpu.bundle.min.mjs",import.meta.url)',
    },
  ];

  let output = source;
  for (const { expression, replacement } of replacements) {
    const matches = output.split(expression).length - 1;
    if (matches !== 1) {
      throw new Error(
        `Expected one ${expression} expression in ONNX Runtime, found ${matches}. Review the dependency upgrade.`,
      );
    }
    output = output.replace(expression, replacement);
  }
  const fileUrlCheck = 'import.meta.url>"file:"&&import.meta.url<"file;"';
  const fileUrlChecks = output.split(fileUrlCheck).length - 1;
  if (fileUrlChecks !== 2) {
    throw new Error(
      `Expected two file URL checks in ONNX Runtime, found ${fileUrlChecks}. Review the dependency upgrade.`,
    );
  }
  output = output.replaceAll(fileUrlCheck, 'globalThis.location?.protocol==="file:"');
  return output;
};
