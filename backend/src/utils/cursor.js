"use strict";

const crypto = require("node:crypto");
const { AppError } = require("./errors");

// Opaque pagination cursors: { id: <last document id>, h: <hash of the query> } as
// base64url JSON. Binding the cursor to a hash of the query means a cursor from one
// search/filter/sort cannot be replayed against another (which would silently skip or
// repeat rows); it is an integrity check, not a security boundary (only admins page).

const hashQuery = (query) => {
  const canonical = JSON.stringify(Object.keys(query).sort().map((k) => [k, query[k] ?? null]));
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
};

const encodeCursor = (id, query) => Buffer.from(JSON.stringify({ id, h: hashQuery(query) })).toString("base64url");

const invalid = () => new AppError(400, "INVALID_CURSOR", "The pagination cursor is invalid or does not belong to this query. Start again from the first page.");

// Returns the document id the next page starts after.
function decodeCursor(cursor, query) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed.id !== "string" || !parsed.id || typeof parsed.h !== "string" || parsed.h !== hashQuery(query)) throw invalid();
  return parsed.id;
}

module.exports = { encodeCursor, decodeCursor, hashQuery };
