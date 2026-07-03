"use strict";

const { Router } = require("express");
const healthRoutes = require("./health.routes");
const bookingRoutes = require("./bookings.routes");

const router = Router();

router.get("/", (_req, res) => {
  res.json({
    name: "home-decor-api",
    status: "ok",
    docs: "/health",
  });
});

router.use("/health", healthRoutes);
router.use("/api/bookings", bookingRoutes);

module.exports = router;
