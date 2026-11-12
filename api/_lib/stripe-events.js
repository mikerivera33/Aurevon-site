/**
 * Every event the live Stripe endpoint must be subscribed to (Stripe Dashboard →
 * Webhooks). api/webhooks/stripe.js handles each one, and a test keeps the two in step.
 *
 * Dependency-free on purpose: /api/health imports it without loading the
 * webhook handler's import graph.
 */
export const REQUIRED_STRIPE_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
]);
