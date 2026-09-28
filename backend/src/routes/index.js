"use strict";

const { Router } = require("express");
const healthRoutes = require("./health.routes");
const bookingRoutes = require("./bookings.routes");
const adminRoutes = require("./admin.routes");
const catalogRoutes = require("./catalog.routes");
const availabilityRoutes = require("./availability.routes");
const { catalogLimiter, availabilityLimiter, adminLimiter } = require("../middleware/rateLimit");

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
router.use("/api/packages", catalogLimiter, catalogRoutes);
router.use("/api/availability", availabilityLimiter, availabilityRoutes);
router.use("/api/admin", adminLimiter, adminRoutes);

module.exports = router;
