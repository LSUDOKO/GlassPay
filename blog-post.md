# I Gave an AI Agent Its Own Credit Card, Then Instrumented Everything With OpenTelemetry and SigNoz

Two months ago I was staring at a Stripe webhook that had 2 seconds to reply — and I had no idea why it kept timing out. The webhook was authorizing Visa transactions for an AI agent that spends money on behalf of users. When it failed, the agent's payment got declined at the POS terminal. The user saw "card declined" on their phone. The agent saw nothing. And my logs were useless: just "timeout" with zero context about which hop in the pipeline had stalled.

This is the story of how I fixed that by wiring the whole thing — every HTTP call, every on-chain settlement, every LLM prompt — to a self-hosted SigNoz instance. Along the way I learned that observability for agentic systems is not the same as observability for normal web apps.

## What We Built

GlassPay is an "agentic spending card" platform. The idea: you create a card, set spending rules in plain English ("$500/week on SaaS tools, nothing on weekends"), and hand the card URL to an AI agent. The agent spends money through the card — it pays APIs, buys compute, settles subscriptions — and the smart contract enforces your budget on-chain.

The stack is a Hono TypeScript server with a smart contract engine that compiles natural-language rules into on-chain delegation policies. Three critical external hops sit between "agent wants to spend $20" and "the money moves":

