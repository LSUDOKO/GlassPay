import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("remit", "0.1.0");

export const usdcSpentTotal = meter.createCounter("remit.usdc_spent_total", {
  description: "Total USDC spent across all confirmed redemptions and fiat settlements",
});

export const activeCards = meter.createUpDownCounter("remit.active_cards", {
  description: "Number of currently active (issued minus revoked) cards",
});
