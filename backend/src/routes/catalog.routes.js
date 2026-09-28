"use strict";

const { Router } = require("express");
const asyncHandler = require("../utils/asyncHandler");
const catalogController = require("../controllers/catalog.controller");

const router = Router();

router.get("/", asyncHandler(catalogController.listPackages));
router.get("/:id", asyncHandler(catalogController.getPackage));

module.exports = router;
