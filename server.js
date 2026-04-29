import express from 'express';
import { ethers } from 'ethers';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ── constants ──────────────────────────────────────────────────────────────
const MONROE = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const BASE_CHAIN_ID = 8453;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ONBOARD_PRICE_USDC = '9000000'; // 9 USDC at 6 decimals
const ROYALTY_BPS = 10;
const PORT = process.env.PORT || 3000;
const KMS_SECRET = process.env.MERCHANT_KMS_SECRET || 'dev-kms-secret-change-me';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'dev-internal-token-change-me';

const DATA_DIR = path.join(__dirname, 'data');
const WALLETS_DIR = path.join(DATA_DIR, 'wallets');
const MERCHANTS_DB = path.join(DATA_DIR, 'merchants.json');
const SETTLEMENTS_LOG = '/tmp/onboard_settlements.jsonl';
const ROYALTIES_LOG = '/tmp/merchant_royalties.jsonl';

// ── bootstrap dirs ─────────────────────────────────────────────────────────
for (const d of [DATA_DIR, WALLETS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadMerchants() {
  if (!fs.existsSync(MERCHANTS_DB)) return {};
  try { return JSON.parse(fs.readFileSync(MERCHANTS_DB, 'utf8')); }
  catch { return {}; }
}

function saveMerchants(db) {
  fs.writeFileSync(MERCHANTS_DB, JSON.stringify(db, null, 2));
}

// ── AES-256-CBC encrypt / decrypt ──────────────────────────────────────────
function encryptPrivkey(privkey) {
  const key = crypto.createHash('sha256').update(KMS_SECRET).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(privkey, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

// ── helpers ────────────────────────────────────────────────────────────────
function gen402Response(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers.host;
  return {
    accepts: [{
      scheme: 'exact',
      network: 'base',
      asset: 'USDC',
      maxAmountRequired: ONBOARD_PRICE_USDC,
      payTo: MONROE,
      assetContract: USDC_BASE,
      resource: '/v1/onboard/x402-merchant',
      description: 'Onboard an x402 merchant. Includes wallet, middleware snippet, and royalty attribution config.',
      mimeType: 'application/json',
    }]
  };
}

function generateX402Snippet(merchantId, publicAddress, callbackUrl) {
  return `// Hive x402 Merchant Middleware — merchant_id: ${merchantId}
// Add X-Hive-Attribution: hivemerch:${merchantId} to every request your server makes
// through a Hive surface so royalties are attributed correctly.
import { paymentMiddleware } from 'x402-express';

app.use(paymentMiddleware({
  payTo: '${publicAddress}',           // Your merchant wallet on Base
  network: 'base',
  asset: 'USDC',
  assetContract: '${USDC_BASE}',
  callbackUrl: '${callbackUrl || 'https://your-domain.com/payment-callback'}',
  royaltyHeader: 'X-Hive-Attribution',
  royaltyValue: 'hivemerch:${merchantId}',
}));`;
}

// ── GET /health ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'hive-merchant-onboard',
    version: '1.0.0',
    treasury: MONROE,
    chain: 'base',
    chain_id: BASE_CHAIN_ID,
    usdc: USDC_BASE,
    onboard_price_usdc: 9,
    royalty_bps: ROYALTY_BPS,
    timestamp: new Date().toISOString(),
  });
});

// ── GET / → banner ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'Hive Merchant Onboard',
    tagline: '60-second x402 merchant onboarding. Wallet + middleware + royalty attribution.',
    pricing: {
      onboard_flat: '$9 USDC (Base mainnet)',
      royalty: '10 bps lifetime on every attributed settlement',
    },
    treasury: MONROE,
    brand: '#C08D23',
    endpoints: [
      'GET  /health',
      'GET  /.well-known/agent.json',
      'POST /mcp (JSON-RPC tools/list, onboard_merchant, get_merchant_status, attribute_settlement)',
      'POST /v1/onboard/x402-merchant (x402-gated, $9 USDC)',
      'GET  /v1/onboard/status/:merchant_id',
      'POST /v1/onboard/attribute (internal)',
    ],
  });
});

