"use strict";

const adminBookings = require("../services/adminBookings.service");
const audit = require("../services/audit.service");
const { parse } = require("../utils/validate");
const schemas = require("../schemas/admin.schema");

const noStore = (res) => res.set("Cache-Control", "no-store");

exports.stats = async (_req, res) => noStore(res).json(await adminBookings.getStats());

exports.list = async (req, res) => noStore(res).json(await adminBookings.listBookings(parse(schemas.listBookingsQuery, req.query)));

exports.get = async (req, res) => noStore(res).json(await adminBookings.getBooking(parse(schemas.idParam, req.params.id)));

exports.setStatus = async (req, res) => {
  const id = parse(schemas.idParam, req.params.id);
  const body = parse(schemas.statusBody, req.body ?? {});
  noStore(res).json(await adminBookings.changeStatus(id, body, audit.contextFrom(req)));
};

exports.reschedule = async (req, res) => {
  const id = parse(schemas.idParam, req.params.id);
  const body = parse(schemas.rescheduleBody, req.body ?? {});
  noStore(res).json(await adminBookings.rescheduleBooking(id, body, audit.contextFrom(req)));
};

exports.auditLog = async (req, res) => noStore(res).json(await audit.listAudit(parse(schemas.auditQuery, req.query)));
