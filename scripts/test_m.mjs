// ESM test runner. Run from the PROJECT ROOT so the .env and image path resolve:
//   node scripts/test_m.mjs
//
// Note: it's `./transactionStatusMailer.js` (same folder, with the .js extension) —
// ESM imports need the extension, and there is no extra `scripts/` in the path.

import { sendMerchantHoldEmail } from './transactionStatusMailer.js';

await sendMerchantHoldEmail({
  posId: '9620581400',
  paymentIds: ['pay_T21bBZi6AjlTgY', 'pay_T20WA3duDvizI5'],
  image: 'image/razorpay_img.png',   // relative to where you run node (the project root)
});

console.log('done');
