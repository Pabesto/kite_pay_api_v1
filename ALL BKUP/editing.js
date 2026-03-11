const crypto = require('crypto');
const bcrypt = require('bcrypt');

async function generateMerchantCredentials() {
  const merchantId = 'mid_' + ID.unique().slice(-8).toUpperCase();
  const apiSecret = crypto.randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(apiSecret, 12);
  return { merchantId, apiSecret, hash };
}

// Admin endpoint snippet
router.post('/admin/merchants', authenticateAdmin, async (req, res) => {
  const { name, email} = req.body;
  const creds = await generateMerchantCredentials();
  await databases.createDocument(DB_ID, MERCHANTS_ID, ID.unique(), {
    merchantId: creds.merchantId,
    apiSecretHash: creds.hash,
    name,
    email,
    status: false,
    createdAt: new Date().toISOString()
  });
  res.json({ success: true, merchantId: creds.merchantId, apiSecret: creds.apiSecret });
});

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

async function authenticateMerchant(req, res, next) {
  const auth = req.headers.authorization?.split(' ')[1];
  const { merchantId } = req.body || req.params;
  if (!auth || !merchantId) return res.status(401).json({ error: 'Missing credentials' });

  try {
    const merchant = await databases.listDocuments(DB_ID, MERCHANTS_ID, [Query.equal('merchantId', merchantId), Query.limit(1)]);
    if (!merchant.documents.length || !(await bcrypt.compare(auth, merchant.documents[0].apiSecretHash))) {
      return res.status(401).json({ error: 'Invalid merchant credentials' });
    }
    // Check limits, status
    req.merchant = merchant.documents[0];
    next();
  } catch (e) {
    res.status(500).json({ error: 'Auth failed' });
  }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const QRCode = require('qrcode');
const { generateUPIQR } = require('@sk-py/upi-qr');  // or 'upiqrcode'

router.post('/qr_generate', authenticateMerchant, async (req, res) => {
  try {
    const { amount = '500.00' } = req.body;  // Fixed ₹500 default
    const merchantId = req.merchant.merchantId;
    const vpa = process.env.RAZORPAY_VPA;  // yourvpa@razorpay
    const orderId = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const txnNumber = `txn_${Date.now()}`;

    // 1. Save pending request to DB
    const requestDoc = await databases.createDocument(
      APPWRITE_DATABASE_ID,
      TRANSACTIONS_COLLECTION_ID,  // Reuse or new qr_requests
      ID.unique(),
      {
        merchantId,
        orderId,
        txnNumber,
        amount: parseFloat(amount) * 100,  // Paise for Razorpay
        status: 'pending',
        vpa,
        createdAt: new Date().toISOString(),
        qrGenerated: false
      }
    );

    // 2. Generate UPI QR payload (NPCI compliant)
    const upiData = await generateUPIQR({
      payeeVPA: vpa,
      payeeName: 'KitePay',  // Your brand
      amount,
      currency: 'INR',
      transactionId: orderId,
      transactionNote: `Payment via KitePay MID:${merchantId.slice(-6)}`,
      transactionRef: txnNumber,
      minimumAmount: amount  // Enforce exact
    });

    // 3. Create base64 QR image from intent URL
    const qrBase64 = await QRCode.toDataURL(upiData.intent, {
      width: 300,
      margin: 1,
      color: { dark: '#000', light: '#FFF' }
    });

    // 4. Update DB with QR
    await databases.updateDocument(
      APPWRITE_DATABASE_ID,
      TRANSACTIONS_COLLECTION_ID,
      requestDoc.$id,
      { qrBase64, qrGenerated: true }
    );

    res.json({
      success: true,
      qr_base64: qrBase64,
      order_id: orderId,
      txn_number: txnNumber,
      time: new Date().toISOString(),
      vpa
    });
  } catch (error) {
    console.error('QR Generate error:', error);
    res.status(500).json({ error: 'Failed to generate QR' });
  }
});

