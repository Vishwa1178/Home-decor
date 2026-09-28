"use strict";

const adminCatalog = require("../services/adminCatalog.service");
const audit = require("../services/audit.service");
const { parse } = require("../utils/validate");
const schemas = require("../schemas/admin.schema");

exports.list = async (_req, res) => res.set("Cache-Control", "no-store").json(await adminCatalog.listCatalog());

exports.create = async (req, res) => {
  const body = parse(schemas.createPackageBody, req.body ?? {});
  res.set("Cache-Control", "no-store").status(201).json(await adminCatalog.createPackage(body, audit.contextFrom(req)));
};

exports.update = async (req, res) => {
  const id = parse(schemas.idParam, req.params.id);
  const body = parse(schemas.updatePackageBody, req.body ?? {});
  res.set("Cache-Control", "no-store").json(await adminCatalog.updatePackage(id, body, audit.contextFrom(req)));
};
