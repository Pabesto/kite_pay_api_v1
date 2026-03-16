const axios = require('axios');
const PaytmChecksum = require('paytmchecksum'); // Install via npm

const mid = 'cbeXrV55846175991466';
const key = 'pMXxBbEFlPHZBlRa';
const orderSearchType = 'ALL';  // As per your requirement
const orderSearchStatus = 'SUCCESS'; // Example filter
const fromDate = '2025-09-19'; // yyyy-mm-dd
const toDate = '2025-09-20';   // yyyy-mm-dd

// Request body
const body = {
  mid: mid,
  orderSearchType: orderSearchType,
  orderSearchStatus: orderSearchStatus,
  fromDate: fromDate,
  toDate: toDate,
  pageNumber: 1,
  pageSize: 10, // Fetch up to 10 orders for demo
};

// Head section for checksum authentication
async function getOrderList() {
  const paytmParams = {};
  paytmParams.body = body;

  // Generate signature (checksum)
  const checksum = await PaytmChecksum.generateSignature(JSON.stringify(body), key);

  paytmParams.head = {
    requestTimestamp: `${Date.now()}`,
    tokenType: "CHECKSUM",
    signature: checksum
  };

  try {
    const response = await axios.post(
      'https://securegw.paytm.in/order/api/orderList', // For production, use the official endpoint
      {
        body: paytmParams.body,
        head: paytmParams.head
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Order List Response:', response.data);
  } catch (err) {
    console.error('Error:', err?.response?.data || err.message);
  }
}

getOrderList();