// ── GET /.well-known/agent.json ────────────────────────────────────────────
app.get('/.well-known/agent.json', (_req, res) => {
  res.json({
    schema_version: '1.0',
    name: 'Hive Merchant Onboard',
    description: '60-second x402 merchant onboarding. Issues a fresh Base wallet, generates express middleware snippet, and instruments 10 bps royalty attribution for every downstream settlement.',
    version: '1.0.0',
    brand_color: '#C08D23',
    treasury: MONROE,
    chain: 'base',
    chain_id: BASE_CHAIN_ID,
    usdc_contract: USDC_BASE,
    pricing: {
      onboard_flat_usdc: 9,
      royalty_bps: 10,
    },
    capabilities: ['merchant-onboard', 'x402', 'wallet-provisioning', 'royalty-attribution'],
    mcp_endpoint: '/mcp',
    tools: [
      { name: 'onboard_merchant', description: 'Onboard a new x402 merchant. Costs $9 USDC via x402 challenge on Base mainnet.' },
      { name: 'get_merchant_status', description: 'Get onboarding status and royalty ledger for a merchant_id.' },
      { name: 'attribute_settlement', description: 'Log a settlement attribution for royalty accounting (internal, requires INTERNAL_TOKEN).' },
    ],
    contact: 'steve@thehiveryiq.com',
    github: 'https://github.com/srotzin/hive-merchant-onboard',
  });
});

