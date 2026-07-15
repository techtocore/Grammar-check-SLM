'use strict';

module.exports = function stripOnnxBuildPath(source) {
  const replacements = [
    {
      expression: 'w=import.meta.url,T=""',
      replacement: 'w=globalThis.location?.href??"",T=""',
    },
    {
      expression: 'return import.meta.url}},ge=',
      replacement: 'return globalThis.location?.href??""}},ge=',
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
  return output;
};
