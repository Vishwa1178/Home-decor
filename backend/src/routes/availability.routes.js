"use strict";

const { Router } = require("express");
const asyncHandler = require("../utils/asyncHandler");
const availabilityController = require("../controllers/availability.controller");

const router = Router();

router.get("/", asyncHandler(availabilityController.getAvailability));

module.exports = router;
