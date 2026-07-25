// OpenTelemetry instrumentation wrappers for the three critical SLA boundaries:
//   1. Stripe real-time auth webhook (strict 2s window)
//   2. 1Shot Public Relayer on-chain settlement
//   3. Venice AI NL->CardTerms compiler
//
// Also exports the application's business metrics (Meter) and structured-log
// helpers for agent refusals.
//
// Every span carries the resource attributes set by otel.ts (service.name =
// glasspay-server) so SigNoz can filter by service.

import { trace, context, SpanStatusCode, metrics } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

// ---------------------------------------------------------------------------
// Tracers
// ---------------------------------------------------------------------------

const tracer = trace.getTracer("glasspay-server");

// ---------------------------------------------------------------------------
// Meter + business metrics
// ---------------------------------------------------------------------------

const meter = metrics.getMeter("glasspay-financial");

/** Counter: incremented each time a 1Shot redemption or fiat settlement
 *  is confirmed on-chain. Attributes: { network, kind, token } */
export const usdcSpentCounter = meter.createCounter("glasspay.usdc_spent_total", {
  description: "Total USDC spent through confirmed redemptions",
  unit: "atoms",
});

/** UpDownCounter: +1 when a card is issued, -1 when revoked/nuked.
 *  Attributes: { kind, user_id, card_type } */
export const activeCardsGauge = meter.createUpDownCounter("glasspay.active_cards", {
  description: "Number of currently active (non-revoked) cards",
  unit: "1",
});

// ---------------------------------------------------------------------------
// 1. Stripe real-time auth webhook (strict 2s SLA)
// ---------------------------------------------------------------------------

/**
 * Wrap the Stripe issuing_authorization.request handler in a traced span.
 * Call at the top of the webhook handler; the span auto-ends when the
 * returned object's `end()` is called (or when the response is sent).
 *
 * Attributes set:
 *   stripe.charge_id   — the Stripe authorization id
 *   card_id            — the resolved GlassPay card id
 *   latency_critical   — always true (2s SLA)
 *   approved           — the boolean decision
 */
export function startStripeWebhookSpan(authId: string, cardId: string | null) {
  const span = tracer.startSpan("stripe_webhook_auth", {
    attributes: {
      "stripe.charge_id": authId,
      "card_id": cardId ?? "unknown",
      "latency_critical": true,
    },
  });
  return context.with(trace.setSpan(context.active(), span), () => span);
}

/**
 * Record the webhook decision on the current span and end it.
 */
export function endStripeWebhookSpan(span: ReturnType<typeof startStripeWebhookSpan>, approved: boolean) {
  span.setAttribute("approved", approved);
  span.end();
}

/**
 * Record an error on the current Stripe span.
 */
export function recordStripeWebhookError(span: ReturnType<typeof startStripeWebhookSpan>, error: Error) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.recordException(error);
  span.end();
}

// ---------------------------------------------------------------------------
// 2. 1Shot Public Relayer (on-chain settlement)
// ---------------------------------------------------------------------------

/**
 * Wrap a relayer API call in a traced span.
 * Use before calling relayer.estimate(), relayer.send(), or relayer.getStatus().
 *
 * Attributes set:
 *   relayer.method      — estimate | send | getStatus | getFeeData
 *   chain_id            — e.g. "8453" (Base mainnet)
 *   card_id             — the card driving this redemption
 *   usdc_amount         — the spend amount in USDC decimal string
 *   smart_account_address — the root delegator's address
 */
export function startRelayerSpan(
  method: string,
  attrs: {
    chainId: number;
    cardId?: string;
    usdcAmount?: string;
    smartAccountAddress?: string;
  },
) {
  const span = tracer.startSpan(`1shot_relayer_${method}`, {
    attributes: {
      "relayer.method": method,
      "chain_id": String(attrs.chainId),
      "card_id": attrs.cardId ?? "unknown",
      "usdc_amount": attrs.usdcAmount ?? "0",
      "smart_account_address": attrs.smartAccountAddress ?? "unknown",
    },
  });
  return context.with(trace.setSpan(context.active(), span), () => span);
}

/**
 * End a relayer span successfully.
 */
export function endRelayerSpan(span: ReturnType<typeof startRelayerSpan>, attrs?: Record<string, string | number | boolean>) {
  if (attrs) span.setAttributes(attrs);
  span.end();
}

/**
 * Record a relayer error on the span and set ERROR status.
 */
export function recordRelayerError(span: ReturnType<typeof startRelayerSpan>, error: Error) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.recordException(error);
  span.end();
}

// ---------------------------------------------------------------------------
// 3. Venice AI NL Compiler
// ---------------------------------------------------------------------------

/**
 * Wrap a Venice AI chat completions call in a traced span.
 *
 * Attributes set:
 *   venice.model_id          — the model used (e.g. "qwen3-235b-a22b-instruct-2507")
 *   venice.prompt_tokens     — token count from the response (set via addVeniceTokenCounts)
 *   venice.completion_tokens — completion token count
 */
export function startVeniceSpan(modelId?: string) {
  const span = tracer.startSpan("venice_nl_compile", {
    attributes: {
      "model_id": modelId ?? process.env.VENICE_MODEL ?? "unknown",
      "prompt_tokens": 0,
      "completion_tokens": 0,
    },
  });
  return context.with(trace.setSpan(context.active(), span), () => span);
}

/**
 * Set the token-count attributes on a running Venice span.
 */
export function addVeniceTokenCounts(
  span: ReturnType<typeof startVeniceSpan>,
  promptTokens: number,
  completionTokens: number,
) {
  span.setAttribute("prompt_tokens", promptTokens);
  span.setAttribute("completion_tokens", completionTokens);
}

/**
 * End a Venice span successfully.
 */
export function endVeniceSpan(span: ReturnType<typeof startVeniceSpan>) {
  span.end();
}

/**
 * Record a Venice error and end the span.
 */
export function recordVeniceError(span: ReturnType<typeof startVeniceSpan>, error: Error) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.recordException(error);
  span.end();
}

// ---------------------------------------------------------------------------
// 4. Structured logging for agent refusals
// ---------------------------------------------------------------------------

const logger = logs.getLogger("glasspay-server", "0.17.2");

/**
 * Emit a structured log entry every time the engine returns a typed
 * refusal to an agent. Each log carries:
 *   log.severityNumber = WARN
 *   card_id            — the card that triggered the refusal
 *   refusal_reason     — the typed refusal code
 *   attempted_amount   — the USDC amount (decimal string) the agent tried to spend
 *   message            — the human-readable explanation
 *
 * These logs show up in SigNoz under the "glasspay-server" service and
 * can be filtered by `refusal_reason` or `card_id` for debugging agent
 * behavior over time.
 */
export function logAgentRefusal(
  attrs: {
    cardId: string;
    refusalReason: string;
    attemptedAmount?: string;
    message: string;
  },
) {
  logger.emit({
    severityNumber: SeverityNumber.WARN,
    severityText: "WARN",
    body: `agent refusal: ${attrs.refusalReason} — ${attrs.message}`,
    attributes: {
      "card_id": attrs.cardId,
      "refusal_reason": attrs.refusalReason,
      "attempted_amount": attrs.attemptedAmount ?? "0",
    },
  });
}
