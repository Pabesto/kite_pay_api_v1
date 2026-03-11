/**
 * DigiQR – Single File Integration
 * Auto Token Cache + Auto Refresh + Auto Retry
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

/* ================= CONFIG ================= */

const PINE_BASE_URL = 'https://identitytest.pinelabs.com';
const PINE_QR_BASE_URL = 'https://api-test.pinelabs.com';

/* ================= TOKEN CACHE ================= */

let tokenCache = {
  accessToken: null,
  expiresAt: null
};

const resetTokenCache = () => {
  tokenCache.accessToken = null;
  tokenCache.expiresAt = null;
};

/* ================= GET TOKEN ================= */

const getAccessToken = async () => {
  // reuse token with 60 sec buffer
  if (
    tokenCache.accessToken &&
    tokenCache.expiresAt &&
    Date.now() < tokenCache.expiresAt - 60000
  ) {
    return tokenCache.accessToken;
  }

  const params = new URLSearchParams();
  params.append('client_id', process.env.CLIENT_ID);
  params.append('client_secret', process.env.CLIENT_SECRET);
  params.append('grant_type', 'client_credentials');

  const response = await axios.post(
    `${PINE_BASE_URL}/realms/pinelabs/protocol/openid-connect/token`,
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  tokenCache.accessToken = response.data.access_token;
  tokenCache.expiresAt = Date.now() + response.data.expires_in * 1000;

  return tokenCache.accessToken;
};

/* ================= PINE REQUEST (AUTO RETRY) ================= */

const pineRequest = async (config, retry = true) => {
  try {
    const token = await getAccessToken();

    config.headers = {
      ...(config.headers || {}),
      Authorization: `Bearer ${token}`
    };

    return await axios(config);
  } catch (err) {
    const pineErr = err.response?.data;

    // Auto retry on token expiry
    if (retry && pineErr?.code === '1005') {
      resetTokenCache();
      return pineRequest(config, false);
    }

    throw err;
  }
};

/* ================= BASIC HEADER CHECK ================= */

const authCheck = (req, res, next) => {
  if (!req.headers['merchant-reference-id']) {
    return res.status(400).json({
      code: '2001',
      message: 'Merchant reference id missing'
    });
  }
  next();
};

/* ================= CREATE QR ================= */

router.post(
  '/v1/billing-integration/qr-payments/transactions',
  authCheck,
  async (req, res) => {
    try {
      const response = await pineRequest({
        method: 'POST',
        url: `${PINE_QR_BASE_URL}/v1/billing-integration/qr-payments/transactions`,
        data: req.body,
        headers: {
          'Content-Type': 'application/json',
          'merchant-reference-id': req.headers['merchant-reference-id'],
          'callback-url': req.headers['callback-url']
        }
      });

      res.json(response.data);
    } catch (err) {
      res.status(400).json(
        err.response?.data || {
          code: '1001',
          message: 'Qr Generation failed!'
        }
      );
    }
  }
);

/* ================= GET STATUS ================= */

router.get(
  '/v1/billing-integration/qr-payments/transactions',
  authCheck,
  async (req, res) => {
    try {
      const response = await pineRequest({
        method: 'GET',
        url: `${PINE_QR_BASE_URL}/v1/billing-integration/qr-payments/transactions`,
        params: { 'transaction-id': req.query['transaction-id'] },
        headers: {
          'Content-Type': 'application/json',
          'merchant-reference-id': req.headers['merchant-reference-id']
        }
      });

      res.json(response.data);
    } catch (err) {
      res.status(400).json({
        code: '1002',
        message: 'Transaction enquiry failed!'
      });
    }
  }
);

/* ================= CANCEL TRANSACTION ================= */

router.post(
  '/v1/billing-integration/qr-payments/transactions/:transactionId/cancel',
  authCheck,
  async (req, res) => {
    try {
      const response = await pineRequest({
        method: 'POST',
        url: `${PINE_QR_BASE_URL}/v1/billing-integration/qr-payments/transactions/${req.params.transactionId}/cancel`,
        data: req.body,
        headers: {
          'Content-Type': 'application/json',
          'merchant-reference-id': req.headers['merchant-reference-id']
        }
      });

      res.json(response.data);
    } catch (err) {
      res.status(400).json({
        code: '1007',
        message: 'Cancellation failed!'
      });
    }
  }
);

/* ================= CALLBACK ================= */

router.post('/callback/qr-status', async (req, res) => {
  console.log('DIGIQR CALLBACK:', JSON.stringify(req.body, null, 2));

  // TODO: update transaction in DB here

  res.json({
    status: 'SUCCESS',
    message: 'Callback successful'
  });
});

module.exports = router;



/*

Purpose	URL
Create QR	POST /pinelabs/v1/billing-integration/qr-payments/transactions
Get Status	GET /pinelabs/v1/billing-integration/qr-payments/transactions?transaction-id=123
Cancel	POST /pinelabs/v1/billing-integration/qr-payments/transactions/{id}/cancel
Callback	POST /pinelabs/callback/qr-status



https://chatgpt.com/share/69484717-e524-800a-bdba-30fa5ca355ce

*/