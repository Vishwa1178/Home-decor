"use strict";

require("dotenv").config();

const app = require("./app");
const { env } = require("./config/env");
const logger = require("./utils/logger");

const port = env.PORT;

const server = app.listen(port, () => {
  logger.info(`Home Decor API listening on port ${port} (${env.NODE_ENV})`);
});

function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
});