// ── POST /mcp → JSON-RPC ───────────────────────────────────────────────────
app.post('/mcp', (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') return res.status(400).json({ error: 'Invalid JSON-RPC version' });

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name: 'onboard_merchant',
            description: 'Onboard a new x402 merchant. Issues a fresh Base mainnet wallet, generates ready-to-paste express middleware, and instruments 10 bps royalty attribution. Costs $9 USDC via x402 challenge on Base mainnet.',
            inputSchema: {
              type: 'object',
              properties: {
                merchant_name: { type: 'string', description: 'Name of the merchant or project' },
                callback_url: { type: 'string', description: 'Webhook URL for payment callbacks' },
                asset_preference: { type: 'string', enum: ['USDC', 'USDT', 'either'], description: 'Settlement asset preference' },
                chain_preference: { type: 'string', enum: ['base', 'solana', 'either'], description: 'Settlement chain preference' },
              },
              required: ['merchant_name'],
            },
          },
          {
            name: 'get_merchant_status',
            description: 'Get onboarding status and royalty ledger for a merchant_id.',
            inputSchema: {
              type: 'object',
              properties: {
                merchant_id: { type: 'string', description: 'The merchant ID returned at onboard time' },
              },
              required: ['merchant_id'],
            },
          },
          {
            name: 'attribute_settlement',
            description: 'Log a settlement attribution for royalty accounting. Requires INTERNAL_TOKEN. Called by other Hive surfaces when they detect X-Hive-Attribution header.',
            inputSchema: {
              type: 'object',
              properties: {
                merchant_id: { type: 'string' },
                settlement_amount_usdc: { type: 'number', description: 'Settlement amount in USDC' },
                tx_hash: { type: 'string', description: 'On-chain transaction hash' },
                internal_token: { type: 'string', description: 'INTERNAL_TOKEN for auth' },
              },
              required: ['merchant_id', 'settlement_amount_usdc', 'internal_token'],
            },
          },
        ],
      },
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === 'onboard_merchant') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              action: 'payment_required',
              message: 'POST /v1/onboard/x402-merchant with X-PAYMENT header (x402 challenge). $9 USDC on Base mainnet.',
              payment_endpoint: '/v1/onboard/x402-merchant',
              amount_usdc: 9,
              payTo: MONROE,
              network: 'base',
            })
          }]
        }
      });
    }

    if (toolName === 'get_merchant_status') {
      const db = loadMerchants();
      const m = db[args.merchant_id];
      if (!m) {
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'merchant_not_found' }) }] } });
      }
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify({ merchant_id: m.merchant_id, created_at: m.created_at, total_settlements_attributed: m.total_settlements_attributed, total_royalties_collected: m.total_royalties_collected, status: m.status }) }] }
      });
    }

    if (toolName === 'attribute_settlement') {
      if (args.internal_token !== INTERNAL_TOKEN) {
        return res.json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'unauthorized' } });
      }
      return handleAttributeLogic(args, (err, result) => {
        if (err) return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
        res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

// ── POST /v1/onboard/x402-merchant ────────────────────────────────────────
app.post('/v1/onboard/x402-merchant', (req, res) => {
  const xPayment = req.headers['x-payment'];

  if (!xPayment) {
    // Issue x402 challenge
    res.status(402).json(gen402Response(req));
    return;
  }

  // Payment header present — log and proceed
  const { merchant_name, callback_url, asset_preference = 'USDC', chain_preference = 'base' } = req.body || {};
  if (!merchant_name) {
    return res.status(400).json({ error: 'merchant_name is required' });
  }

  // Generate merchant ID
  const merchant_id = 'hm_' + crypto.randomBytes(8).toString('hex');
  const created_at = new Date().toISOString();

  // Generate fresh wallet
  const wallet = ethers.Wallet.createRandom();
  const public_address = wallet.address;
  const privkey = wallet.privateKey;

  // Encrypt and store privkey
  const encrypted = encryptPrivkey(privkey);
  const walletPath = path.join(WALLETS_DIR, `${merchant_id}.enc`);
  fs.writeFileSync(walletPath, encrypted, 'utf8');

  // Generate x402 snippet
  const x402_snippet = generateX402Snippet(merchant_id, public_address, callback_url);

  // Compose test curl command
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || `localhost:${PORT}`;
  const base_url = `${protocol}://${host}`;
  const test_curl_command = `curl -s ${base_url}/v1/onboard/status/${merchant_id}`;

  // Royalty attribution header format
  const royalty_attribution_header_format = `X-Hive-Attribution: hivemerch:${merchant_id}`;

  // Log settlement
  const settlementRecord = {
    type: 'onboard',
    merchant_id,
    merchant_name,
    x_payment: xPayment,
    amount_usdc: 9,
    created_at,
    public_address,
  };
  fs.appendFileSync(SETTLEMENTS_LOG, JSON.stringify(settlementRecord) + '\n');

  // Store merchant record
  const db = loadMerchants();
  db[merchant_id] = {
    merchant_id,
    merchant_name,
    created_at,
    public_address,
    asset_preference,
    chain_preference,
    callback_url: callback_url || null,
    total_settlements_attributed: 0,
    total_royalties_collected: 0,
    status: 'active',
  };
  saveMerchants(db);

  res.json({
    merchant_id,
    public_address,
    created_at,
    asset_preference,
    chain_preference,
    x402_snippet,
    test_curl_command,
    royalty_attribution_header_format,
    royalty_bps: ROYALTY_BPS,
    message: `Merchant ${merchant_name} onboarded successfully. Include ${royalty_attribution_header_format} in every settlement request to earn royalty attribution.`,
  });
});

// ── GET /v1/onboard/status/:merchant_id ───────────────────────────────────
app.get('/v1/onboard/status/:merchant_id', (req, res) => {
  const db = loadMerchants();
  const m = db[req.params.merchant_id];
  if (!m) return res.status(404).json({ error: 'merchant_not_found' });
  res.json({
    merchant_id: m.merchant_id,
    created_at: m.created_at,
    total_settlements_attributed: m.total_settlements_attributed,
    total_royalties_collected: m.total_royalties_collected,
    status: m.status,
  });
});

// ── attribute logic helper ─────────────────────────────────────────────────
function handleAttributeLogic(body, cb) {
  const { merchant_id, settlement_amount_usdc, tx_hash } = body;
  const db = loadMerchants();
  if (!db[merchant_id]) return cb(new Error('merchant_not_found'));

  const royalty_usdc = (settlement_amount_usdc * ROYALTY_BPS) / 10000;
  db[merchant_id].total_settlements_attributed += 1;
  db[merchant_id].total_royalties_collected += royalty_usdc;
  saveMerchants(db);

  const record = {
    merchant_id,
    settlement_amount_usdc,
    royalty_usdc,
    tx_hash: tx_hash || null,
    attributed_at: new Date().toISOString(),
  };
  fs.appendFileSync(ROYALTIES_LOG, JSON.stringify(record) + '\n');

  cb(null, {
    merchant_id,
    settlement_amount_usdc,
    royalty_usdc,
    royalty_bps: ROYALTY_BPS,
    attributed_at: record.attributed_at,
    total_settlements_attributed: db[merchant_id].total_settlements_attributed,
    total_royalties_collected: db[merchant_id].total_royalties_collected,
  });
}

// ── POST /v1/onboard/attribute ─────────────────────────────────────────────
app.post('/v1/onboard/attribute', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (token !== INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  handleAttributeLogic(req.body || {}, (err, result) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json(result);
  });
});

// ── start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`hive-merchant-onboard listening on :${PORT}`);
  console.log(`treasury=${MONROE} chain=base usdc=${USDC_BASE}`);
});
