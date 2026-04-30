# hive-merchant-onboard

**60-second x402 merchant onboarding.** Issues a fresh Base mainnet wallet, generates a ready-to-paste express middleware snippet, and instruments 10 bps royalty attribution for every downstream settlement.

---

## Pricing

| Fee | Amount |
|-----|--------|
| Onboard flat | **$9.00 USDC** (Base mainnet, one-time) |
| Lifetime royalty | **10 bps** on every attributed settlement |

Royalty math: a merchant settling $10,000 USDC/month generates $10.00/mo in perpetual royalty back to the Monroe treasury. At $100k/mo that is $100/mo. The royalty compounds with merchant volume — zero incremental cost to the network.

---

## Tools (MCP)

| Tool | Description |
|------|-------------|
| `onboard_merchant` | Onboard a new x402 merchant. Issues wallet + middleware + royalty config. Costs $9 USDC via x402 on Base mainnet. |
| `get_merchant_status` | Get onboarding status and royalty ledger for a `merchant_id`. |
| `attribute_settlement` | Log a settlement attribution for royalty accounting (internal, requires `INTERNAL_TOKEN`). |

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| GET | `/` | Service banner |
| GET | `/.well-known/agent.json` | A2A agent card — Monroe in `treasury` field |
| POST | `/mcp` | JSON-RPC 2.0, MCP 2024-11-05 |
| POST | `/v1/onboard/x402-merchant` | x402-gated merchant onboard ($9 USDC) |
| GET | `/v1/onboard/status/:merchant_id` | Public status + royalty ledger |
| POST | `/v1/onboard/attribute` | Internal settlement attribution (Bearer token) |

---

## Connect (MCP client)

```json
{
  "mcpServers": {
    "hive-merchant-onboard": {
      "url": "https://hive-merchant-onboard.onrender.com/mcp",
      "transport": "http"
    }
  }
}
```

---

## Onboarding flow

### 1. Trigger the x402 challenge

```bash
curl -s -X POST https://hive-merchant-onboard.onrender.com/v1/onboard/x402-merchant \
  -H "Content-Type: application/json" \
  -d '{"merchant_name":"Acme Corp","callback_url":"https://acme.example.com/pay","asset_preference":"USDC","chain_preference":"base"}'
# → HTTP 402 with accepts[] array
```

### 2. Pay $9 USDC on Base mainnet

Send exactly **9,000,000 units** (9 USDC at 6 decimals) to:

```
0x15184bf50b3d3f52b60434f8942b7d52f2eb436e   (Monroe treasury, Base 8453)
USDC contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

### 3. Retry with X-PAYMENT header

```bash
curl -s -X POST https://hive-merchant-onboard.onrender.com/v1/onboard/x402-merchant \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <signed_payment_proof>" \
  -d '{"merchant_name":"Acme Corp","callback_url":"https://acme.example.com/pay","asset_preference":"USDC","chain_preference":"base"}'
```

### 4. Response

```json
{
  "merchant_id": "hm_a1b2c3d4e5f6a7b8",
  "public_address": "0xYourFreshMerchantWallet",
  "created_at": "2025-01-01T00:00:00.000Z",
  "asset_preference": "USDC",
  "chain_preference": "base",
  "x402_snippet": "// Hive x402 Merchant Middleware...",
  "test_curl_command": "curl -s https://hive-merchant-onboard.onrender.com/v1/onboard/status/hm_a1b2c3d4e5f6a7b8",
  "royalty_attribution_header_format": "X-Hive-Attribution: hivemerch:hm_a1b2c3d4e5f6a7b8",
  "royalty_bps": 10,
  "message": "Merchant Acme Corp onboarded successfully."
}
```

---

## Sample express middleware snippet

```javascript
// Hive x402 Merchant Middleware — merchant_id: hm_a1b2c3d4e5f6a7b8
// Add X-Hive-Attribution: hivemerch:hm_a1b2c3d4e5f6a7b8 to every request
// your server makes through a Hive surface so royalties are attributed correctly.
import { paymentMiddleware } from 'x402-express';

app.use(paymentMiddleware({
  payTo: '0xYourFreshMerchantWallet',      // Your merchant wallet on Base
  network: 'base',
  asset: 'USDC',
  assetContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  callbackUrl: 'https://acme.example.com/pay',
  royaltyHeader: 'X-Hive-Attribution',
  royaltyValue: 'hivemerch:hm_a1b2c3d4e5f6a7b8',
}));
```

---

## Royalty attribution

Every Hive surface that processes a settlement inspects the `X-Hive-Attribution` header. When it matches `hivemerch:{merchant_id}`, it POSTs to `POST /v1/onboard/attribute` (internal) which:

1. Computes 10 bps of the settlement amount
2. Appends a record to `/tmp/merchant_royalties.jsonl`
3. Updates the merchant's running ledger (visible at `GET /v1/onboard/status/:merchant_id`)

Royalty payouts are batched offline to the Monroe treasury.

---

## x402 Protocol (Base USDC)

```json
{
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "asset": "USDC",
    "maxAmountRequired": "9000000",
    "payTo": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
    "assetContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "resource": "/v1/onboard/x402-merchant",
    "description": "Onboard an x402 merchant. Includes wallet, middleware snippet, and royalty attribution config.",
    "mimeType": "application/json"
  }]
}
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MERCHANT_KMS_SECRET` | Yes | AES-256-CBC key for encrypting merchant private keys on disk |
| `INTERNAL_TOKEN` | Yes | Bearer token for `POST /v1/onboard/attribute` |
| `PORT` | No | Listen port (default 3000) |

---

## Infrastructure

- Runtime: Node.js 18+ ESM
- Chain: Base (8453)
- Settlement asset: USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- Treasury: Monroe (`0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`)
- Wallet generation: `ethers.Wallet.createRandom()` (pubkey returned, privkey AES-encrypted at rest)
- Hosted on Render (starter plan)

---

## Brand

`#C08D23` — Hive gold.

---

## License

MIT — © The Hivery


---

## Hive Civilization

Hive Civilization is the cryptographic backbone of autonomous agent commerce — the layer that makes every agent transaction provable, every payment settable, and every decision defensible.

This repository is part of the **PROVABLE · SETTABLE · DEFENSIBLE** pillar.

- thehiveryiq.com
- hiveagentiq.com
- agent-card: https://hivetrust.onrender.com/.well-known/agent-card.json
