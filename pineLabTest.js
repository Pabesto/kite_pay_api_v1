/**
 * PineOne API Integration
 * Pine Labs - Transaction & Store Management APIs
 * Supports: Test & Production environments
 */

const https = require("https");
const http = require("http");

// ─────────────────────────────────────────────
// CONFIGURATION — Fill in your credentials here
// ─────────────────────────────────────────────

const CONFIG = {
  test: {
    baseUrl: "https://api-ct.pinelabs.com",
    clientId: "Utkarsh_Merchant__1_7263",
    clientSecret: "sFBhQSonzT3r1TDgwSlD9HFL9jBlnXZ5",
  },
  production: {
    baseUrl: "https://api-c.pinelabs.com",
    clientId: "SCANSERVE_AI_PRIVATE_LIMIT_SV1ZSIAI",
    clientSecret: "d3tR9f3SDVK5ipmKVQan3YbdR2amGFqv",
  },

  //   production: {
  //   baseUrl: "https://api-c.pinelabs.com",
  //   clientId: "PABESTO_TECH_PRIVATE_LIMITED_M69N1IPX",
  //   clientSecret: "MWTzNft5GvY00sGcSV67VRj5Xa9vgy4V",
  // },

};

// Set active environment: "test" or "production"
const ACTIVE_ENV = "production";

// ─────────────────────────────────────────────
// PINE ONE CLIENT
// ─────────────────────────────────────────────
class PineOneClient {
  constructor(env = "production") {
    if (!CONFIG[env]) {
      throw new Error(`Unknown environment: "${env}". Use "test" or "production".`);
    }
    this.env = env;
    this.config = CONFIG[env];
    this.token = this._encodeCredentials(
      this.config.clientId,
      this.config.clientSecret
    );
  }

  _encodeCredentials(clientId, clientSecret) {
    return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  }

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.baseUrl + path);
      const isHttps = url.protocol === "https:";
      const lib = isHttps ? https : http;

      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${this.token}`,
          ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
        },
      };

      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch {
            resolve({ statusCode: res.statusCode, data });
          }
        });
      });

      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── Transaction Summary API ──────────────────
  async getTransactionSummary(filters = {}, page = 0, size = 10) {
    const { fromDate, toDate, txnStatus, paymentMode, batchStatus, storeId, posId, hardwareId, tid, acquirers } = filters;

    const body = {
      ...(fromDate && { fromDate }),
      ...(toDate && { toDate }),
      ...(txnStatus?.length && { txnStatus }),
      ...(paymentMode && { paymentMode }),
      ...(batchStatus && { batchStatus }),
      ...(storeId?.length && { storeId }),
      ...(posId?.length && { posId }),
      ...(hardwareId?.length && { hardwareId }),
      ...(tid?.length && { tid }),
      ...(acquirers?.length && { acquirers }),
    };

    return this._request("POST", `/transactions/summary?page=${page}&size=${size}`, body);
  }

  // ── Transaction Details API ──────────────────
  async getTransactionDetails(transactionId, paymentMode, options = {}) {
    const body = {
      transactionId,
      paymentMode,
      ...(options.fromDate && { fromDate: options.fromDate }),
      ...(options.toDate && { toDate: options.toDate }),
      ...(options.cloudRefTxnId && { cloudRefTxnId: options.cloudRefTxnId }),
    };

    return this._request(
      "POST",
      `/transactions/details?page=${options.page || 0}&size=${options.size || 1}`,
      body
    );
  }

  // ── Store List API ───────────────────────────
  async getStores(page = 0, size = 10) {
    return this._request("GET", `/transactions/stores?page=${page}&size=${size}`);
  }

  // ── Credential Validation ────────────────────
  async testCredentials() {
    console.log(`\n🔐 Testing credentials for [${this.env.toUpperCase()}] environment...`);
    console.log(`   Base URL : ${this.config.baseUrl}`);
    console.log(`   Client ID: ${this.config.clientId}`);

    try {
      // Use Store List as a lightweight ping — no date range needed
      const result = await this.getStores(0, 1);

      if (result.statusCode === 200) {
        console.log("✅ Credentials valid! Connection successful.");
        console.log(`   Stores found: ${result.data.totalCount ?? "N/A"}`);
        return true;
      } else if (result.statusCode === 401) {
        console.error("❌ Authentication failed (401). Check Client ID and Secret.");
      } else if (result.statusCode === 404) {
        console.error("❌ Endpoint not found (404). Check base URL for environment.");
      } else {
        console.error(`❌ Unexpected response: HTTP ${result.statusCode}`);
        console.error("   Response:", JSON.stringify(result.data, null, 2));
      }
    } catch (err) {
      console.error("❌ Network error:", err.message);
    }

    return false;
  }
}

// ─────────────────────────────────────────────
// EXAMPLE USAGE
// ─────────────────────────────────────────────
async function main() {
  const client = new PineOneClient(ACTIVE_ENV);

  // 1. Test credentials first
  const isValid = await client.testCredentials();
  if (!isValid) {
    console.log("\n⚠️  Fix credentials in CONFIG before proceeding.");
    return;
  }

  console.log("\n─────────────────────────────────────────");
  console.log("  Running example API calls...");
  console.log("─────────────────────────────────────────\n");

  // 2. Get stores
  console.log("📍 Fetching store list (page 0, size 5)...");
  const stores = await client.getStores(0, 5);
  console.log("Stores:", JSON.stringify(stores.data, null, 2));

  // 3. Transaction summary - all successful transactions
  console.log("\n📊 Fetching transaction summary (SUCCESS, last 3 months)...");
  const summary = await client.getTransactionSummary(
    {
      fromDate: "2026-04-01T00:00:00",
      toDate: "2026-04-12T00:00:00",
      txnStatus: ["SUCCESS"],
    },
    0,  // page
    5   // size
  );
  console.log("Summary:", JSON.stringify(summary.data, null, 2));

  // 4. Transaction summary filtered by CARD payment
  // console.log("\n💳 Fetching CARD transactions (OPEN batch)...");
  // const cardSummary = await client.getTransactionSummary(
  //   {
  //     fromDate: "2024-10-01T00:00:00",
  //     toDate: "2025-01-01T00:00:00",
  //     txnStatus: ["SUCCESS"],
  //     paymentMode: "CARD",
  //     batchStatus: "OPEN",
  //   },
  //   0,
  //   5
  // );
  // console.log("CARD Summary:", JSON.stringify(cardSummary.data, null, 2));

  // 5. Transaction details lookup
  // Replace "REPLACE_WITH_REAL_TXN_ID" with an actual transactionId from summary results
  const txnId = "1388368104";
  if (txnId == "1388368104") {
    console.log(`\n🔍 Fetching details for transaction: ${txnId}...`);
    const details = await client.getTransactionDetails(txnId, "UPI", {
      fromDate: "2026-04-01T00:00:00",
      toDate: "2026-04-31T00:00:00",
    });
    console.log("Transaction Details:", JSON.stringify(details.data, null, 2));
  } else {
    console.log("\n🔍 Transaction Details skipped — set a real txnId in main().");
  }

}

// Export the client for use as a module
module.exports = { PineOneClient, CONFIG };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}








