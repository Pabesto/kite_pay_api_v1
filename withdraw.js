// -----------------------------------------------------------------------------------------------------
// routes/user.js
// This file contains the API endpoints for users.

const express = require('express');
const multer = require('multer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, Withdrawal_request_collectionId, bucketId, emitTxnNew, authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole) => {

  function generateWithdrawalId() {
    const prefix = 'wdh_';
    const timestamp = Date.now(); // milliseconds since epoch
    const random = Math.floor(100 + Math.random() * 900); // 3-digit random number
    return `${prefix}${timestamp}${random}`;
  }

    // Users can post a withdrawal request
    router.post('/withdraw', async (req, res) => {
      const { userId, qrId, holderName, amount, upiId, bankName, accountNumber, ifscCode, mode } = req.body;
        // console.log('Withdraw request received:', req.body);
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
      // console.log('Generated Withdrawal ID:', wdh_id);

      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(Date.now() + istOffset).toISOString();

      try {

        // 🔹 Check existing pending requests
        const pendingRequests = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          [
            Query.equal("userId", userId),
            Query.equal("status", "pending"),
          ]
        );

        if (pendingRequests.total >= 2) {
          return res.status(400).json({
            error: "You already have the maximum number of pending withdrawal requests (2)."
          });
        }

        const response = await databases.createDocument(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId, // <-- collection ID
          ID.unique(),
          {
            id : wdh_id,
            userId : userId,
            qrId : qrId || null,
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

    // Users can post a withdrawal request (new version with validations and balance checks)
    router.post('/withdraw_new', async (req, res) => {
      const { userId, qrId, holderName, amount, upiId, bankName, accountNumber, ifscCode, mode } = req.body;

      console.log('Withdraw request received:', req.body);

      // return res.status(503).json({ error: 'Withdrawals are temporarily disabled for maintenance' });

      // basic validations
      if (!['upi', 'bank'].includes(mode)) return res.status(400).json({ error: 'Invalid mode. Must be upi or bank.' });
      if (!userId || !holderName) return res.status(400).json({ error: 'userId and name are required' });
      if (mode === 'upi' && !upiId) return res.status(400).json({ error: 'UPI ID is required for UPI withdrawal' });
      if (mode === 'bank' && (!bankName || !accountNumber || !ifscCode)) {
        return res.status(400).json({ error: 'Bank details are incomplete' });
      }

      // normalize money to paise
      const toPaise = (val) => {
        const n = Number(val);
        if (!isFinite(n) || n <= 0) return null;
        return Math.round(n * 100);
      };
      const amountPaise = toPaise(amount);
      if (amountPaise == null) return res.status(400).json({ error: 'Invalid amount' });

      const wdh_id = generateWithdrawalId();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(Date.now() + istOffset).toISOString();

      try {
        // Enforce max 2 pending per user
        const pendingRequests = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          [Query.equal('userId', userId), Query.equal('status', 'pending')]
        );
        if (pendingRequests.total >= 2) {
          return res.status(400).json({ error: 'You already have the maximum number of pending withdrawal requests (2).' });
        } [1]

        // Load QR and validate available balance
        const qrList = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          [Query.equal('qrId', qrId), Query.limit(1)]
        );
        if (!qrList.documents.length) return res.status(404).json({ error: 'QR not found' }); [1]
        const qr = qrList.documents[0]; // has totals in paise [1]

        const total = Number(qr.totalPayInAmount || 0);
        const approved = Number(qr.withdrawalApprovedAmount || 0);
        const requested = Number(qr.withdrawalRequestedAmount || 0);
        const available = Math.max(0, total - approved - requested);

        console.log(`QR Ledger - Total: ${total}, Approved: ${approved}, Requested: ${requested}, Available: ${available}, Requested Withdrawal: ${amountPaise}`);

        if (amountPaise > available) {
          return res.status(400).json({ error: 'Requested amount exceeds available balance' });
        } [1]

        // Update QR ledger: bump requested, recompute available
        const newRequested = requested + amountPaise;
        const newAvailable = Math.max(0, total - approved - newRequested);
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          qr.$id,
          {
            withdrawalRequestedAmount: newRequested,
            amountAvailableForWithdrawal: newAvailable,
          }
        ); [1]

        // Create withdrawal document
        const response = await databases.createDocument(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          ID.unique(),
          {
            id: wdh_id,
            userId,
            qrId: qrId || null,
            holderName,
            amount: amount, // store in Rs Not paise
            mode,
            upiId: upiId || null,
            bankName: bankName || null,
            accountNumber: accountNumber || null,
            ifscCode: ifscCode || null,
            status: 'pending',
            createdAt: istTime,
          }
        ); [1]

        return res.json({ success: true, data: response });
      } catch (err) {
        console.error('Error saving withdraw request:', err);
        return res.status(500).json({ error: 'Failed to save withdrawal request' });
      }
    });

    // GET /withdrawals?status=pending&limit=20&cursor=docId
    router.get('/withdrawals_paginated', authenticateAdmin, async (req, res) => {
      try {
        const { status, limit: limitStr, cursor } = req.query;

        // 1) Parse limit with sane default + cap
        const DEFAULT_LIMIT = 25;
        const MAX_LIMIT = 100;
        const limit = Math.min(
          Math.max(parseInt(limitStr ?? DEFAULT_LIMIT, 10) || DEFAULT_LIMIT, 1),
          MAX_LIMIT
        );

        // 2) Build Appwrite queries
        const queries = [];

        if (status) {
          queries.push(Query.equal('status', status));
        }

        // Stable order by creation time (newest first)
        queries.push(Query.orderDesc('$createdAt'));

        // Apply cursor if provided (keyset pagination using $id)
        if (cursor) {
          queries.push(Query.cursorAfter(cursor));
        }

        // Page size
        queries.push(Query.limit(limit));

        // 3) Execute
        const result = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          queries
        );

        // 4) Prepare response: map documents, compute nextCursor
        const docs = result.documents || [];

        // Keep $id for pagination cursor
        const withdrawals = docs.map((doc) => {
          const {
            $id,
            // $collectionId,
            // $databaseId,
            // $createdAt,
            // $updatedAt,
            // $permissions,
            ...customFields
          } = doc;

          // Optionally include these for debugging/admin needs:
          // customFields._id = $id;
          // customFields._createdAt = $createdAt;

          return customFields;
        });

        // When full page returned, expose the nextCursor as last doc $id
        const lastDoc = docs.length > 0 ? docs[docs.length - 1] : null;
        const nextCursor = docs.length === limit && lastDoc ? lastDoc.$id : null;

        return res.json({
          count: result.total,     // total matching (may be approximate for large sets)
          withdrawals,
          nextCursor,              // client passes this as cursor on next request
        });
      } catch (error) {
        console.error('❌ Error fetching withdrawals:', error);
        return res.status(500).json({ error: 'Failed to fetch withdrawal requests' });
      }
    });

    // GET /user_withdrawals?userId=...&status=pending&limit=20&cursor=<docId>
    router.get('/user_withdrawals_paginated', async (req, res) => {
      try {
        const { status, userId, limit: limitStr, cursor } = req.query;

        // Parse and cap limit
        const DEFAULT_LIMIT = 25;
        const MAX_LIMIT = 100;
        const limit = Math.min(
          Math.max(parseInt(limitStr ?? DEFAULT_LIMIT, 10) || DEFAULT_LIMIT, 1),
          MAX_LIMIT
        );

        // Build queries (order by newest first for stable keyset pagination)
        const queries = [];

        if (status) {
          queries.push(Query.equal('status', status));
        }

        if (userId) {
          queries.push(Query.equal('userId', userId));
        }

        // Order by $createdAt descending
        queries.push(Query.orderDesc('$createdAt')); // ensure index on $createdAt for performance

        // Cursor-based pagination
        if (cursor) {
          queries.push(Query.cursorAfter(cursor));
        }

        // Page size
        queries.push(Query.limit(limit));

        // Fetch
        const result = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          queries
        );

        // Map documents while computing nextCursor from the last doc's $id
        const docs = result.documents || [];
        const withdrawals = docs.map((doc) => {
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

        const lastDoc = docs.length ? docs[docs.length - 1] : null;
        const nextCursor = docs.length === limit && lastDoc ? lastDoc.$id : null;

        return res.json({
          count: result.total,   // optional total
          withdrawals,
          nextCursor,            // pass this back as cursor on next request
        });
      } catch (error) {
        console.error('❌ Error fetching withdrawals:', error.message);
        return res.status(500).json({ error: 'Failed to fetch withdrawal requests' });
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
        const result = await databases.listDocuments(APPWRITE_DATABASE_ID, Withdrawal_request_collectionId, queries);
        
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
          APPWRITE_DATABASE_ID,
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
        const result = await databases.listDocuments(APPWRITE_DATABASE_ID, Withdrawal_request_collectionId, [
          Query.equal('id', id),
          Query.limit(1),
        ]);

        if (result.total === 0) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        const doc = result.documents[0];

        await databases.updateDocument(APPWRITE_DATABASE_ID, Withdrawal_request_collectionId, doc.$id, {
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

    // POST /withdrawals/approve_new (with balance and ledger updates)
    router.post('/withdrawals/approve_new', authenticateAdmin, async (req, res) => {
      const { id, utrNumber } = req.body;

      if (!id || !utrNumber || utrNumber.trim().length < 5) {
        return res.status(400).json({ error: 'Invalid ID or UTR number too short' });
      }

      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const approvedAtIST = new Date(Date.now() + istOffsetMs).toISOString();

      try {
        // 1) Find withdrawal by business id
        const list = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          [Query.equal('id', id), Query.limit(1)]
        ); // query -> then pick documents [19][9]

        if (!list.total) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }
        const w = list.documents[0];

        if (w.status !== 'pending') {
          return res.status(400).json({ error: `Cannot approve a ${w.status} request` });
        }

        // normalize money to paise
        const toPaise = (val) => {
        const n = Number(val);
          if (!isFinite(n) || n <= 0) return null;
          return Math.round(n * 100);
        };

        const amountPaise = toPaise(w.amount);
        const qrId = w.qrId;
        if (!qrId || amountPaise <= 0) {
          return res.status(400).json({ error: 'Invalid withdrawal document data' });
        }

        // 2) Load QR document
        const qrList = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          [Query.equal('qrId', qrId), Query.limit(1)]
        ); // list and index 0 safely [19]
        if (!qrList.documents.length) {
          return res.status(404).json({ error: 'QR not found for withdrawal' });
        }
        const qr = qrList.documents[0];

        // 3) Compute new ledger values (all in paise)
        const total = Number(qr.totalPayInAmount || 0);
        const approved = Number(qr.withdrawalApprovedAmount || 0);
        const requested = Number(qr.withdrawalRequestedAmount || 0);

        if (requested < amountPaise) {
          // Defensive: don’t go negative if pending bucket is lower than request
          return res.status(409).json({ error: 'Pending requested amount is lower than approval amount' });
        }

        const newRequested = requested - amountPaise;
        const newApproved = approved + amountPaise;
        const newAvailable = Math.max(0, total - newApproved - newRequested);

        // 4) Update QR ledger first
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          qr.$id,
          {
            withdrawalRequestedAmount: newRequested,
            withdrawalApprovedAmount: newApproved,
            amountAvailableForWithdrawal: newAvailable,
          }
        ); // update by $id [5][19]

        // 5) Update withdrawal doc
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          w.$id,
          {
            status: 'approved',
            utrNumber: utrNumber.trim(),
            processed_at: approvedAtIST,
            rejectionReason: null,
          }
        ); // update by $id [5]

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
        const result = await databases.listDocuments(APPWRITE_DATABASE_ID, Withdrawal_request_collectionId, [
          Query.equal('id', id),
          Query.limit(1),
        ]);

        if (result.total === 0) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        const doc = result.documents[0];

        await databases.updateDocument(APPWRITE_DATABASE_ID, Withdrawal_request_collectionId, doc.$id, {
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

    // POST /withdrawals/reject_new (new with balance and ledger updates)
    router.post('/withdrawals/reject_new', authenticateAdmin, async (req, res) => {
      const { id, reason } = req.body;

      if (!id || !reason || reason.trim().length < 4) {
        return res.status(400).json({ error: 'Invalid ID or reason too short' });
      }

      try {
        // 1) Find withdrawal by business id
        const result = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          [Query.equal('id', id), Query.limit(1)]
        ); // list then index 0 [19][1]

        if (!result.total) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        const w = result.documents[0];
        if (w.status !== 'pending') {
          return res.status(400).json({ error: `Cannot reject a ${w.status} request` });
        }

        // normalize money to paise
        const toPaise = (val) => {
        const n = Number(val);
          if (!isFinite(n) || n <= 0) return null;
          return Math.round(n * 100);
        };

        const amountPaise = toPaise(w.amount);
        const qrId = w.qrId;
        if (!qrId || amountPaise <= 0) {
          return res.status(400).json({ error: 'Invalid withdrawal document data' });
        }

        // 2) Load QR document
        const qrList = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          [Query.equal('qrId', qrId), Query.limit(1)]
        ); // list then index 0 [19]
        if (!qrList.documents.length) {
          return res.status(404).json({ error: 'QR not found for withdrawal' });
        }
        const qr = qrList.documents[0];

        // 3) Compute new ledger values (all in paise)
        const total = Number(qr.totalPayInAmount || 0);
        const approved = Number(qr.withdrawalApprovedAmount || 0);
        const requested = Number(qr.withdrawalRequestedAmount || 0);

        if (requested < amountPaise) {
          return res.status(409).json({ error: 'Pending requested amount is lower than rejection amount' });
        }

        const newRequested = requested - amountPaise;                 // return amount to availability
        const newApproved = approved;                                  // unchanged
        const newAvailable = Math.max(0, total - newApproved - newRequested);

        // 4) Update QR ledger
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          qr.$id,
          {
            withdrawalRequestedAmount: newRequested,
            amountAvailableForWithdrawal: newAvailable,
          }
        ); // by $id [18]

        // 5) Update withdrawal document
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          w.$id,
          {
            status: 'rejected',
            rejectionReason: reason.trim(),
            utrNumber: null,
            processed_at: new Date().toISOString(),
          }
        ); // by $id [18]

        return res.json({ success: true, message: 'Withdrawal rejected' });
      } catch (err) {
        console.error('❌ Reject error:', err);
        return res.status(500).json({ error: 'Failed to reject withdrawal' });
      }
    });

    // GET all config
    router.get("/config", async (req, res) => {
      try {
        const docs = await databases.listDocuments(APPWRITE_DATABASE_ID, '68a73217002ed987b246');

        // convert docs into a key:value map
        const config = {};
        for (let doc of docs.documents) {
          let parsedValue = doc.value;

          // auto-type parsing
          if (doc.type === "integer") {
            parsedValue = parseInt(doc.value);
          } else if (doc.type === "double") {
            parsedValue = parseFloat(doc.value);
          } else if (doc.type === "boolean") {
            parsedValue = (doc.value === "true");
          } else if (doc.type === "json") {
            parsedValue = JSON.parse(doc.value);
          } else {
            parsedValue = doc.value;
          }

          config[doc.key] = parsedValue;
        }

        res.json({ success: true, config });
      } catch (err) {
        console.error("Error fetching config:", err);
        res.status(500).json({ success: false, error: "Failed to fetch config" });
      }
    });


    return router;
    
};