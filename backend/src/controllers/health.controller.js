"use strict";

const { env } = require("../config/env");

exports.getHealth = (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
    service: "home-decor-api",
  });
};
