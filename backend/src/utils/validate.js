"use strict";

const { ValidationError, zodIssues } = require("./errors");

// Parses `data` with a zod schema or throws the API's standard 400.
function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) throw new ValidationError(zodIssues(result.error));
  return result.data;
}

module.exports = { parse };
