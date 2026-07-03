"use strict";

module.exports = function notFound(req, res, next) {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.originalUrl} does not exist`,
  });
};