1. **Venice AI** — turns natural language intent into structured card terms (it's an LLM call)
2. **Stripe Issuing** — authorizes the fiat Visa transaction (2-second hard deadline)
3. **1Shot relayer** — settles the corresponding USDC on-chain

Each of these can fail in different ways, and failures compound because they're sequential. If the relayer is slow, the Stripe auth still succeeds — now you have a fiat charge with no corresponding USDC settlement. That's a reconciliation problem that's worse than a timeout.

## The Problem With Normal Logging

Before OTel, we had `console.log` statements and a JSON file. Every time an agent got a "card declined" response, I'd ssh into the box, grep the logs for that card ID, and try to piece together the timeline manually. Was the LLM slow? Was the Stripe webhook slow? Did the relayer fail silently?

I couldn't answer any of those questions from logs alone. Logs tell you *what* happened at a single point. They don't tell you *how long* things took, or *which path* a request took through the system. And they certainly don't correlate across services: the Venice AI call, the Stripe webhook, and the on-chain relayer are three completely separate systems.

## Where OTel Comes In

We installed `@opentelemetry/sdk-node` with `getNodeAutoInstrumentations` and exported everything via OTLP/HTTP to SigNoz. The SDK is initialized via Bun's `--preload` flag so it starts before any application code loads:

```typescript
// otel.ts — loaded via bun --preload ./src/otel.ts
const sdk = new NodeSDK({
  serviceName: "glasspay-server",
  instrumentations: [getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-dns": { enabled: false },
    "@opentelemetry/instrumentation-fs": { enabled: false },
  })],
});
await sdk.start();
```

The `--preload` trick was something I figured out after the first attempt failed. If you import OTel *after* Hono, the auto-instrumentation misses the Hono routes because they're already registered. Bun runs the preload file before anything else in the bundle, so the SDK wraps every HTTP handler from the start.

### Tracing the Three Critical Hops

We added three custom spans, one for each SLA boundary:

```
stripe_webhook_auth  —  Stripe sends us an auth request; we must reply in <2s
1shot_relayer_redeem —  Sends the USDC relayer tx; can fail if gas is too low
venice_nl_compile    —  Calls Venice AI chat completions; token usage matters
```

The Stripe span turned out to be the most valuable one. The 2-second deadline means if this span shows up as >1800ms, we know the authorization will fail before Stripe even tells us. Here's what it looks like in practice:

```typescript
// stripe/routes.ts — the webhook handler
const tracer = trace.getTracer("glasspay-server");
const span = tracer.startSpan("stripe_webhook_auth", {
  attributes: {
    "stripe.charge_id": chargeId,
    "card_id": cardId,
    "latency_critical": true,
  },
});
try {
  const result = await handleAuthorization(charge);
  span.setStatus({ code: SpanStatusCode.OK });
  return result;
} catch (e) {
  span.recordException(e);
  span.setStatus({ code: SpanStatusCode.ERROR });
  throw e;
} finally {
  span.end();
}
```

Before this span I would see `ETIMEDOUT` in the Stripe dashboard with zero server-side context. Now in SigNoz I can click on a failed trace, see that the Stripe span took 1950ms, and know the bottleneck was in the DB query right before the response — not in the Stripe API itself.

### Metrics: Five Counters for a Financial Health Dashboard

We emit five custom metrics from the engine package:

```typescript
const meter = metrics.getMeter("glasspay-engine");

export const usdcSpentTotal = meter.createCounter("glasspay.usdc_spent_total");
export const activeCards = meter.createUpDownCounter("glasspay.active_cards");
export const cardsIssuedTotal = meter.createCounter("glasspay.cards_issued_total");
export const errorsTotal = meter.createCounter("glasspay.errors_total");
export const chargesTotal = meter.createCounter("glasspay.charges_total");
```

A gotcha I hit: **metric names with dots vs underscores**. ClickHouse (SigNoz's storage) stores metric names as strings. If you query `signoz_metrics.distributed_samples_v2` and filter by `metric_name = 'glasspay.usdc_spent_total'`, the dot is just a character — no special treatment. But if you accidentally name a metric `glasspay_usdc_spent_total` in one place and query for `glasspay.usdc_spent_total` in the dashboard, you get zero results and it looks like the app is broken. I wasted an hour on this.

The dashboard panels are raw SQL against ClickHouse:

```sql
SELECT toStartOfInterval(toDateTime(intDiv(timestamp, 1000000000)), INTERVAL 5 MINUTE) AS ts,
       sum(value) AS usdc
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'glasspay.usdc_spent_total'
  AND temporality = 'Cumulative'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts ORDER BY ts
```

This runs in a SigNoz dashboard panel called "USDC Spent Over Time." I can see spikes when a particular agent is running heavy workloads, dips on weekends (most agents are configured to not spend on weekends), and flatline at zero when something is broken.

### Structured Logs: What Normal Logging Should Always Be

The most useful thing we did was log every time the engine refuses a spend. An AI agent tries to buy something, the smart contract says "nope — you've hit your $500/week limit on SaaS," and we emit:

```json
{
  "severityText": "WARN",
  "severityNumber": 13,
  "body": "Refusal: over_period_limit for card 550e8400-e29b-...",
  "attributes": {
    "card_id": "550e8400-e29b-...",
    "refusal_reason": "over_period_limit",
    "attempted_amount": "50.00"
  }
}
```

There are 17 refusal points in `spend.ts`. Each one emits a log before throwing the error. In SigNoz Logs Explorer I have a saved view called "Last 50 Refusals" that filters by `severityText=WARN`. I can click any refusal, see its `trace_id`, and jump to the full distributed trace: the HTTP request, the Venice LLM call that compiled the intent, the validation loop, and the refusal.

This is the killer feature: **logs carry the trace_id**. You don't have to guess which log line corresponds to which request. They're already linked.

We also log card lifecycle events: `issued`, `frozen`, `revoked`, `nuked`, `onboarded`, `secret_rotated`. Each is a structured log with `card_event` as a filterable attribute. If a user reports their card stopped working, I filter by `card_id`, sort by timestamp, and see exactly when it was frozen or revoked, and by which operation.

### The MCP Server Twist

Here's something I didn't expect to be useful. SigNoz ships an MCP server that exposes `signoz_*` tools to AI agents. We deployed it in our `casting.yaml` alongside ClickHouse and the frontend.

The recursion is a bit heady: **the same agents that spend money through GlassPay can query their own observability data through the SigNoz MCP server**. An agent that gets a "card declined" error can ask "show me my last 5 refusal logs" and get a structured answer about *why* it was declined — without a human logging into the dashboard.

I'm still figuring out where this pattern breaks down (what happens when the agent's MCP query goes to a service that's also being observed, and it creates an infinite observability loop?), but for now it's a neat trick.

## What I'd Do Differently

1. **Start with OTel, don't add it later.** We built most of the app before adding instrumentation. Instrumenting *after* the fact means you miss events, you have to refactor error handling to include spans, and you find places where the trace context silently dies (e.g., background job schedulers that don't forward parent span IDs).

2. **Don't instrument DNS and filesystem.** The auto-instrumentation package enables a bunch of instrumentations by default. `dns` and `fs` are noisy as hell — every file read and DNS lookup becomes a span. I disabled them immediately.

3. **The preload pattern matters.** If you're using Bun, use `--preload` for OTel init. If you're on Node.js, use `--require` or `--import`. If you initialize OTel in the same file as your HTTP server import, you'll miss early spans and the auto-instrumentation may not catch all routes.

4. **SigNoz Foundry works but needs Docker running.** The `foundryctl cast` command is clean — one file, one command — but it pulls 5 containers and ClickHouse needs ~4GB RAM. On a dev machine with Docker Desktop this is fine. On a Railway free tier? Not happening. Use SigNoz Cloud for small deployments.

## Self-Hosted Deployment

The `casting.yaml` spins up ClickHouse, the OTel Collector, Query Service, Frontend (port 3301), and the MCP Server (port 8000). That's it:

```yaml
# casting.yaml
mode: docker
flavor: compose
services:
  clickhouse:
    image: clickhouse/clickhouse-server:24.12
  otel-collector:
    image: signoz/signoz-otel-collector:0.119.3
  query-service:
    image: signoz/query-service:0.81.0
  frontend:
    image: signoz/frontend:0.81.0
  signoz-mcp-server:
    image: signoz/mcp-server:latest
```

GlassPay exports telemetry to `http://localhost:4318` by default. To switch to SigNoz Cloud, I set two env vars: `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` with the ingestion key. The SDK passes headers to all exporters automatically — traces, metrics, and logs all go through the same OTLP pipeline.

## The Real Win

Before OTel and SigNoz, debugging an agent spend failure looked like:

1. User reports "my card didn't work"
2. I grep logs for that card ID
3. I find a timeout with no further context
4. I guess which service was slow
5. I add more logging
6. Wait for it to happen again

Now it looks like:

1. User reports "my card didn't work"
2. I open the SigNoz traces view, filter by `card_id`
3. I see the full trace: HTTP request → Venice LLM compilation → validation → Stripe auth → relayer submission
4. I spot the slow hop immediately (usually the Stripe webhook)
5. I open the correlated log and see the refusal reason
6. Fixed in 2 minutes

That's the difference observability makes. Not more data — correlated data that tells a story.

---

*GlassPay is open source. The SigNoz deployment config is in `casting.yaml` at the project root. If you're building agentic payment systems or just want to see how OTel works with Bun + Hono, the code is at [github.com/remit/glasspay](https://github.com/remit/glasspay).*
