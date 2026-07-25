# GlassPay

**The agentic card — fully instrumented with OpenTelemetry + SigNoz.**

[![SigNoz Hackathon](https://img.shields.io/badge/SigNoz-Hackathon-3021ff)](https://signoz.io)
[![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-Instrumented-3021ff)](https://opentelemetry.io)
[![Base Mainnet](https://img.shields.io/badge/Base-Mainnet-0052FF)](https://base.org)
[![ERC-7710](https://img.shields.io/badge/ERC-7710-blue)](https://eips.ethereum.org/EIPS/eip-7710)

Issue scoped, revocable spending cards from your wallet. Any agent plugs one in and pays within your limits. No keys, no gas, dead the moment you revoke.

Built on MetaMask Smart Accounts (ERC-7710), settled gaslessly by 1Shot, pays the open web with x402, plugged into any agent over MCP.

---

## 🔭 SigNoz Hackathon — Full Observability

GlassPay is **fully instrumented with OpenTelemetry** and sends **traces, metrics, and logs** to **SigNoz Cloud** (and can self-host locally via the included `casting.yaml`).

### What's Instrumented

| Category | Signal | What's Tracked | How to See in SigNoz |
|----------|--------|----------------|----------------------|
| 🌐 **API Requests** | Trace | Every HTTP request with route pattern, method, status code, auth info | **Traces** → filter `service.name = glasspay-server` |
| 💳 **Stripe Webhooks** | Trace | Auth decision flow (approve/decline) with decision and card context | **Traces** → search `stripe_webhook_auth` |
| ⛓️ **On-Chain Payments** | Trace | Relayer redemption with USDC amount, gas, tx hash | **Traces** → search `1shot_relayer_redeem` |
| 🤖 **AI Compilation** | Trace | Plain-language card intent → compiled terms, token usage | **Traces** → search `nl_compile` |
| 🔄 **Reconcile Sweep** | Trace | Stuck-pending charge resolution (reconciled/still_pending counts) | **Traces** → search `reconcile_sweep` |
| 💰 **Fiat Settlement** | Trace | Visa→on-chain settlement sweep (settled/left counts) | **Traces** → search `fiat_settle_sweep` |
| 📈 **Cards Issued** | Metric | `glasspay_cards_issued_total` — root + sub-cards across all users | **Metrics** → counter |
| 💵 **USDC Spent** | Metric | `glasspay_usdc_spent_total` — total USDC across all rails | **Metrics** → counter |
| 🔵 **Active Cards** | Metric | `glasspay_active_cards` — live gauge of issued − revoked | **Metrics** → up-down counter |
| 📊 **Charges Processed** | Metric | `glasspay_charges_total` — confirmed + pending + failed charges | **Metrics** → counter |
| ⚠️ **API Errors** | Metric | `glasspay_errors_total` — every 403/422/502/500 response | **Metrics** → counter |
| 📝 **Refusal Logs** | Log | Typed refusals with reason, card_id, attempted_amount | **Logs** → filter `refusal_reason` |
| 💳 **Card Lifecycle** | Log | `issued`, `frozen`, `unfrozen`, `revoked`, `nuked`, `url_revealed`, `secret_rotated`, `onboarded` | **Logs** → filter `card_event` |
| ✅ **Charge Confirmed** | Log | Successful payments with amount, kind, card_id | **Logs** → filter `charge_event = confirmed` |
| ❌ **API Errors** | Log | Every error with operation, status code, route, method | **Logs** → filter `operation` or `error_message` |

### 🎛️ Architecture

```
glasspay-server (Node.js)
  │
  ├─ @opentelemetry/auto-instrumentations-node  (automatic HTTP/fetch/DB spans)
  ├─ Manual instrumentation via trace API       (custom business spans)
  ├─ Metrics via Meter API                      (counters + up-down counters)
  ├─ Logs via Logger API                        (structured card lifecycle events)
  │
  └─ OTLP HTTP exporter (port 4318)
       │
       ▼
  SigNoz Cloud (ingest.us2.signoz.cloud:443)
       │
       ├─ Traces  → distributed tracing waterfall
       ├─ Metrics → dashboard panels + alerts
       └─ Logs    → structured log explorer
```

The OTel SDK is initialized early via Bun `--preload` (`packages/server/src/otel.ts`) so auto-instrumentation wraps every module from boot. The engine package (`packages/engine/src/telemetry.ts`) declares all custom metrics and structured log functions.

### 🔧 Self-Hosted SigNoz (Local Dev)

A `casting.yaml` is included for deploying SigNoz locally with Foundry:

```bash
# Deploy SigNoz stack locally
foundryctl cast -f casting.yaml --locked

# SigNoz UI: http://localhost:3301
# OTLP endpoint: http://localhost:4318
# SigNoz MCP: http://localhost:8000
```

The `casting.yaml.lock` pins every Docker image to its content digest for reproducible deployments.

### 📊 SigNoz Dashboard Panels

Create a GlassPay dashboard in SigNoz with these panels:

#### Panel 1: Cards Issued Over Time (Time Series)
```sql
SELECT toStartOfInterval(toDateTime(intDiv(timestamp, 1000000000)), INTERVAL 5 MINUTE) AS ts,
       sum(value) AS value
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'glasspay_cards_issued_total'
  AND temporality = 'Cumulative'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts
```

#### Panel 2: Active Cards (Value / Gauge)
```sql
SELECT sum(value) AS active_cards
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'glasspay_active_cards'
  AND temporality = 'Cumulative'
  AND timestamp > now() * 1000000000 - 60000000000
```

#### Panel 3: USDC Spent (Time Series)
```sql
SELECT toStartOfInterval(toDateTime(intDiv(timestamp, 1000000000)), INTERVAL 5 MINUTE) AS ts,
       sum(value) AS value
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'glasspay_usdc_spent_total'
  AND temporality = 'Cumulative'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts
```

#### Panel 4: API Errors (Time Series)
```sql
SELECT toStartOfInterval(toDateTime(intDiv(timestamp, 1000000000)), INTERVAL 5 MINUTE) AS ts,
       sum(value) AS errors
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'glasspay_errors_total'
  AND temporality = 'Cumulative'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts
```

#### Panel 5: API Request Duration by Route
```sql
SELECT toStartOfInterval(timestamp, INTERVAL 5 MINUTE) AS ts,
       bodyAttributes['http.route'] AS route,
       avg(durationNano) / 1000000 AS avg_ms
FROM signoz_traces.distributed_signoz_index_v2
WHERE bodyAttributes['service.name'] = 'glasspay-server'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts, route
ORDER BY ts
```

### ⚠️ SigNoz Alerts

Create alerts in SigNoz for these conditions:

| Alert | Condition | Severity |
|-------|-----------|----------|
| High Error Rate | `glasspay_errors_total` rate > 10/min for 5 min | Critical |
| No Cards Issued | `glasspay_cards_issued_total` has no new value for 30 min | Warning |
| High API Latency | P99 HTTP duration > 5000ms for 5 min | Warning |
| Spike in Refusals | Log count with `refusal_reason: *` > 20/min | Warning |

### 🤖 SigNoz MCP Integration

GlassPay includes the SigNoz MCP server for agentic observability workflows:

```bash
# Add the SigNoz MCP server to your AI agent
claude mcp add signoz http://localhost:8000 \
  --header "Authorization: Bearer $SIGNOZ_MCP_AUTH_TOKEN"
```

Your AI agent can then use SigNoz MCP tools to:
- Query traces and logs from GlassPay
- Create and modify dashboards
- Set up and investigate alerts
- Run ClickHouse queries against the observability data

### 🏆 Judge's Checklist

For SigNoz hackathon judges, this repo demonstrates:

1. **Multiple signals** ✅ Traces + Metrics + Logs all flowing to SigNoz
2. **Custom business metrics** ✅ `cards_issued_total`, `usdc_spent_total`, `active_cards`, `charges_total`, `errors_total` — counters that directly map to product KPIs
3. **Structured logs** ✅ Card lifecycle events (`issued`, `frozen`, `revoked`, `nuked`, `onboarded`) with typed attributes
4. **Custom spans** ✅ Business-logic spans (`stripe_webhook_auth`, `1shot_relayer_redeem`, `nl_compile`, `reconcile_sweep`, `fiat_settle_sweep`) with domain attributes
5. **Auto-instrumentation** ✅ HTTP, fetch, DNS, and filesystem spans via `@opentelemetry/auto-instrumentations-node`
6. **Hono middleware** ✅ Route-level span per request with method, path, status code
7. **SigNoz MCP** ✅ Included `signoz-mcp-server` for agentic observability
8. **Reproducible deployment** ✅ `casting.yaml` + `casting.yaml.lock` for `foundryctl cast`

---

## The idea

Agents need to spend money. Handing an agent your private key is insane; funding a standalone agent wallet loses your custody and your limits. GlassPay takes the model the card industry settled on decades ago and applies it to agents:

- **Your wallet is the account.** Funds never leave it until the moment of payment.
- **The card is a delegation.** A scoped ERC-7710 delegation, signed by your wallet, wrapped in caveats: budget per period, per-transaction max, merchant allowlist, expiry, usage count.
- **The agent holds the card, not the money.** What the agent gets is an MCP endpoint URL. Behind it, the card can spend only what its terms allow.
- **Revoke kills it instantly.** Freeze or revoke a card (or its whole sub-card tree) and every payment from it stops, server-side immediately and on-chain underneath.

```
your wallet (EIP-7702 smart account)
   └── card  ($25/week, expires Jul 6)          ← root delegation, signed by you
        ├── agent A plugs it in over MCP
        └── sub-card ($1/week, one merchant)    ← redelegation, narrower terms
             └── sub-agent B plugs it in
```

**Live:**

| Surface | URL |
|---|---|
| Dashboard (issue + manage cards · a fresh sign-in gets a guided welcome, funding step, and live tour) | _deploy your own_ |
| Docs (the full reference, in-app) | _deploy your own_ |
| Demo merchant (accepts the cards' Visas) | _deploy your own_ |
| API + MCP endpoint | _deploy your own_ |
| Source (this repo) | https://github.com/LSUDOKO/GlassPay |
| Demo video | [YouTube](https://youtu.be/ymRo31OBZ8c) |

Everything runs on Base mainnet with real USDC; the only simulated leg is the Visa rail (Stripe test-mode Issuing, labeled honestly wherever it appears).

---

## How a payment actually works

1. You sign in to the dashboard (Privy embedded wallet, Google login) and issue a card with terms, set by hand in the composer or drafted from a plain-language request by the Venice-powered NL compiler (the model only names tokens, protocols, and merchants; the server resolves every address from its own verified registry, and you still review and sign the draft).
2. The dashboard compiles the terms into onchain caveats (delegation-framework enforcers), your wallet signs the delegation in the browser, the server stores it alongside a fresh agent key that holds nothing.
3. You hand the card URL to any agent (one `claude mcp add`, a Cursor deeplink, a pasted connector URL).
4. When the agent calls `pay`, the server validates the terms, then redeems the delegation through the 1Shot relayer: gasless, on Base mainnet, settled in USDC from your wallet.
5. Every charge lands in the card's ledger with memo, fee, and tx hash.

The agent never sees a private key, never holds a balance, never needs ETH. The first spend even deploys your wallet's 7702 smart-account code automatically in the same transaction.

## What an agent can do with a card

MCP tools, served over Streamable HTTP. The exact set a card exposes matches its capabilities, so the tool list itself is the permission surface (a pay-only card never sees `execute`; a contract-only card never sees `pay`):

| Tool | Purpose |
|---|---|
| `card` | Live state: remaining budget, terms, expiry, recent charges, sub-cards |
| `pay` | Send USDC on Base within the card's limits; blocks until confirmed on-chain |
| `paid_fetch` | Fetch a URL; on HTTP 402 (x402), pay automatically and return the content |
| `fiat_pay` | Buy over Visa rails (simulated: Stripe test-mode Issuing) against the same budget; with settlement on, the receipt carries the on-chain tx |
| `card_credentials` | Reveal the card's test-mode virtual Visa (number/expiry/cvc) so the agent can check out at a merchant; every card auto-links one on first need |
| `execute` | Run scoped contract calls (e.g. approve + swap, stake, mint) atomically in one redemption; only on cards with contract scope |
| `issue_subcard` | Mint a tighter child card for a sub-agent; pay caps and contract scope must both nest inside the parent's |
| `revoke_subcard` | Instantly kill a sub-card (and its descendants), server-side; for on-chain permanence, revoke the root card or nuke |

Refusals are typed (`over_period_limit`, `merchant_not_allowed`, `price_exceeds_max`, `per_trade_exceeded`, `exceeds_parent_terms`, `target_not_allowed`, `method_not_allowed`, ...) so agents can relay them honestly instead of guessing.

**Contract cards.** A card can be scoped to specific contract targets + method selectors instead of (or alongside) a USDC budget. The agent calls `execute` with either `{target, method, args}` (the server ABI-encodes) or `{target, data}` raw calldata for tuple/array/multicall methods like Uniswap `exactInputSingle`. For a call that needs a recipient (e.g. `exactInputSingle`'s `recipient`), the `card` tool surfaces the card's on-chain `account` (the root delegator that holds the USDC and receives any output tokens), so the agent routes a swap's output there itself rather than guessing or asking the user. Targets and selectors outside the card's declared scope are refused before anything reaches the chain, and the on-chain `allowedTargets`/`allowedMethods` enforcers check the same scope again. Method signatures are normalized to their canonical form (`uint` -> `uint256`) so the encoder, the raw-data selector check, and the on-chain enforcer all agree. Safety on contract cards is the target/method allowlist plus `maxUses` and `expiry` (contract calls are not USDC-metered); pair contract scope with a `pay` cap in one composite card when you want both. A contract card can also carry an **allowance token list** (`contract.tokens`: the only tokens it may `approve`, every approval exact-amount pinned on-chain) and a **per-trade ceiling** (`contract.perTradeMax`, capping each USDC approval; v1 enforces the ceiling on USDC legs only). Both narrow subset-only on sub-cards. Calls carry no native ETH value in v1 (the carved leaf caps value at 0 on-chain); payable-with-value is a planned extension.

## Connecting a card to an agent

Three lanes. The first two carry a per-card credential directly; the third is OAuth, where the agent never holds the card secret.

```bash
# Lane A: secret in the URL path (works everywhere, treat the URL as a password)
claude mcp add --transport http remit https://<host>/c/<card-secret>/mcp

# Lane B: bearer header
claude mcp add --transport http remit https://<host>/mcp \
  --header "Authorization: Bearer <card-secret>"
```

Lanes A and B work in Cursor, VS Code, Gemini CLI, Windsurf, claude.ai custom connectors, or any MCP client that speaks Streamable HTTP. Rotate the secret any time from the dashboard; the old URL dies instantly.

Per-harness one-liners for Lane A (commands verified against each client, Jun 2026):

```bash
codex mcp add remit --url https://<host>/c/<card-secret>/mcp
openclaw mcp add remit --url https://<host>/c/<card-secret>/mcp --transport streamable-http  # flag required: omitting it defaults to SSE
hermes mcp add remit --url "https://<host>/c/<card-secret>/mcp"
gemini mcp add -t http remit https://<host>/c/<card-secret>/mcp
goose session --with-streamable-http-extension "https://<host>/c/<card-secret>/mcp"
amp mcp add remit https://<host>/c/<card-secret>/mcp
droid mcp add remit https://<host>/c/<card-secret>/mcp --type http
```

claude.ai web: Customize → Connectors → Add custom connector → paste the card URL (the dashboard's claude.ai chip opens that dialog prefilled). ChatGPT Developer Mode: create a connector with the card URL as No Authentication, or use Lane C for a real auth story.

**Lane C: OAuth 2.1 (card-picker consent).** Add the bare endpoint with no credential:

```bash
claude mcp add --transport http remit https://<host>/mcp
```

The client discovers the OAuth lane (RFC 9728 protected-resource metadata on the `401`), registers itself (Dynamic Client Registration), and opens a browser. You sign in with your existing dashboard login and **pick which card to grant**. The agent receives a short-lived, card-scoped, independently revocable access token, never the raw card secret. This is the lane OAuth-only clients such as **ChatGPT** require; it also works in Claude Code, claude.ai, Cursor, VS Code, Codex, Gemini CLI, Goose, opencode, Amp, and Factory Droid. Clients that complete OAuth out-of-band read the authorization code straight off the consent success screen: OpenClaw finishes with `openclaw mcp login remit --code <code>` (it runs no callback listener), and headless Hermes uses its paste-back flow the same way. The server is a self-hosted OAuth authorization server (public clients, PKCE S256, rotating refresh tokens); revoking the card kills every token issued for it.

## Architecture

Bun monorepo, three packages:

```
packages/
  engine/     pure core: caveat compiler, issuance, spend, redelegation, revocation
  server/     Hono: REST API + MCP endpoint + x402 facilitator + demo seller + Stripe webhook
  dashboard/  Next.js: Privy login, one-screen cockpit (card deck + dossier, light/dark), NL issue modal (client-signed), demo shop
```

Key pieces:

- **Caveat compiler** (`engine/src/compiler.ts`): turns human terms (`{"pay": {"period": {"amount": "25", "seconds": 604800}}}`) into delegation-framework enforcer caveats.
- **NL compiler** (`server/src/venice/`): Venice AI turns a plain-language request into a plan of named entities + numbers; the server resolves every name against its own verified registry (model output can never place an address in a draft) and assembles a `CardTerms` draft for the user to review and sign.
- **Issuance**: server prepares an unsigned delegation, the user's wallet signs it in the browser (prepare/finalize), so the server never holds the user's key for client-signed cards.
- **Spend** (`engine/src/spend.ts`): validates terms server-side, then redeems the delegation chain through the 1Shot Public Relayer (which calls `DelegationManager.redeemDelegations` on-chain on your behalf), attaching the user's EIP-7702 authorization on first spend.
- **Sub-cards**: ERC-7710 redelegations. Caps only narrow. Revoking a parent kills the subtree.
- **Two payment rails off one delegation**: x402 (real USDC, live) and Stripe Issuing real-time auth (test mode, fiat leg simulated honestly).
- **MCP server**: stateless Streamable HTTP, identity = the card credential on every request, no sessions.
- **OAuth lane** (`server/src/oauth/`): a self-hosted OAuth 2.1 authorization server (RFC 9728 + RFC 8414 discovery, RFC 7591 dynamic client registration, PKCE S256, RFC 8707 resource binding, rotating refresh tokens, RFC 7009 revocation). Login and the card-picker consent reuse the existing Privy dashboard session; issued tokens are opaque, card-scoped, hash-stored beside the card secrets, and die when the card is revoked.

### Contracts (Base mainnet)

| Contract | Address |
|---|---|
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| Stateless7702 delegator impl | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Running it

Requires [bun](https://bun.sh). Real money moves on Base mainnet; use small budgets.

```bash
bun install
cp .env.example .env                       # then fill in the two required vars:
# GLASSPAY_MASTER_KEY=<64 hex chars>            encrypts agent keys + card secrets at rest
# GLASSPAY_ADMIN_TOKEN=<random token>           protects the management API

bun dev                                    # server on :4070
bun run --cwd packages/dashboard dev       # dashboard on :4071
```

Issue a card from the dashboard (Privy login), or via the admin API:

```bash
curl -X POST localhost:4070/api/cards \
  -H "Authorization: Bearer $GLASSPAY_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"my agent card","terms":{"pay":{"period":{"amount":"5","seconds":604800}}}}'
# -> { "card_id": ..., "card_url": "http://localhost:4070/c/<secret>/mcp" }
```

Plug the `card_url` into an agent and it can spend.

### Tests

```bash
bun test                 # engine + server suites
bun run typecheck        # per-package tsc
```

### Environment variables

| Var | Required | Purpose |
|---|---|---|
| `GLASSPAY_MASTER_KEY` | yes | 32-byte hex key; encrypts agent keys and card secrets at rest |
| `GLASSPAY_ADMIN_TOKEN` | yes | ops bearer token for the management API (`/api/*`): full access, server-side scripts only, never shipped to a browser |
| `GLASSPAY_PRIVY_APP_ID` | dashboard lane | enables per-user API auth: Privy access tokens verified offline against the app's JWKS; every route scoped to the authenticated user |
| `PORT` | no | server port (default 4070) |
| `GLASSPAY_DB_PATH` | no | SQLite path (default `.dev/remit.sqlite`) |
| `GLASSPAY_RPC_URL` | no | Base RPC (default `https://mainnet.base.org`) |
| `GLASSPAY_PUBLIC_MCP_BASE` | prod | public origin used when rendering card URLs (unset = localhost; also arms the MCP Host allowlist) |
| `GLASSPAY_ALLOWED_HOSTS` | no | extra Host headers accepted on the MCP endpoint (comma-separated; e.g. a platform fallback domain) |
| `GLASSPAY_CORS_ORIGINS` | no | comma-separated allowed origins for the API |
| `GLASSPAY_DEV_USER_PK` | no | dev-only server-custodied user key (server-signed issuance lane) |
| `GLASSPAY_FACILITATOR_BASE` | no | x402 facilitator base URL (defaults to self) |
| `GLASSPAY_SELLER_PAYTO` | no | payout address for the built-in demo seller |
| `GLASSPAY_PAID_FETCH_ALLOW_LOCAL` | no | allow `paid_fetch` to hit local/private hosts (dev only) |
| `GLASSPAY_STRIPE_WEBHOOK_SECRET` | no | Stripe real-time auth webhook signing secret (test mode); unset = the fiat leg answers 503 (disabled) |
| `STRIPE_SECRET_KEY` | no | Stripe TEST-mode secret key (`sk_test_`/`rk_test_` only; anything else is refused); enables `fiat_pay`, `card_credentials`, and the demo shop |
| `GLASSPAY_FIAT_SETTLEMENT` | no | `1` = approved Visa charges settle on-chain as real delegated USDC transfers (see `GLASSPAY_SETTLEMENT_ADDRESS`, `GLASSPAY_FIAT_FEE_HEADROOM`, `GLASSPAY_FIAT_SETTLE_INTERVAL_MS`) |
| `GLASSPAY_SETTLEMENT_ADDRESS` | settlement | recipient of the fiat settlement transfers (validated at boot; default = the fee collector) |
| `VENICE_API_KEY` | no | enables `POST /cards/compile` (plain-language card drafting); unset = the compile endpoint refuses (disabled) |
| `VENICE_MODEL` | with key | Venice model id for the NL compiler; pin it (the fallback default is unvalidated) |
| `VENICE_BASE_URL` | no | Venice API base override (defaults to the public Venice endpoint) |
| `BASESCAN_API_KEY` | no | enables verified-contract labels from Basescan when resolving compiled drafts |
| `GLASSPAY_DASHBOARD_BASE` | OAuth lane | dashboard origin that hosts the OAuth consent (card-picker) page (default `http://localhost:4071`) |
| `GLASSPAY_RECONCILE_INTERVAL_MS` | no | stuck-pending-charge reconcile sweep interval (default 300000; 0 disables) |
| `GLASSPAY_MCP_RATE_LIMIT` / `GLASSPAY_MCP_BAD_SECRET_LIMIT` | no | per-card and per-IP-bad-secret request ceilings per minute (defaults 240 / 30) |
| `GLASSPAY_OAUTH_ACCESS_TTL` / `GLASSPAY_OAUTH_REFRESH_TTL` | no | OAuth access / refresh token lifetimes in seconds (defaults 3600 / 2592000) |
| `GLASSPAY_OAUTH_REDIRECT_HOSTS` | no | if set, restricts OAuth `https` redirect-URI hosts to this allowlist (loopback + custom schemes always allowed; recommended in prod) |
| `GLASSPAY_OAUTH_ACCEPTED_RESOURCES` | no | extra RFC 8707 resource URIs still honored (legacy values during a base-URL migration) |
| `GLASSPAY_TRUST_PROXY_HOPS` | no | trusted proxy hops for client-IP rate limiting (default 1 = Railway edge; 0 disables XFF trust) |
| `NEXT_PUBLIC_PRIVY_APP_ID` / `NEXT_PUBLIC_PRIVY_CLIENT_ID` | dashboard | Privy app credentials (public identifiers, not secrets) |
| `NEXT_PUBLIC_GLASSPAY_API` | dashboard | server API base, e.g. `http://localhost:4070/api` |
| `NEXT_PUBLIC_BASE_RPC` | dashboard | Base RPC for client-side reads |

The dashboard carries **no shared secret**: every API call sends the signed-in user's Privy session token, which the server verifies and scopes. The deployed dashboard origin must be listed in the server's `GLASSPAY_CORS_ORIGINS`.

## Security model

- **Custody**: your funds stay in your wallet. The per-card agent key signs redelegations only; it holds no assets and is encrypted at rest. You can export your wallet's private key from the account menu at any time (through Privy's secure modal, rendered in a separate-domain iframe remit never reads) and walk away to any client.
- **Dashboard auth**: per-user Privy sessions, verified server-side against the app JWKS. At onboard, the embedded wallet signs `glasspay-onboard:v1:<did>` to prove key possession bound to that login; from then on, every card route is scoped to the authenticated user's own cards.
- **Issuance integrity**: the server verifies the delegation signature recovers to the delegator on both issuance lanes before persisting a card.
- **Card secrets**: 256-bit, stored as a hash for auth and AES-256-GCM-encrypted at rest for the reveal/rotate feature; the URL is a credential, rotate it like a password.
- **Limits enforced twice**: server-side at call time (typed refusals) and on-chain by caveat enforcers at redemption. Period, lifetime, expiry, usage count, and contract target/method have dedicated on-chain enforcers; the per-transaction max and merchant allowlist are server-side carve policy, backstopped on-chain by the leaf's amount scope.
- **Revocation layers**: freeze (server, reversible) -> revoke (card + subtree, permanent) -> nuke (on-chain nonce bump, kills every delegation ever issued by the wallet). All three are user-operable from the dashboard; on-chain revoke and nuke are signed by the user's own embedded wallet in the browser (an admin leaf delegation) and ride the relayer gaslessly.
- **MCP surface hardening**: Host allowlist (DNS-rebinding guard), per-card and bad-secret rate limits, 1 MiB body cap, secrets never echoed in errors or logs.
- **Stripe leg**: test mode only, by design; the real-time auth webhook answers from cached delegation state within Stripe's 2s window. With settlement enabled, an approved charge settles as a real delegated USDC transfer afterwards (the same enforcers count both rails), and a charge whose settlement cannot land parks `settlement_unconfirmed` and freezes the card rather than ever releasing its budget.

## The demo merchant

`/shop` (also served at https://shop.s0nderlabs.xyz) is a small storefront, "s0nder supply co.", that accepts the cards' Visas. It exists to show the fiat lane end to end with nothing mocked on our side of the rail:

1. An agent asks its card for credentials (`card_credentials`) and fills the checkout form like it would at any web store.
2. The shop fires a real Stripe test-mode authorization; Stripe calls our real-time auth webhook; the webhook answers approve/decline from the card's on-chain delegation state within Stripe's 2-second window.
3. A decline (e.g. an item over the card's weekly budget) comes back typed, from the card's terms, not from the merchant.
4. With settlement enabled, the approved charge settles as a real delegated USDC transfer on Base, through the same enforcers that meter the crypto rail. One budget, two rails.

Catalog prices are all $5 or less because approved purchases move real USDC.

## Built for the MetaMask Smart Accounts Kit x 1Shot API x Venice AI Dev Cook Off (2026)

The hard gate (Smart Accounts Kit in the main flow) is the product itself: every card IS a SAK delegation, signed by a Privy-provisioned embedded smart account (Smart Accounts are signer-agnostic), and every spend redeems that delegation on-chain.

| Track | What GlassPay does |
|---|---|
| x402 + ERC-7710 | `paid_fetch` answers HTTP 402 by paying through the card's 7710 delegation; real x402 v2 flows on Base mainnet, USDC settled from the user's wallet |
| Best Agent experience | One URL is the whole integration: `claude mcp add ... /c/<secret>/mcp` and the agent can spend within terms; typed refusals; OAuth lane for clients that want consent UX |
| Agent-to-agent coordination | `issue_subcard` redelegates narrower authority to sub-agents (caps only nest downward); `revoke_subcard` and the cascade nuke kill whole subtrees with one signature |
| Venice AI | The dashboard's issue modal compiles plain language into signed card terms (Venice drafts, a verified registry resolves every address, the user reviews and signs) |
| 1Shot Relayer | Every redemption rides the 1Shot Public Relayer on Base mainnet, gasless, fees in USDC; the user's 7702 smart-account code deploys via the relayer on first spend |

### Code usage (per track)

Direct links to the exact code behind each track, following the [MetaMask DevRel submission guideline](https://gist.github.com/AyushBherwani1998/202d654c293724df8340581a511f341b).

**Smart Accounts Kit**

- **Advanced Permissions (ERC-7715): not used.** remit grants spending authority through programmatic ERC-7710 Delegations, whose caveat set is richer than the 7715 grant catalog allows, so there is no `wallet_requestExecutionPermissions` path. Everything below is ERC-7710.
- **Delegations, create:** [`issueRootCard`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/issuance.ts#L53) compiles human terms into caveats ([`compileCard`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/compiler.ts#L270)), builds the delegation ([`buildRootDelegation`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/delegations.ts#L93)), and signs it with the user's smart account ([`signWithSmartAccount`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/delegations.ts#L156)).
- **Delegations, redeem:** [`spend.ts`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/spend.ts#L582) ships the leaf-first `permissionContext` to the relayer, which calls `DelegationManager.redeemDelegations` on-chain.
- **Redelegation, create:** [`issueSubCard`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/issuance.ts#L225) attenuates the parent's terms (caps only narrow) and builds a child delegation whose authority binds to the parent delegation's hash ([`buildChildDelegation`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/delegations.ts#L110)). This is the agent-to-agent sub-card path.
- **x402, server:** the ERC-7710 x402 facilitator ([`facilitatorRoutes`](https://github.com/s0nderlabs/remit/blob/main/packages/server/src/facilitator/routes.ts#L51): `/supported`, `/verify`, `/settle`) and the demo seller that emits the 402 challenge ([`sellerRoutes`](https://github.com/s0nderlabs/remit/main/packages/server/src/seller/routes.ts#L21), [`assetTransferMethod: \"erc7710\"`](https://github.com/s0nderlabs/remit/blob/main/packages/server/src/seller/routes.ts#L34)).
- **x402, client (ERC-7710 asset transfer method):** [`buildX402Payload`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/x402.ts#L64) carves a payment leaf and encodes the delegation chain into the x402 `permissionContext`; the `erc7710` asset-transfer method is [required here](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/x402.ts#L56).

**1Shot API**

- Every redemption rides the 1Shot Public Relayer: [`Relayer.send`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/relayer.ts#L135) posts `relayer_send7710Transaction` to `relayer.1shotapi.com` ([endpoint](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/relayer.ts#L60)); the spend call site is [`spend.ts#L582`](https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/spend.ts#L582).

**Venice AI**

- The natural-language card compiler calls Venice: [`veniceChat`](https://github.com/s0nderlabs/remit/blob/main/packages/server/src/venice/client.ts#L20) (OpenAI-wire `chat/completions`), orchestrated by [`compileIntent`](https://github.com/s0nderlabs/remit/blob/main/packages/server/src/venice/compiler.ts#L98), which turns a plain-language request into a plan whose named entities the server resolves against its own verified address registry.

Everything in this README, including the mainnet transactions, is reproducible end to end.
