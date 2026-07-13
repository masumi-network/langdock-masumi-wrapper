# Langdock → Masumi wrapper

Fastify service that exposes any Langdock agent (or any async AI workload) as a
MIP-003-compliant Masumi agent, ready to list on [Sokosumi](https://app.sokosumi.com).

It implements:

- `GET  /`            — minimal operator setup UI for posting Langdock and
  Masumi credentials into `.env` and the running process.
- `GET/POST /setup/config` — redacted setup status and persistent credential update.
- Setup login UI — authenticate with database admin users created by
  `npm run admin:create-user`, or with server env fallback credentials
  (`SETUP_USERNAME` + `SETUP_PASSWORD_HASH`, or `SETUP_PASSWORD`).
- `GET /setup/registry/status` — polls Payment Service registry records and saves
  `AGENT_IDENTIFIER` once the registration returns one.
- `POST /start_job`   — registers a sale on the Masumi Payment Service, returns
  `blockchainIdentifier` + payment timings, defers execution until funds are locked.
- `POST /agents/:slug/start_job` and matching `/status`, `/availability`, and
  `/input_schema` routes — one deployed wrapper can host multiple registered
  Langdock/Masumi agents.
- `GET  /status`      — MIP-003 payload with `input_hash`, `output_hash`, result, timestamps, and HITL prompts when awaiting input.
- `POST /provide_input` and `POST /agents/:slug/provide_input` — optional HITL chat continuation for Langdock agents; send follow-up input or `DONE` to finish.
- `GET  /availability` — health for load balancers / marketplace checks.
- `GET  /input_schema` — schema shown to buyers on Sokosumi.
- `GET  /ready` — operator readiness report for missing production secrets/config.

MIP-004 hashing (JCS + SHA-256) is applied to both `input_data` and the handler's output,
and the output hash is submitted on-chain via the Payment Service so buyers can unlock
payment.

See [STATUS.md](STATUS.md) for the production-readiness checklist and
[AUDIT.md](AUDIT.md) for the route/env/payment wiring audit.

## Architecture

```
┌──────────┐  POST /start_job  ┌────────────────────┐  POST /payment              ┌────────────────────────┐
│  Buyer   │ ────────────────▶ │ Wrapper (this app) │ ──────────────────────────▶ │ Masumi SaaS / Payment  │
└──────────┘                   │                    │ ◀── blockchainIdentifier ── │        Service         │
                               │   poller loop      │                             └─────────┬──────────────┘
                               │                    │ POST /payment/resolve-                │ on-chain escrow
                               │                    │      blockchain-identifier            │
                               │   FundsLocked?     │ ──────────────────────────▶            ▼
                               │                    │                             ┌────────────────────────┐
                               │   run handler      │                             │   Cardano Preprod /    │
                               │   compute hash     │                             │        Mainnet         │
                               │                    │ POST /payment/             └────────────────────────┘
                               │                    │      submit-result
                               └────────────────────┘
                                        │
                                        │ POST /agent/v1/chat/completions
                                        ▼
                               ┌────────────────────┐
                               │   Langdock API     │
                               └────────────────────┘
```

## Install

```bash
npm install
cp .env.example .env
# fill in the values below
```

### Environment

| Var | Purpose |
|-----|---------|
| `LANGDOCK_API_KEY` | Server-side Langdock API key. Never expose to the browser. |
| `LANGDOCK_AGENT_ID` | Target Langdock agent ID. |
| `AGENTS_JSON` | Optional routed agent profiles. Each profile exposes `/agents/<slug>/...` and carries its own Langdock agent id, Masumi agent identifier, pricing, and schema. |
| `AGENT_IDENTIFIER` | Masumi NFT-backed agent identifier (from the Payment Service registry). |
| `SELLER_VKEY` | Selling wallet verification key (from the Payment Service admin UI). |
| `PAYMENT_MODE` | `masumi` (default when URL is set — production) or `direct` (local dev, skips escrow). |
| `PAYMENT_SERVICE_URL` | API base URL. Use Masumi SaaS `/pay/api/v1` or direct payment-node `/api/v1`. |
| `PAYMENT_API_KEY` | Masumi SaaS API key or direct Payment Service token. |
| `PAYMENT_API_AUTH_HEADER` | Optional override: `x-api-key` for SaaS, `token` for direct node. Auto-detected from the URL. |
| `NETWORK` | `Preprod` or `Mainnet`; the same wrapper routes work on both networks. |
| `PRICE_AMOUNTS` | Optional dynamic `RequestedFunds` JSON array. Leave empty for fixed pricing configured in Masumi SaaS/admin. |
| `HITL_CHAT_MODE` | Set `true` to keep paid Langdock jobs open as a chat. After each answer `/status` returns `awaiting_input`; `/provide_input` continues until the user sends `DONE`. |
| `INPUT_SCHEMA_PATH` / `INPUT_SCHEMA_JSON` | MIP-003 schema served at `/input_schema`. |
| `REQUIRE_PRODUCTION_CONFIG` | Set `true` to make startup fail until production env is complete. Leave unset/false when the admin still needs to use the locked setup UI. |
| `DATABASE_URL` | Optional Postgres auth store for database-backed admin login. Use this on hosted/Mainnet deployments. |
| `DATABASE_SSL` | Set `require` when your Postgres URL needs SSL and does not include `sslmode=require`. |
| `DB_PATH` | Optional local sql.js auth database path when `DATABASE_URL` is unset. |
| `SETUP_USERNAME` / `SETUP_PASSWORD_HASH` | Env fallback admin login for first boot or simple deployments. Browser registration is disabled. |
| `SETUP_PASSWORD` | Plaintext fallback accepted for development/private stores; use `SETUP_PASSWORD_HASH` or database users for production Mainnet. |
| `SETUP_ACCESS_TOKEN` | Optional bearer/basic API access token for setup endpoints. Admin username/password remains the browser login. |
| `SETUP_ENV_PATH` | Optional path where `POST /setup/config` writes persistent env config. Defaults to `.env` in the current working directory. |

Full list in [.env.example](.env.example).

### Wiring Map

| Concern | File |
|---------|------|
| Env loading and auth-header selection | [src/config.ts](src/config.ts) |
| MIP-003 routes | [src/routes/index.ts](src/routes/index.ts) |
| HITL chat continuation | [src/routes/provideInput.ts](src/routes/provideInput.ts), [src/services/hitlChat.ts](src/services/hitlChat.ts) |
| Payment API client | [src/services/masumiPayment.ts](src/services/masumiPayment.ts) |
| Payment-gated job runner | [src/services/jobRunner.ts](src/services/jobRunner.ts) |
| Production readiness checks | [src/services/readiness.ts](src/services/readiness.ts) |

The Masumi client expects `PAYMENT_SERVICE_URL` to include the API prefix:
`/pay/api/v1` for Masumi SaaS or `/api/v1` for a direct payment node. It then
calls `POST /payment`, `POST /payment/resolve-blockchain-identifier`, and
`POST /payment/submit-result`.

Before exposing the service publicly, build and run the readiness check:

```bash
npm run build
npm run check:production
curl -s http://localhost:3000/ready
```

The check fails on missing admin login, missing Langdock credentials, missing
Masumi identity/payment credentials in `masumi` mode, insecure non-local HTTP
API URLs, invalid payment windows, invalid dynamic pricing, or an empty/duplicate
input schema. `NETWORK=Mainnet` also requires `PAYMENT_MODE=masumi`, public
non-local service URLs, and hashed/database admin authentication.

### Hosted setup UI

Run the service and open `http://localhost:3000/` to configure the wrapper from
a browser. The form posts Langdock and Masumi credentials to `POST /setup/config`;
the server writes them to `.env`, applies them to the current process, and
rebinds the default Langdock `start_job` handler immediately. Submitted secrets
are not returned by `GET /setup/config` or the UI status panel. Empty secret
fields keep their previous value so refreshing status or changing non-secret
settings does not erase credentials.

Configure the admin login before exposing the page. For hosted deployments,
prefer a database-backed admin user:

```bash
npm run build
DATABASE_URL="postgres://..." npm run db:migrate-auth
DATABASE_URL="postgres://..." npm run admin:create-user -- --username operator
```

The server can also use a bcrypt hash fallback:

```bash
SETUP_USERNAME="operator"
SETUP_PASSWORD_HASH="$2b$12$..."
```

Or use a plaintext password in your deployment secret store:

```bash
SETUP_USERNAME="operator"
SETUP_PASSWORD="<set-a-private-admin-password>"
```

`SETUP_ACCESS_TOKEN` is still accepted as an API bearer token for setup routes,
but the browser login does not allow public registration. Use at least 32 random
characters if you enable it.

The setup UI also includes **Agent slots**. Each slot can be saved into
`AGENTS_JSON`, which exposes a separate route namespace:
`/agents/<slug>/availability`, `/agents/<slug>/input_schema`,
`/agents/<slug>/start_job`, and `/agents/<slug>/status`. The admin chooses the
public agent name, description, route slug, Langdock agent id, capability/version,
author/contact details, tags, pricing, legal links, and optional example outputs.
**Register agent** submits the selected slot to the Masumi registry and saves the
returned `agentIdentifier` back into that slot.

When editing env directly, keep `AGENTS_JSON` as a JSON array. The legacy
`/start_job` endpoint uses `LANGDOCK_AGENT_ID` and `AGENT_IDENTIFIER`; routed
agent endpoints use their matching profile instead:

```env
AGENTS_JSON=[{"slug":"research","name":"Research Agent","description":"Answers research tasks.","apiBaseUrl":"https://wrapper.example.com/agents/research","langdockAgentId":"LANGDOCK_AGENT_ID_HERE","agentIdentifier":"MASUMI_AGENT_IDENTIFIER_AFTER_REGISTRATION","priceAmounts":[{"amount":"1000000","unit":"PREPROD_TUSDM_OR_MAINNET_USDCX_ASSET_ID"}]}]
```

### Local test-agent smoke

For preprod smoke testing, the repo includes helper scripts for four routed
agents named `Test Agent 1` through `Test Agent 4`. The local smoke does not
touch Masumi, Sokosumi, Railway, or Langdock. It runs the wrapper in direct mode
and mocks the Langdock completion call:

```bash
npm run smoke:test-agents
```

To generate a deployable `AGENTS_JSON` value that appends or updates
`test-agent-1` through `test-agent-4`, run:

```bash
PUBLIC_BASE_URL="https://your-wrapper.example.com" \
AGENTS_JSON="$AGENTS_JSON" \
npm --silent run agents:test-json
```

The generator preserves existing profiles and copies Langdock agent IDs from
source slugs when present: `lexi`, `emil-conrad`, `diddy-p`, and
`food-co2-analyst`. You can also provide explicit IDs with
`TEST_AGENT_1_LANGDOCK_AGENT_ID` through `TEST_AGENT_4_LANGDOCK_AGENT_ID`.
After Masumi registry confirmation, set
`TEST_AGENT_1_AGENT_IDENTIFIER` through `TEST_AGENT_4_AGENT_IDENTIFIER` and run
the generator again to produce the final `AGENTS_JSON` for deployment. Keep
`priceAmounts: []` on these routed profiles when their pricing is fixed in the
Masumi registry.

Sokosumi preprod can only start jobs against a public wrapper URL. A purely
local server on `localhost` is not reachable from Sokosumi unless you expose it
through a tunnel and use that tunnel URL as `PUBLIC_BASE_URL`.

#### Credential guide

| Field | What it is for | Where to get it |
|-------|----------------|-----------------|
| `DATABASE_URL` | Postgres-backed admin login and sessions for hosted deployments. | Add a managed Postgres database, run `npm run db:migrate-auth`, then create an operator with `npm run admin:create-user`. |
| `SETUP_USERNAME` / `SETUP_PASSWORD_HASH` | Env fallback admin login for the setup UI. This is not provided by a vendor; generate it yourself. | Store them in your deployment variables. `SETUP_PASSWORD` is also supported for development. See [Railway variables](https://docs.railway.com/variables). |
| `SETUP_ACCESS_TOKEN` | Optional API bearer token for setup endpoints. | Run `openssl rand -hex 32`, then set it in deployment variables. |
| `LANGDOCK_API_KEY` | Server-side key used by this wrapper to call Langdock. | In Langdock workspace settings, create an API key, then share your agent with that key. See [Langdock: Sharing Agents with API Keys](https://docs.langdock.com/api-endpoints/agent/agent-api-guide). |
| `LANGDOCK_AGENT_ID` | The Langdock agent this wrapper calls. | Open the agent in Langdock and copy the ID from the URL, e.g. `https://app.langdock.com/agents/AGENT_ID/edit`. See the same [Langdock guide](https://docs.langdock.com/api-endpoints/agent/agent-api-guide). |
| `AGENTS_JSON` | Multi-agent route profiles for one wrapper deployment. | Usually written by the setup UI. Each profile needs `slug`, `langdockAgentId`, and, after registry confirmation, `agentIdentifier`. |
| `PAYMENT_SERVICE_URL` | Masumi Payment Service or Masumi SaaS API base URL used for payments and registry calls. | Use a URL ending in `/api/v1` for a direct payment node or `/pay/api/v1` for Masumi SaaS. See [Masumi API reference](https://www.masumi.network/dev/masumi/api-reference). |
| `PAYMENT_API_KEY` | API key for the Masumi Payment Service/SaaS. | Create or copy an API key from your Payment Service/SaaS admin surface. API calls authenticate with `token` or `x-api-key`. See [Payment Service API keys](https://www.masumi.network/dev/masumi/api-reference/payment-service/get-api-key). |
| `SELLER_VKEY` | Selling wallet verification key used when registering the agent and taking payment. | From the funded selling wallet in your Masumi Payment Service/admin setup. |
| `AGENT_IDENTIFIER` | On-chain Masumi registry identifier for the legacy global endpoint. | Generated by the setup UI's **Register agent** flow or registry API. For routed agents, this is stored per profile in `AGENTS_JSON`. Use **Refresh registry** until it appears. See [Sokosumi listing guide](https://www.masumi.network/dev/masumi/documentation/how-to-guides/list-agent-on-sokosumi). |
| `NETWORK` | Chooses Cardano `Preprod` or `Mainnet`; the wrapper sends this value to payment and registry API calls. | Start with `Preprod`; switch to `Mainnet` only after end-to-end tests pass with the correct Mainnet wallet/API keys. |

The setup UI can also submit an on-chain registry request through the configured
Payment Service. Registration requires a funded selling wallet and uses
`POST {PAYMENT_SERVICE_URL}/registry/`. Preprod should be used first; on-chain
confirmation can take several minutes. Once the registry response includes an
`agentIdentifier`, the helper saves it to `.env`: the global registration writes
`AGENT_IDENTIFIER`, and a selected agent slot writes that profile's
`AGENTS_JSON[].agentIdentifier`. Sokosumi discovery depends on the registry NFT
being confirmed, the agent URL being public and healthy, and pricing using the
expected settlement token:

- Preprod: tUSDM `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`
- Mainnet active stablecoin per Masumi token docs: USDCx `1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378`
- Mainnet asset still referenced by the Sokosumi listing guide: USDM `c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d`

The wrapper accepts both known Mainnet settlement asset ids in readiness checks
because the current official docs are split between the newer USDCx token page
and the Sokosumi listing guide. Before Mainnet launch, confirm which asset your
Masumi Payment Service/Sokosumi target expects.

## Handlers

Plug in async functions for `start_job` (and optionally `status` / `availability`). The
default `start_job` implementation calls Langdock chat completions. The API mirrors the
handler registration used by [`pip-masumi`](https://github.com/masumi-network/pip-masumi).

```ts
import {
  AgentEndpointHandler,
  buildApp,
  inputDataToRecord,
} from "langdock-masumi-wrapper";

const endpointHandler = new AgentEndpointHandler();
endpointHandler.setStartJobHandler(async (identifier, inputData) => {
  // inputData is the canonical MIP-003 array [{key,value}]
  const fields = inputDataToRecord(inputData);
  return { ok: true, text: fields.text };
});

const app = await buildApp({ endpointHandler });
await app.listen({ port: 3000, host: "0.0.0.0" });
```

## Examples

```bash
# /start_job accepts the MIP-003 array form (preferred) and legacy object form.
curl -s -X POST http://localhost:3000/start_job \
  -H "Content-Type: application/json" \
  -d '{"identifier_from_purchaser":"abc123def4567890","input_data":[{"key":"text","value":"Hello"}]}'

curl -s "http://localhost:3000/status?job_id=JOB_UUID"

# Routed agent profiles use the same MIP-003 payload shape.
curl -s -X POST http://localhost:3000/agents/research/start_job \
  -H "Content-Type: application/json" \
  -d '{"identifier_from_purchaser":"abc123def4567890","input_data":[{"key":"text","value":"Hello"}]}'

curl -s "http://localhost:3000/agents/research/status?job_id=JOB_UUID"

# HITL chat mode only: continue a job that reports status=awaiting_input.
# Use the continuationToken returned by /start_job.
curl -s -X POST http://localhost:3000/provide_input \
  -H "Content-Type: application/json" \
  -d '{"job_id":"JOB_UUID","input_token":"CONTINUATION_TOKEN","input_data":{"message":"Follow-up question"}}'

# Finish the HITL chat and submit the final transcript hash. The HITL schema also
# exposes a boolean `finish` control; default/off means continue.
curl -s -X POST http://localhost:3000/provide_input \
  -H "Content-Type: application/json" \
  -d '{"job_id":"JOB_UUID","input_token":"CONTINUATION_TOKEN","input_data":{"message":"","finish":true}}'

curl -s http://localhost:3000/availability
curl -s http://localhost:3000/input_schema
curl -s http://localhost:3000/ready
```

Field names in the request may be snake_case or camelCase
(`identifierFromPurchaser`, `inputData`, etc.). If `identifier_from_purchaser` is
omitted, a hex identifier in the Payment Service's required 14–26 char range is
auto-generated. In `PAYMENT_MODE=masumi`, a provided identifier must already be
lowercase hex and 14–26 characters; invalid values are rejected before any Masumi
API call is made.

## Modes

- **`PAYMENT_MODE=direct`** — local dev. Skips escrow; the handler runs immediately,
  `/status` returns `completed` on the next tick. Useful while wiring up Langdock without
  a Masumi node.
- **`PAYMENT_MODE=masumi`** — production. `/start_job` registers the sale on the Masumi
  Payment Service, returns `awaiting_payment` with real on-chain times, a background
  poller waits for `FundsLocked`, runs the handler, and submits the MIP-004 output hash
  back to the Payment Service.

Mode auto-detection: if `PAYMENT_SERVICE_URL` is set, `masumi` is the default;
otherwise `direct`. `MASUMI_PAYMENT_SERVICE_URL`, `MASUMI_PAYMENT_SERVICE_TOKEN`,
and `MASUMI_NETWORK` remain supported as legacy aliases. Override explicitly with
`PAYMENT_MODE=...`.

## Scripts

| Script | Command |
|--------|---------|
| Develop | `npm run dev` |
| Build | `npm run build` |
| Run | `npm start` |
| Production config check | `npm run check:production` |
| Test | `npm test` |

## Spec compliance

- **MIP-003** — Agentic Service API. See [STATUS.md](STATUS.md) for the endpoint-by-endpoint checklist.
- **MIP-004** — Decision Logging. Canonical JCS + SHA-256 over `identifier;payload` for
  both `input_hash` and `output_hash`. Handled in [src/services/hashing.ts](src/services/hashing.ts).

## Repository layout

```
src/
  app.ts                       Fastify factory + CLI entry
  config.ts                    Env-backed settings (Langdock, Masumi, pricing, schema)
  agentEndpointHandler.ts      Pluggable handler registration
  routes/                      start_job, status, availability, input_schema
  services/
    langdock.ts                Langdock chat completions client
    langdockStartJob.ts        Default start_job → Langdock adapter
    masumiPayment.ts           Masumi Payment Service client (register, poll, submit)
    jobRunner.ts               Background payment poller + job executor
    hashing.ts                 MIP-004 input / output hashes
    inputMapping.ts            MIP-003 input_data → Langdock prompt text
    jobs.ts                    In-memory job store (swap for Redis/Postgres for HA)
    readiness.ts               Central production config/readiness checks
  utils/
    startJobBody.ts            Request normalisation (MIP-003 array form + aliases)
  types/                       Typed payloads for MIP-003 and Langdock
tests/                         vitest suites
```
