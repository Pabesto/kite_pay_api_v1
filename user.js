// -----------------------------------------------------------------------------------------------------
// routes/user.js
// This file contains the API endpoints for users.

const express = require('express');
const multer = require('multer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, databaseId, Qr_collectionId, Withdrawal_request_collectionId, bucketId, authenticateAdmin, InputFile, roleAuth, requireRole) => {

  function generateWithdrawalId() {
    const prefix = 'wdh_';
    const timestamp = Date.now(); // milliseconds since epoch
    const random = Math.floor(100 + Math.random() * 900); // 3-digit random number
    return `${prefix}${timestamp}${random}`;
  }

    // Users can post a withdrawal request
    router.post('/withdraw', async (req, res) => {
      const { userId, holderName, amount, upiId, bankName, accountNumber, ifscCode, mode } = req.body;
        console.log('Withdraw request received:', req.body);
      // Input validation
      if (!['upi', 'bank'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid mode. Must be upi or bank.' });
      }

      if (!userId || !holderName) {
        return res.status(400).json({ error: 'userId and name are required' });
      }

      if (mode === 'upi' && !upiId) {
        return res.status(400).json({ error: 'UPI ID is required for UPI withdrawal' });
      }

      if (mode === 'bank' && (!bankName || !accountNumber || !ifscCode)) {
        return res.status(400).json({ error: 'Bank details are incomplete' });
      }

      const wdh_id = generateWithdrawalId();
      console.log('Generated Withdrawal ID:', wdh_id);

      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(Date.now() + istOffset).toISOString();


      try {
        const response = await databases.createDocument(
          databaseId,
          Withdrawal_request_collectionId, // <-- collection ID
          ID.unique(),
          {
            id : wdh_id,
            userId : userId,
            holderName : holderName,
            amount  : amount,
            mode : mode,
            upiId: upiId || null,
            bankName: bankName || null,
            accountNumber: accountNumber || null,
            ifscCode: ifscCode || null,
            status: 'pending', // default
            createdAt: istTime
          }
        );

        return res.json({ success: true, data: response });
      } catch (err) {
        console.error('Error saving withdraw request:', err);
        return res.status(500).json({ error: 'Failed to save withdrawal request' });
      }
    });

    // GET all withdrawal requests
    router.get('/withdrawals', authenticateAdmin, async (req, res) => {
      const status = req.query.status; // optional: 'pending', 'approved', 'rejected'
      const queries = [];

      if (status) {
        queries.push(Query.equal('status', status));
      }

      queries.push(Query.orderDesc('$createdAt'));
      queries.push(Query.limit(100)); // adjust limit as needed

      try {
        const result = await databases.listDocuments(databaseId, Withdrawal_request_collectionId, queries);
        
        const withdrawals = result.documents.map((doc) => {
          // Destructure and remove all Appwrite system fields
          const {
            $id,
            $collectionId,
            $databaseId,
            $createdAt,
            $updatedAt,
            $permissions,
            ...customFields
          } = doc;

          return customFields;
        });
        
        res.json({
          count: result.total,
          withdrawals: withdrawals,
        });
      } catch (error) {
        console.error('❌ Error fetching withdrawals:', error.message);
        res.status(500).json({ error: 'Failed to fetch withdrawal requests' });
      }
    });

    router.get('/user_withdrawals', async (req, res) => {
      const status = req.query.status;   // optional: 'pending', 'approved', 'rejected'
      const userId = req.query.userId;   // optional: to fetch specific user's withdrawals
      const queries = [];

      if (status) {
        queries.push(Query.equal('status', status));
      }

      if (userId) {
        queries.push(Query.equal('userId', userId));
      }

      queries.push(Query.orderDesc('$createdAt'));
      queries.push(Query.limit(100)); // adjust limit if needed

      try {
        const result = await databases.listDocuments(
          databaseId,
          Withdrawal_request_collectionId,
          queries
        );

        const withdrawals = result.documents.map((doc) => {
          const {
            $id,
            $collectionId,
            $databaseId,
            $createdAt,
            $updatedAt,
            $permissions,
            ...customFields
          } = doc;

          return customFields;
        });

        res.json({
          count: result.total,
          withdrawals: withdrawals,
        });
      } catch (error) {
        console.error('❌ Error fetching withdrawals:', error.message);
        res.status(500).json({ error: 'Failed to fetch withdrawal requests' });
      }
    });


    // POST /withdrawals/approve
    router.post('/withdrawals/approve', authenticateAdmin, async (req, res) => {
      const { id, utrNumber } = req.body;

      if (!id || !utrNumber || utrNumber.trim().length < 5) {
        return res.status(400).json({ error: 'Invalid ID or UTR number too short' });
      }

      try {
        const result = await databases.listDocuments(databaseId, Withdrawal_request_collectionId, [
          Query.equal('id', id),
          Query.limit(1),
        ]);

        if (result.total === 0) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        const doc = result.documents[0];

        await databases.updateDocument(databaseId, Withdrawal_request_collectionId, doc.$id, {
          status: 'approved',
          utrNumber: utrNumber.trim(),
          rejectionReason: null, // clear if any
        });

        return res.json({ success: true, message: 'Withdrawal approved' });
      } catch (err) {
        console.error('❌ Approve error:', err);
        return res.status(500).json({ error: 'Failed to approve withdrawal' });
      }
    });

    // POST /withdrawals/reject
    router.post('/withdrawals/reject', authenticateAdmin, async (req, res) => {
      const { id, reason } = req.body;

      if (!id || !reason || reason.trim().length < 4) {
        return res.status(400).json({ error: 'Invalid ID or reason too short' });
      }

      try {
        const result = await databases.listDocuments(databaseId, Withdrawal_request_collectionId, [
          Query.equal('id', id),
          Query.limit(1),
        ]);

        if (result.total === 0) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        const doc = result.documents[0];

        await databases.updateDocument(databaseId, Withdrawal_request_collectionId, doc.$id, {
          status: 'rejected',
          rejectionReason: reason.trim(),
          utrNumber: null, // clear if any
        });

        return res.json({ success: true, message: 'Withdrawal rejected' });
      } catch (err) {
        console.error('❌ Reject error:', err);
        return res.status(500).json({ error: 'Failed to reject withdrawal' });
      }
    });



    return router;
    
};