'use strict';

module.exports = function stripTransformersNodeImportMeta(source) {
  const replacements = [
    {
      expression: 'const _import_meta_url = import.meta.url;',
      replacement: 'const _import_meta_url = undefined;',
    },
    {
      expression:
        '} else if (typeof import.meta !== "undefined" && import.meta.url) {\n    baseURL = import.meta.url;\n  } else {',
      replacement: '} else {',
    },
  ];

  let output = source;
  for (const { expression, replacement } of replacements) {
    const matches = output.split(expression).length - 1;
    if (matches !== 1) {
      throw new Error(
        `Expected one ${expression} expression in Transformers.js, found ${matches}. Review the dependency upgrade.`,
      );
    }
    output = output.replace(expression, replacement);
  }
  return output;
};
