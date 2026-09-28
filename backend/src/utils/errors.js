"use strict";

// Errors that are safe to show to API clients. Anything else is treated as an
// unexpected failure and reported as a generic 500.
class AppError extends Error {
  constructor(status, code, message, issues, { retryAfter } = {}) {
    super(message);
    this.retryAfter = retryAfter; // seconds; sent as a Retry-After header
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.expose = true;
  }
}

class ValidationError extends AppError {
  constructor(issues, message = "Request validation failed") {
    super(400, "VALIDATION_ERROR", message, issues);
    this.name = "ValidationError";
  }
}

// zod issues -> [{ field, message }]
function zodIssues(zodError) {
  return zodError.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message }));
}

module.exports = { AppError, ValidationError, zodIssues };
