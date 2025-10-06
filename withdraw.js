// -----------------------------------------------------------------------------------------------------
// routes/user.js
// This file contains the API endpoints for users.

const express = require('express');
const multer = require('multer');
const moment = require('moment-timezone');

const { updateDashboardCounter } = require('./dashboardCounters');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, Withdrawal_request_collectionId, bucketId, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole) => {

  function generateWithdrawalId() {
    const prefix = 'wdh_';
    const timestamp = Date.now(); // milliseconds since epoch
    const random = Math.floor(100 + Math.random() * 900); // 3-digit random number
    return `${prefix}${timestamp}${random}`;
  }

  // Helper to get user by userId
  async function getUserMeta(userId) {
    const users = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      APPWRITE_USERS_META_COLLECTION_ID,
      [Query.equal("userId", userId), Query.limit(1)]
    );
    return users.documents[0];
  }

  // Helper to get user by userId
  async function getadminMeta(userId) {
    const users = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      APPWRITE_USERS_META_COLLECTION_ID,
      [Query.equal("role", "admin"), Query.limit(1)]
    );
    return users.documents[0];
  }

    // Helper to calculate commission
    function calculateCommission(preAmount, commissionRatePercent) {
      return Math.ceil(preAmount * commissionRatePercent / 100);
    }

    router.post('/withdraw_commission_preview', async (req, res) => {
      const { userId, qrId, preAmount } = req.body;

      // console.log('Withdraw commission preview request received:', req.body);

      if (!userId || !preAmount) {
        return res.status(400).json({ error: 'userId and name are required' });
      }

      // Normalize preAmount
      const preAmountPaise = preAmount * 100;

      const usrDet = await getUserMeta(userId);
      let commissionRate = Number(usrDet.commission || 0);

      if (usrDet.parentId) {
        const parentDet = await getUserMeta(usrDet.parentId);
        commissionRate += Number(parentDet.commission || 0);
      }

      const commissionRs = calculateCommission(preAmount, commissionRate);
      const totalAmount = Number(preAmount) + Number(commissionRs);

      // Load QR document
      const qrList = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        Qr_collectionId,
        [Query.equal('qrId', qrId), Query.limit(1)]
      );
      if (!qrList.documents.length) {
        return res.status(404).json({ error: 'QR not found for withdrawal' });
      }
      const qr = qrList.documents[0];
      const amountAvailableForWithdrawal = Number(qr.amountAvailableForWithdrawal || 0);

      // console.log(`Preview Withdrawal - PreAmountPaise: ${preAmountPaise}, CommissionRs: ${commissionRs}, Available: ${amountAvailableForWithdrawal}`);

      if ((preAmountPaise + commissionRs * 100) > amountAvailableForWithdrawal) {
        return res.status(400).json({
          error: 'Requested amount including commission exceeds available balance',
          preAmountPaise,
          commissionPaise: commissionRs * 100,
          amountAvailableForWithdrawal
        });
      }

      const config_docs = await databases.listDocuments(APPWRITE_DATABASE_ID, '68a73217002ed987b246');
      const overheadDoc = config_docs.documents.find(doc => doc.key === 'overhead_balance_required');

      if (overheadDoc) {
        const overheadValue = overheadDoc.value;
        // console.log('Overhead Balance Required:', overheadValue);

        const withdrawalToCheck = preAmountPaise + commissionRs * 100 + overheadValue * 100;

        // console.log(`Total Withdrawal To Check (including overhead): ${withdrawalToCheck}`);

        if (withdrawalToCheck > amountAvailableForWithdrawal) {
          return res.status(400).json({
            error: 'Requested amount including commission and overhead exceeds available balance',
            preAmountPaise,
            commissionRate,
            commissionPaise: commissionRs * 100,
            overheadPaise: overheadValue * 100,
            amountAvailableForWithdrawal,
            withdrawalToCheck
          });
        }
      } else {
        console.log('No overhead_balance_required key found');
      }

      // Return breakdown
      return res.json({
        commissionRs,
        commissionRate,
        preAmount,
        totalAmount,
      });
    });

    // Users can post a withdrawal request (new version with validations and balance checks)
    router.post('/withdraw_new', async (req, res) => {
      const { userId, qrId, holderName, amount, preAmount, commission, upiId, bankName, accountNumber, ifscCode, mode } = req.body;

      // console.log('Withdraw request received:', req.body);

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
        }

          const usrDet = await getUserMeta(userId);

          // Inside the try block, after fetching usrDet and parentDet

          const preAmountPaise = Math.round(preAmount * 100);

          const userCommissionRate = Number(usrDet.commission || 0);
          const parentCommissionRate = usrDet.parentId ? Number((await getUserMeta(usrDet.parentId)).commission || 0) : 0;
          let totalCommissionRate = userCommissionRate + parentCommissionRate;

          // if (usrDet.parentId) {
          //   const parentDet = await getUserMeta(usrDet.parentId);
          //   commissionRate += Number(parentDet.commission || 0);
          // }

          const recalculatedCommissionRs = calculateCommission(preAmount, totalCommissionRate);

          const recalculatedTotalAmount = Number(preAmount) + recalculatedCommissionRs;

          // Validation check
          if (Number(amount) !== recalculatedTotalAmount) {
            return res.status(400).json({ error: 'Amount mismatch. Please check the amount and try again.' });
          }

          if (Number(commission) !== recalculatedCommissionRs) {
            return res.status(400).json({ error: 'Commission mismatch. Please check the commission and try again.' });
          }

          // return res.status(400).json({
          //     error: "Testing error ",
          //     recalculatedTotalAmount,
          //     recalculatedCommissionRs,
          //     commissionRate,
          //     preAmount,
          // });

        // Load QR and validate available balance
        const qrList = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          [Query.equal('qrId', qrId), Query.limit(1)]
        );
        if (!qrList.documents.length) return res.status(404).json({ error: 'QR not found' });
        const qr = qrList.documents[0]; // has totals in paise

        const total = Number(qr.totalPayInAmount || 0);
        const approved = Number(qr.withdrawalApprovedAmount || 0);
        const requested = Number(qr.withdrawalRequestedAmount || 0);
        const onHold = Number(qr.amountOnHold || 0);
        const commissionOnHold = Number(qr.commissionOnHold || 0);
        const commissionPaid = Number(qr.commissionPaid || 0);
        const available = total - approved - requested - onHold - commissionOnHold - commissionPaid;

        // console.log(`QR Ledger - Total: ${total}, Approved: ${approved}, Requested: ${requested}, Available: ${available}, Requested Withdrawal: ${amountPaise}`);

        // if (amountPaise > available) {
        //   return res.status(400).json({ error: 'Requested amount exceeds available balance' });
        // }

        // console.log(`PreAmountPaise: ${preAmountPaise}, RecalculatedCommissionRs: ${recalculatedCommissionRs}, Available: ${available}`);

        if ((preAmountPaise + (recalculatedCommissionRs * 100) ) > available) {
          return res.status(400).json({ error: 'Requested amount including commission exceeds available balance' });
        }

        const newRequested = requested + preAmountPaise;
        const newCommissionOnHold = commissionOnHold + (recalculatedCommissionRs * 100);
        const newAvailable = total - approved - newRequested - onHold - newCommissionOnHold - commissionPaid; // recompute available

        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          qr.$id,
          {
            withdrawalRequestedAmount: newRequested,
            commissionOnHold: newCommissionOnHold,
            amountAvailableForWithdrawal: newAvailable,
          }
        );

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
            preAmount: preAmount, // Rs
            commission: recalculatedCommissionRs, // Rs
            userCommissionRate: userCommissionRate,
            parentCommissionRate: parentCommissionRate,
            totalCommissionRate: totalCommissionRate,
            mode,
            upiId: upiId || null,
            bankName: bankName || null,
            accountNumber: accountNumber || null,
            ifscCode: ifscCode || null,
            status: 'pending',
            createdAt: istTime,
          }
        ); // withdrawal request created

        // After creating a withdrawal request
        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalWithdrawalPendingAmount', preAmountPaise).catch(console.error);

        return res.json({ success: true, data: response });
      } catch (err) {
        console.error('Error saving withdraw request:', err);
        return res.status(500).json({ error: 'Failed to save withdrawal request' });
      }
    });

    // GET /withdrawals?status=pending&limit=20&cursor=docId
    router.get('/withdrawals_paginated', authenticateAdminOrLabel('all_withdrawals'), async (req, res) => {
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

        const withdrawals = docs.map((doc) => {
          return {
            $id: doc.$id,
            id: doc.id,
            userId: doc.userId,
            qrId: doc.qrId,
            holderName: doc.holderName,
            amount: doc.amount,
            preAmount: doc.preAmount || 0,
            commission: doc.commission || 0,
            mode: doc.mode,
            upiId: doc.upiId,
            bankName: doc.bankName,
            accountNumber: doc.accountNumber,
            ifscCode: doc.ifscCode,
            status: doc.status,
            createdAt: doc.createdAt,
            processed_at: doc.processed_at || null,
            utrNumber: doc.utrNumber || null,
            rejectionReason: doc.rejectionReason || null,
            // Include other metadata if needed
            // add any other fields you need
          };
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
          return {
            $id: doc.$id,
            id: doc.id,
            userId: doc.userId,
            qrId: doc.qrId,
            holderName: doc.holderName,
            amount: doc.amount,
            preAmount: doc.preAmount || 0,
            commission: doc.commission || 0,
            mode: doc.mode,
            upiId: doc.upiId,
            bankName: doc.bankName,
            accountNumber: doc.accountNumber,
            ifscCode: doc.ifscCode,
            status: doc.status,
            createdAt: doc.createdAt,
            processed_at: doc.processed_at || null,
            utrNumber: doc.utrNumber || null,
            rejectionReason: doc.rejectionReason || null,
            // Include other metadata if needed
            // add any other fields you need
          };
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

    // POST /withdrawals/approve_new (with balance and ledger updates)
    router.post('/withdrawals/approve_new', authenticateAdminOrLabel('edit_withdrawals'), async (req, res) => {
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
        const onHold = Number(qr.amountOnHold || 0);
        const commissionOnHold = Number(qr.commissionOnHold || 0);
        const commissionPaid = Number(qr.commissionPaid || 0);

        console.log(`Approving Withdrawal - AmountPaise: ${amountPaise}, QR Requested: ${requested}, CommissionOnHold: ${commissionOnHold}`);

        // Separate commission and withdrawal amounts
        const commissionPaise = Math.round((w.commission || 0) * 100);
        const withdrawalPaise = amountPaise - commissionPaise;

        // Validate that requested and commissionOnHold have enough funds
        if (requested < withdrawalPaise) {
          return res.status(409).json({ error: 'Pending requested withdrawal amount is lower than approval amount' });
        }
        if (commissionOnHold < commissionPaise) {
          return res.status(409).json({ error: 'Commission on hold is lower than approval commission amount' });
        }

        // Compute new ledger values
        const newRequested = requested - withdrawalPaise;
        const newApproved = approved + withdrawalPaise;

        const newCommissionOnHold = commissionOnHold - commissionPaise;
        const newCommissionPaid = commissionPaid + commissionPaise;

        const newAvailable = total - newApproved - newRequested - onHold - newCommissionOnHold - newCommissionPaid;

        // Prevent negative ledger fields
        if (newRequested < 0 || newCommissionOnHold < 0) {
          return res.status(500).json({ error: 'Ledger computation error: negative balance' });
        }

        // Continue with database updates...
        // 4) Update QR ledger first
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          qr.$id,
          {
            withdrawalRequestedAmount: newRequested,
            withdrawalApprovedAmount: newApproved,
            amountAvailableForWithdrawal: newAvailable,
            commissionOnHold: newCommissionOnHold,
            commissionPaid: newCommissionPaid,
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
        ); // update by $id

        // update dashboard counters
        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalAmountPaid', amountPaise).catch(console.error);
        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalWithdrawalPendingAmount', -amountPaise).catch(console.error);

        // After updating Withdrawal request doc and QR ledger:
        const user = await getUserMeta(w.userId);
        const admin = await getadminMeta(); // Implement this based on your user roles

        if (!user) {
          console.warn("User metadata not found for commission processing");
        } else {
          let commissionTxs = [];

          if (user.parentId) {
            const parent = await getUserMeta(user.parentId);
            if (parent) {
              // Subadmin commission
              const subadminCommissionAmount = calculateCommission(
                w.preAmount * 100,
                w.userCommissionRate
              );

              // Admin commission
              const adminCommissionAmount = calculateCommission(
                w.preAmount * 100,
                w.parentCommissionRate
              );

              commissionTxs.push({
                userId: user.parentId,
                sourceWithdrawalId: w.id,
                amount: subadminCommissionAmount,
                commissionRate: w.userCommissionRate,
                earningType: 'subadmin',
                createdAt: new Date().toISOString(),
              });

              commissionTxs.push({
                userId: admin.userId,
                sourceWithdrawalId: w.id,
                amount: adminCommissionAmount,
                commissionRate: w.parentCommissionRate,
                earningType: 'admin',
                createdAt: new Date().toISOString(),
              });

              // Update dashboard counters for merchant and admin profit
              const merchantProfit = subadminCommissionAmount;
              const adminCommission = adminCommissionAmount;
              await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalMerchantProfit', merchantProfit).catch(console.error);
              await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalAdminProfit', adminCommission).catch(console.error);

            }
          } else {
            // User has no parent, so admin earns commission only
            if (admin) {
              const adminCommissionAmount = calculateCommission(
                w.preAmount * 100,
                w.userCommissionRate
              );

              commissionTxs.push({
                userId: admin.userId,
                sourceWithdrawalId: w.id,
                amount: adminCommissionAmount,
                commissionRate: w.userCommissionRate,
                earningType: 'admin',
                createdAt: new Date().toISOString(),
              });

            }
          }

          // Create commission transaction docs
          for (const tx of commissionTxs) {
            await databases.createDocument(
              APPWRITE_DATABASE_ID,
              APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID,
              ID.unique(),
              tx
            );
          }

          await recordCommissionRollups(commissionTxs).catch((err) => {
            console.error('❌ Commission rollup error:', err);
          });

        }

        return res.json({ success: true, message: 'Withdrawal approved' });
      } catch (err) {
        console.error('❌ Approve error:', err);
        return res.status(500).json({ error: 'Failed to approve withdrawal' });
      }
    });

    function istDayString(ts = new Date()) {
      return moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD'); // TZ-safe day key [web:51]
    }

    function istMonthString(ts = new Date()) {
      return moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM'); // TZ-safe month key [web:51]
    }

    // One entrypoint after computing commissionTxs in your approval route
    async function recordCommissionRollups(commissionTxs) {
      await upsertDailyCommissionFromTxs(commissionTxs); // daily JSON map [web:52]
      await upsertMonthlyTotalsFromTxs(commissionTxs); // monthly per-user with composite unique [web:39][web:40]
      await upsertAllTimeTotalsFromTxs(commissionTxs); // all-time per-user unique [web:40]
    }

    // 1) Daily JSON map merge (one doc per date)
    async function upsertDailyCommissionFromTxs(commissionTxs) {
      const day = istDayString();

      const existing = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID,
        [ Query.equal('date', day), Query.limit(1) ]
      ); // list by equality [web:52][web:47]

      let commissionsObj = {};
      let docId = null;

      if (existing.total > 0) {
        const doc = existing.documents[0];
        docId = doc.$id;
        try {
          commissionsObj = JSON.parse(doc.commissionsJson) || {};
        } catch {
          commissionsObj = {};
        }
      }

      for (const { userId, amount } of commissionTxs) {
        const amt = Number(amount || 0);
        commissionsObj[userId] = (commissionsObj[userId] || 0) + amt;
        if (commissionsObj[userId] < 0) {
          throw new Error(`Negative daily total for ${userId}`);
        }
      }

      const payload = { date: day, commissionsJson: JSON.stringify(commissionsObj) };

      if (docId) {
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID,
          docId,
          payload
        ); // update by id [web:45]
      } else {
        try {
          await databases.createDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID,
            ID.unique(),
            payload
          );
        } catch (e) {
          // race fallback: re-read then update
          const again = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID,
            [ Query.equal('date', day), Query.limit(1) ]
          );
          if (again.total > 0) {
            await databases.updateDocument(
              APPWRITE_DATABASE_ID,
              APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID,
              again.documents[0].$id,
              payload
            );
          } else {
            throw e;
          }
        }
      }
    }

    // 2) Monthly per-user totals (one row per userId+month)
    async function upsertMonthlyTotalsFromTxs(commissionTxs) {
      const month = istMonthString();

      // collapse to per-user to minimize writes
      const perUser = {};
      for (const { userId, amount } of commissionTxs) {
        const amt = Number(amount || 0);
        if (!perUser[userId]) perUser[userId] = 0;
        perUser[userId] += amt;
      }

      for (const [userId, delta] of Object.entries(perUser)) {
        if (delta === 0) continue;

        const list = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID,
          [ Query.equal('userId', userId), Query.equal('month', month), Query.limit(1) ]
        ); // composite query [web:50]

        if (list.total > 0) {
          const row = list.documents[0];
          const newTotal = Number(row.totalCommissionPaise || 0) + delta;
          if (newTotal < 0) throw new Error(`Negative monthly total for ${userId}`);
          await databases.updateDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID,
            row.$id,
            { totalCommissionPaise: newTotal }
          );
        } else {
          try {
            await databases.createDocument(
              APPWRITE_DATABASE_ID,
              APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID,
              ID.unique(),
              { userId, month, totalCommissionPaise: delta }
            );
          } catch (e) {
            // retry path on unique collision
            const again = await databases.listDocuments(
              APPWRITE_DATABASE_ID,
              APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID,
              [ Query.equal('userId', userId), Query.equal('month', month), Query.limit(1) ]
            );
            if (again.total > 0) {
              const row = again.documents[0];
              const newTotal = Number(row.totalCommissionPaise || 0) + delta;
              await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID,
                row.$id,
                { totalCommissionPaise: newTotal }
              );
            } else {
              throw e;
            }
          }
        }
      }
    }

    // 3) All-time per-user totals (one row per userId)
    async function upsertAllTimeTotalsFromTxs(commissionTxs) {

      const perUser = {};
      for (const { userId, amount } of commissionTxs) {
        const amt = Number(amount || 0);
        if (!perUser[userId]) perUser[userId] = 0;
        perUser[userId] += amt;
      }

      for (const [userId, delta] of Object.entries(perUser)) {
        if (delta === 0) continue;

        const list = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID,
          [ Query.equal('userId', userId), Query.limit(1) ]
        );

        if (list.total > 0) {
          const row = list.documents[0];
          const newTotal = Number(row.totalCommissionPaise || 0) + delta;
          if (newTotal < 0) throw new Error(`Negative all-time total for ${userId}`);
          await databases.updateDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID,
            row.$id,
            { totalCommissionPaise: newTotal }
          );
        } else {
          try {
            await databases.createDocument(
              APPWRITE_DATABASE_ID,
              APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID,
              ID.unique(),
              { userId, totalCommissionPaise: delta }
            );
          } catch (e) {
            const again = await databases.listDocuments(
              APPWRITE_DATABASE_ID,
              APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID,
              [ Query.equal('userId', userId), Query.limit(1) ]
            );
            if (again.total > 0) {
              const row = again.documents[0];
              const newTotal = Number(row.totalCommissionPaise || 0) + delta;
              await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID,
                row.$id,
                { totalCommissionPaise: newTotal }
              );
            } else {
              throw e;
            }
          }
        }
      }
    }


    // POST /withdrawals/reject_new (new with balance and ledger updates)
    router.post('/withdrawals/reject_new', authenticateAdminOrLabel('edit_withdrawals'), async (req, res) => {
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
        const onHold = Number(qr.amountOnHold || 0);
        const commissionOnHold = Number(qr.commissionOnHold || 0);
        const commissionPaid = Number(qr.commissionPaid || 0);

        // console.log(`Rejecting Withdrawal - AmountPaise: ${amountPaise}, QR Requested: ${requested}, CommissionOnHold: ${commissionOnHold}`);

        // Convert commission from rupees to paise safely
        const commissionPaise = Math.round((w.commission || 0) * 100);

        // Withdrawal amount portion excluding commission
        const withdrawalPaise = amountPaise - commissionPaise;

        // Validation: separate checks for withdrawal and commission amounts
        if (requested < withdrawalPaise) {
          return res.status(409).json({ error: 'Requested amount is lower than rejection withdrawal amount' });
        }
        if (commissionOnHold < commissionPaise) {
          return res.status(409).json({ error: 'Commission on hold is lower than rejection commission amount' });
        }

        // Adjust ledger amounts properly
        const newRequested = requested - withdrawalPaise;
        const newApproved = approved; // unchanged
        const newCommissionOnHold = commissionOnHold - commissionPaise;
        const newCommissionPaid = commissionPaid; // unchanged

        // Recalculate available amount after adjustments
        const newAvailable = total - newApproved - newRequested - onHold - newCommissionOnHold - newCommissionPaid;

        // console.log(`requested: ${requested} - ${withdrawalPaise} = ${newRequested}`);
        // console.log(`Post-Reject Ledger - Total: ${total}, Approved: ${newApproved}, Requested: ${newRequested}, Available: ${newAvailable}, CommissionOnHold: ${newCommissionOnHold}`);
        // console.log(`Post-Reject Commission - CommissionOnHold: ${newCommissionOnHold}, CommissionPaid: ${newCommissionPaid}`);

        // 4) Update QR ledger
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          qr.$id,
          {
            withdrawalRequestedAmount: newRequested,
            amountAvailableForWithdrawal: newAvailable,
            commissionOnHold: newCommissionOnHold,
            commissionPaid: newCommissionPaid,
          }
        ); // by $id

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
        ); // by $id

        const preAmountPaise = toPaise(w.preAmount || 0);

        // After rejecting a withdrawal
        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalWithdrawalPendingAmount', -preAmountPaise).catch(console.error);

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