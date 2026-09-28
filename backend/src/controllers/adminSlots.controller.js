"use strict";

const adminSlots = require("../services/adminSlots.service");
const audit = require("../services/audit.service");
const { parse } = require("../utils/validate");
const schemas = require("../schemas/admin.schema");

const noStore = (res) => res.set("Cache-Control", "no-store");

exports.list = async (_req, res) => noStore(res).json(await adminSlots.listSlots());

exports.create = async (req, res) => {
  const body = parse(schemas.createSlotBody, req.body ?? {});
  noStore(res).status(201).json(await adminSlots.createSlot(body, audit.contextFrom(req)));
};

exports.update = async (req, res) => {
  const id = parse(schemas.idParam, req.params.id);
  const body = parse(schemas.updateSlotBody, req.body ?? {});
  noStore(res).json(await adminSlots.updateSlot(id, body, audit.contextFrom(req)));
};

exports.occupancy = async (req, res) => noStore(res).json(await adminSlots.occupancy(parse(schemas.rangeQuery, req.query)));

exports.listBlocked = async (req, res) => noStore(res).json(await adminSlots.listBlockedDates(parse(schemas.rangeQuery, req.query)));

exports.block = async (req, res) => {
  const date = parse(schemas.dateParam, req.params.date);
  const body = parse(schemas.blockBody, req.body ?? {});
  noStore(res).json(await adminSlots.blockDate(date, body, audit.contextFrom(req)));
};

exports.unblock = async (req, res) => {
  const date = parse(schemas.dateParam, req.params.date);
  noStore(res).json(await adminSlots.unblockDate(date, audit.contextFrom(req)));
};
