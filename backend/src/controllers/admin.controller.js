"use strict";

// Only reachable through requireAuth + requireAdmin, so req.user is a verified
// token whose `admin` claim is true. Values below come from the verified token.
exports.getMe = (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    uid: req.user.uid,
    email: req.user.email || null,
    admin: true,
  });
};
