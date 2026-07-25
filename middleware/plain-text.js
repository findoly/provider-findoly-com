const EMOJI_PATTERN = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u20E3]/u;
const HTML_CODE_PATTERN = /<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/u;

function validationError(message) {
  return Object.assign(new Error(message), {
    status: 400,
    code: "INVALID_TEXT_CONTENT",
  });
}

function labelFor(path) {
  const label = String(path || "Form field")
    .replace(/\[(\d+)\]/g, " $1")
    .replace(/[._-]+/g, " ")
    .trim();
  return label ? label.replace(/\b\w/g, (character) => character.toUpperCase()) : "Form field";
}

function assertPlainBody(value, path = "", depth = 0) {
  if (depth > 10 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (EMOJI_PATTERN.test(value)) {
      throw validationError(`${labelFor(path)} must not contain emoji`);
    }
    if (HTML_CODE_PATTERN.test(value)) {
      throw validationError(`${labelFor(path)} must not contain HTML tags or encoded HTML`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainBody(item, `${path}[${index + 1}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      if (EMOJI_PATTERN.test(key) || HTML_CODE_PATTERN.test(key)) {
        throw validationError(`${labelFor(path || "Form")} field name is invalid`);
      }
      assertPlainBody(item, path ? `${path}.${key}` : key, depth + 1);
    });
  }
}

function rejectUnsupportedFormText(req, _res, next) {
  try {
    if (req.body && typeof req.body === "object") assertPlainBody(req.body);
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { rejectUnsupportedFormText, assertPlainBody, EMOJI_PATTERN, HTML_CODE_PATTERN };
