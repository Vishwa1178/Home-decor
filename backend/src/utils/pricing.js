"use strict";

const { PAYMENT_OPTIONS, PAYMENT_STATUSES, CURRENCY } = require("../constants/payment");

// The ONLY place payment amounts are calculated. Whole rupees, integer maths.
// `totalAmount` is the package price from the catalog, never a client value.
//
//   HALF: requiredAmount = ceil(total / 2)   (Rs. 10,000 -> 5,000; Rs. 999 -> 500)
//   FULL: requiredAmount = total
//   remainingAmount = total - required       (the balance left after the required payment)
//
// Razorpay works in paise: multiply these by 100 when that is integrated.
function calculateAmounts({ totalAmount, paymentOption }) {
  if (!Number.isInteger(totalAmount) || totalAmount < 1) {
    throw new TypeError("totalAmount must be a positive integer");
  }
  if (!PAYMENT_OPTIONS.includes(paymentOption)) {
    throw new TypeError(`paymentOption must be one of ${PAYMENT_OPTIONS.join(", ")}`);
  }
  const requiredAmount = paymentOption === "FULL" ? totalAmount : Math.ceil(totalAmount / 2);
  return { totalAmount, requiredAmount, remainingAmount: totalAmount - requiredAmount };
}

// Both options for one price, computed here so the storefront only displays numbers.
function quotesFor(totalAmount) {
  return Object.fromEntries(PAYMENT_OPTIONS.map((paymentOption) => [paymentOption, calculateAmounts({ totalAmount, paymentOption })]));
}

// The payment part of a new booking. Nothing has been paid and no provider order
// exists yet, so the razorpay* fields are explicitly null.
function initialPayment({ totalAmount, paymentOption, paymentMethod }) {
  return {
    paymentOption,
    paymentMethod,
    paymentStatus: PAYMENT_STATUSES[0], // PENDING
    currency: CURRENCY,
    ...calculateAmounts({ totalAmount, paymentOption }),
    paidAmount: 0,
    razorpayOrderId: null,
    razorpayPaymentId: null,
    razorpaySignature: null,
  };
}

module.exports = { calculateAmounts, quotesFor, initialPayment };
