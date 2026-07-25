import { logs } from "@opentelemetry/api-logs";
import { metrics } from "@opentelemetry/api";

const logger = logs.getLogger("glasspay-engine");
const meter = metrics.getMeter("glasspay-engine");

export const usdcSpentTotal = meter.createCounter("glasspay.usdc_spent_total", {
  description: "Total USDC spent across all confirmed redemptions and fiat settlements",
});

export const activeCards = meter.createUpDownCounter("glasspay.active_cards", {
  description: "Number of currently active (issued minus revoked) cards",
});

export function emitRefusalLog(cardId: string, refusalReason: string, attemptedAmount: string): void {
  logger.emit({
    severityNumber: 13,
    severityText: "WARN",
    body: `Refusal: ${refusalReason} for card ${cardId}`,
    attributes: { card_id: cardId, refusal_reason: refusalReason, attempted_amount: attemptedAmount },
  });
}
