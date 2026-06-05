// -----------------------------------------------------------------------------------------------------
// routes/user.js
// This file contains the API endpoints for users.

const express = require('express');
const multer = require('multer');
const moment = require('moment-timezone');

const { updateDashboardCounter } = require('./dashboardCounters');
const ConfigManager = require('./configManager');
const userMetaCache = require('./userMetaCache');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// We will now pass the required dependencies and middleware from the main server file
// ─── Constants ───────────────────────────────────────────────────────────────
// const MAX_PENDING_WITHDRAWALS = 2;   // max concurrent pending withdrawal requests per user
const LOCK_TTL_APPROVE        = 30;  // Redis lock TTL (seconds) for approve/reject operations
const LOCK_TTL_WITHDRAW       = 15;  // Redis lock TTL (seconds) for new withdrawal request
// ─────────────────────────────────────────────────────────────────────────────

module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, Withdrawal_request_collectionId, bucketId, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_CONFIG_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient) => {

  // Atomic lock release via Lua script — only deletes if value still matches ours
  const RELEASE_LOCK_SCRIPT = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
  async function releaseLock(key, val) {
      try { await redisClient.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [val] }); } catch (e) { console.error(`releaseLock failed for ${key} — lock will expire after TTL:`, e.message); }
  }

  function generateWithdrawalId() {
    const prefix = 'wdh_';
    const timestamp = Date.now(); // milliseconds since epoch
    const random = Math.floor(100 + Math.random() * 900); // 3-digit random number
    return `${prefix}${timestamp}${random}`;
  }

  // Helper to get user by userId — cached in Redis
  async function getUserMeta(userId) {
    return userMetaCache.getUserMeta(userId);
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

  // Helper to get user by userId
  async function getTodayPayins() {
    const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
            // Fetch the daily aggregate doc for today (only one document)
            const dailySummaryDocs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
            [
                Query.equal('date', todayISO),
                Query.limit(1),
            ]
            );

            let totalsObj = {};
            if (dailySummaryDocs.total > 0) {
              try {
                  totalsObj = JSON.parse(dailySummaryDocs.documents[0].totalsJson || '{}');
              } catch (e) {
                  totalsObj = {};
                  console.error('Error parsing totalsJson for daily summary:', e);
                }
            }
    return totalsObj;
  }

    // Helper to calculate commission in PAISE from paise input.
    // All arithmetic stays in integers to avoid floating-point drift.
    // Example: 1050 paise * 2.5% = Math.ceil(1050 * 250 / 10000) = Math.ceil(26.25) = 27 paise
    function calculateCommissionPaise(preAmountPaise, commissionRatePercent) {
      // Multiply rate by 100 to make it integer (2.5% → 250), divide by 10000 at the end
      const rateTimes100 = Math.round(commissionRatePercent * 100);
      return Math.ceil(preAmountPaise * rateTimes100 / 10000);
    }

    // Legacy wrapper — takes rupees, returns rupees (for preview endpoint backward compat)
    function calculateCommission(preAmount, commissionRatePercent) {
      const paise = calculateCommissionPaise(Math.round(preAmount * 100), commissionRatePercent);
      return paise / 100;
    }

    function toInt(value) {
      return value ? parseInt(value, 10) : 0;
    }

    router.post('/withdraw_commission_preview', authenticateToken , async (req, res) => {
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

      const config_docs = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID);
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

    /**
     * Check if the current IST time falls within any of the given windows.
     *
     * @param {Array<{from: string, to: string}>} windows
     *   Each window uses 12-hour format matching moment's 'hh:mm A', e.g.:
     *   { from: '12:00 PM', to: '01:30 PM' }
     * @returns {boolean}
     *
     * Usage:
     *   isWithdrawTimeAllowed([
     *     { from: '12:00 PM', to: '01:30 PM' },
     *     { from: '03:30 PM', to: '04:30 PM' },
     *     { from: '06:30 PM', to: '07:30 PM' },
     *   ])
     */
    function isWithdrawTimeAllowed() {
        windows = [
              // { from: '04:00 AM', to: '05:30 AM' },
              { from: '12:01 PM', to: '07:00 PM' },
              // { from: '03:30 PM', to: '04:30 PM' },
              // { from: '06:30 PM', to: '07:30 PM' },
            ];
        const now = moment().tz('Asia/Kolkata');
        const nowMinutes = now.hours() * 60 + now.minutes();

        const toMinutes = (timeStr) => {
            const t = moment(timeStr, 'hh:mm A');
            return t.hours() * 60 + t.minutes();
        };

        return windows.some(({ from, to }) => {
            const start = toMinutes(from);
            const end   = toMinutes(to);
            return nowMinutes >= start && nowMinutes <= end;
        });
    }

    // New endpoint to check if withdrawals are currently allowed based on time windows (for non-admins)
    router.get('/withdrawal_time_check', authenticateToken, async (req, res) => {
      try {
        if (req.user.role !== 'admin') {
          await ConfigManager.refresh();

          const isWithdrawalTimeWindowsEnabled = ConfigManager.get(
            'withdrawal_time_windows_enabled'
          );

          if (isWithdrawalTimeWindowsEnabled) {
            const isAllowed = isWithdrawTimeAllowed();

            return res.json({
              isAllowed,
              message: isAllowed
                ? 'Withdrawals are allowed at this time.'
                : 'Withdrawals are only allowed during:\n• 12:00 PM – 01:30 PM\n• 03:30 PM – 04:30 PM\n• 06:30 PM – 07:30 PM',
            });
          } else {
            return res.json({
              isAllowed: true,
              message: 'Withdrawal time windows are disabled. Withdrawals are allowed at any time.',
            });
          }
        } else {
          return res.json({
            isAllowed: true,
            message: 'Admins are not restricted by withdrawal time windows.',
          });
        }
      } catch (err) {
        console.error('withdrawal_time_check error:', err);
        return res.status(500).json({
          isAllowed: false,
          message: 'Internal server error. Please try again later.',
        });
      }
    });

    // Users can post a withdrawal request (new version with validations and balance checks)
    router.post('/withdraw_new', authenticateToken, async (req, res) => {
      const { userId, qrId, companyName, holderName, amount, preAmount, commission, upiId, bankName, accountNumber, ifscCode, mode } = req.body;

      // If the requester is not an admin, check if withdrawal time windows are enabled and enforce them
      if (req.user.role != 'admin'){
         await ConfigManager.refresh(); // Ensure we have the latest config values
         let isWithdrawalTimeWindowsEnabled = ConfigManager.get('withdrawal_time_windows_enabled');
         if(isWithdrawalTimeWindowsEnabled){
          let is =  isWithdrawTimeAllowed();
          if(!is){
            return res.status(400).json({ error: 'Withdrawals are only allowed during:\n• 12:00 PM – 01:30 PM\n• 03:30 PM – 04:30 PM\n• 06:30 PM – 07:30 PM' });
          }
         }
      }

      // console.log('Withdraw request received:', req.body);

      // return res.status(503).json({ error: 'Withdrawals are temporarily disabled for maintenance' });

      // basic validations
      if (!['upi', 'bank'].includes(mode)) return res.status(400).json({ error: 'Invalid mode. Must be upi or bank.' });
      if (!userId || !holderName) return res.status(400).json({ error: 'userId and name are required' });
      if (!qrId) return res.status(400).json({ error: 'qrId is required' });  // ← add
      if (mode === 'upi') {
        if (!upiId) return res.status(400).json({ error: 'UPI ID is required for UPI withdrawal' });
        // UPI ID must contain exactly one @ and have non-empty handle on both sides
        if (!/^[a-zA-Z0-9.\-_+]+@[a-zA-Z0-9]+$/.test(upiId.trim())) {
          return res.status(400).json({ error: 'Invalid UPI ID format (expected handle@provider)' });
        }
      }
      if (mode === 'bank') {
        if (!bankName || !accountNumber || !ifscCode) {
          return res.status(400).json({ error: 'Bank details are incomplete' });
        }
        // IFSC: 4 alpha + 0 + 6 alphanumeric (RBI standard)
        if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode.trim().toUpperCase())) {
          return res.status(400).json({ error: 'Invalid IFSC code format (e.g. SBIN0001234)' });
        }
        // Account number: 8–18 digits only
        if (!/^\d{8,18}$/.test(accountNumber.toString().trim())) {
          return res.status(400).json({ error: 'Invalid account number (must be 8–18 digits)' });
        }
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

      // const istOffset = 5.5 * 60 * 60 * 1000;
      // const istTime = new Date(Date.now() + istOffset).toISOString();

      const istTime = istDateTimeNow();

      // const istTime = moment().tz('Asia/Kolkata').toISOString();

        try {
          // Enforce max 2 pending per user
          const pendingRequests = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            Withdrawal_request_collectionId,
            [Query.equal('userId', userId), Query.equal('status', 'pending')]
        );

          let MAX_PENDING_WITHDRAWALS = ConfigManager.get('max_withdrawal_requests') || MAX_PENDING_WITHDRAWALS;

          if (pendingRequests.total >= MAX_PENDING_WITHDRAWALS) {
            return res.status(400).json({ error: 'You already have the maximum number of pending withdrawal requests (2).' });
          }

          const usrDet = await getUserMeta(userId);

          // Inside the try block, after fetching usrDet and parentDet
          // after — reuses the toPaise helper already defined above
          const preAmountPaise = toPaise(preAmount);
          if (preAmountPaise == null) return res.status(400).json({ error: 'Invalid preAmount' });

          const userCommissionRate = Number(usrDet.commission || 0);
          const parentCommissionRate = usrDet.parentId ? Number((await getUserMeta(usrDet.parentId)).commission || 0) : 0;
          let totalCommissionRate = userCommissionRate + parentCommissionRate;

          // Guard against misconfigured commission rates — prevent absurd deductions
          if (!isFinite(userCommissionRate) || userCommissionRate < 0 || userCommissionRate > 100) {
            return res.status(422).json({ error: 'Your account commission rate is invalid. Please contact support.' });
          }
          if (!isFinite(parentCommissionRate) || parentCommissionRate < 0 || parentCommissionRate > 100) {
            return res.status(422).json({ error: 'Parent account commission rate is invalid. Please contact support.' });
          }
          if (totalCommissionRate > 100) {
            return res.status(422).json({ error: 'Combined commission rate exceeds 100%. Please contact support.' });
          }

          const recalculatedCommissionPaise = calculateCommissionPaise(preAmountPaise, totalCommissionRate);
          const recalculatedCommissionRs = recalculatedCommissionPaise / 100;
          const recalculatedTotalPaise = preAmountPaise + recalculatedCommissionPaise;

          // Validation check — compare in integer paise to avoid floating-point drift
          // (e.g. 100.1 + 0.3 !== 100.4 in IEEE 754, but 10010 + 30 === 10040 always)
          if (Math.round(Number(amount) * 100) !== recalculatedTotalPaise) {
            return res.status(400).json({ error: 'Amount mismatch. Please check the amount and try again.' });
          }

          if (Math.round(Number(commission) * 100) !== recalculatedCommissionPaise) {
            return res.status(400).json({ error: 'Commission mismatch. Please check the commission and try again.' });
          }

        // Acquire per-QR lock before reading balance — prevents two simultaneous withdrawal
        // requests from both passing the balance check on the same stale QR data.
        // Same lock key pattern used in webhooks: lock:qr:{qrId}
        const wdLockKey = `lock:qr:${qrId}`;
        let wdLockAcquired = false;
        try {
            const lockResult = await redisClient.set(wdLockKey, wdh_id, { NX: true, EX: LOCK_TTL_WITHDRAW });
            wdLockAcquired = lockResult === 'OK';
        } catch (e) {
            console.error('Redis lock error in withdraw_new, proceeding without lock:', e);
            wdLockAcquired = false; // fail safe — reject rather than proceed unprotected
        }
        if (!wdLockAcquired) {
            return res.status(409).json({ error: 'Another withdrawal for this QR is being processed. Please try again.' });
        }

        let qr;
        let response;
        try {
        // Load QR and validate available balance under lock — fresh read, no stale data
        const qrList = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          Qr_collectionId,
          [Query.equal('qrId', qrId), Query.limit(1)]
        );
        if (!qrList.documents.length) return res.status(404).json({ error: 'QR not found' });
        qr = qrList.documents[0]; // totals in paise

        // All amounts below are in PAISE (1 rupee = 100 paise)
        const total = Number(qr.totalPayInAmount || 0);           // paise
        const approved = Number(qr.withdrawalApprovedAmount || 0); // paise
        const requested = Number(qr.withdrawalRequestedAmount || 0); // paise
        const onHold = Number(qr.amountOnHold || 0);             // paise
        const commissionOnHold = Number(qr.commissionOnHold || 0); // paise
        const commissionPaid = Number(qr.commissionPaid || 0);    // paise
        // available = what the user can actually withdraw right now (paise)
        const available = total - approved - requested - onHold - commissionOnHold - commissionPaid;

        const todayPayinsAll = await getTodayPayins();

        const todayPayinsForThisQr = Number(todayPayinsAll[qr.qrId] || 0);

        // canWithdrawToday = whether the user can withdraw today based on today's pay-ins for this QR (paise)
        const todayWithdrawAmount = available - todayPayinsForThisQr;

        // preAmountPaise = withdrawal amount in paise (e.g. ₹10 = 1000 paise)
        // Commission already computed in paise — no conversion needed
        const commissionPaiseRequired = recalculatedCommissionPaise;
        if ((preAmountPaise + commissionPaiseRequired) > todayWithdrawAmount) {
          return res.status(400).json({ error: 'Requested amount including commission exceeds available balance' });
        }

        // if ((preAmountPaise + commissionPaiseRequired) > available) {
        //   return res.status(400).json({ error: 'Requested amount including commission exceeds available balance' });
        // }

        const newRequested = requested + preAmountPaise;                        // paise
        const newCommissionOnHold = commissionOnHold + commissionPaiseRequired; // paise
        // recompute available after deducting this request
        const newAvailable = total - approved - newRequested - onHold - newCommissionOnHold - commissionPaid; // paise

        // Create withdrawal document FIRST (under lock), then update QR.
        // Order matters: if QR update fails we can delete the doc (rollback).
        // If doc creation fails the QR is untouched — no inconsistency.
        response = await databases.createDocument(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          ID.unique(),
          {
            id: wdh_id,
            userId,
            qrId: qrId,
            companyName: companyName || null,
            holderName,
            amount: amount, // Rs
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
        );

        // Now update QR balance; if this fails, roll back by deleting the withdrawal doc
        try {
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
        } catch (qrUpdateErr) {
          // Rollback: delete the withdrawal doc so balance and records stay in sync
          await databases.deleteDocument(APPWRITE_DATABASE_ID, Withdrawal_request_collectionId, response.$id)
            .catch(e => console.error(`CRITICAL: QR update failed and rollback also failed. Orphaned withdrawal id=${response.$id} for qrId=${qrId}`, e));
          throw qrUpdateErr;
        }
        // Update dashboard counter inside lock scope
        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalWithdrawalPendingAmount', preAmountPaise).catch(console.error);

        } finally {
            // Always release the lock — whether the balance check passed, failed, or threw
            await releaseLock(wdLockKey, wdh_id);
        }

        return res.json({ success: true, data: response });
      } catch (err) {
        console.error('Error saving withdraw request:', err);
        return res.status(500).json({ error: 'Failed to save withdrawal request' });
      }
    });

        // Helper to get QR IDs for a user
    async function getQrIdsForUser(userId) {
        try {
            const response = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            Qr_collectionId, // Ensure this matches your actual QR codes collection ID
            [Query.equal('assignedUserId', userId)]
            );
            return response.documents.map(doc => doc.qrId);
        } catch (error) {
            console.error('Error fetching QR codes for user:', error);
            return [];
        }
    }

    // Helper to fetch QR IDs a subadmin can access
    async function getQrIdsForSubadmin(subadminId) {
        const qrIds = new Set();

        try {
            // QRs created by the subadmin
            const createdQrs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            Qr_collectionId,
            [Query.equal("createdByUserId", subadminId)]
            );

            createdQrs.documents.forEach(q => qrIds.add(q.qrId));

            // QRs assigned directly to the subadmin
            const subadminAssignedQrs = await getQrIdsForUser(subadminId);
            subadminAssignedQrs.forEach(id => qrIds.add(id));

            // Users under the subadmin
            const managedUsers = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [Query.equal("parentId", subadminId)]
            );
            const managedUserIds = managedUsers.documents.map(u => u.userId);

            // QRs assigned to those managed users
            if (managedUserIds.length > 0) {
            const qrDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                [Query.equal("assignedUserId", managedUserIds)]
            );
            qrDocs.documents.forEach(q => qrIds.add(q.qrId));
            }

            return Array.from(qrIds);
        } catch (err) {
            console.error(`❌ Error in getQrIdsForSubadmin(${subadminId}):`, err);
            return [];
        }
    }

    // GET /withdrawals?status=pending&limit=20&cursor=docId
    router.get('/withdrawals_paginated', authenticateAdminOrSubAdminOrEmployee, async (req, res) => {
      try {
        const {userId, qrId, status, from, to, limit: limitStr, cursor } = req.query;

        // 1) Parse limit with sane default + cap
        const DEFAULT_LIMIT = 25;
        const MAX_LIMIT = 100;
        const limit = Math.min(
          Math.max(parseInt(limitStr ?? DEFAULT_LIMIT, 10) || DEFAULT_LIMIT, 1),
          MAX_LIMIT
        );

        // 2) Build Appwrite queries
        const queries = [];

            if (req.user.role === 'employee' && !userId && !qrId) {
                const merchantsRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    [
                        Query.equal('assigned_to', req.user.$id),
                        Query.equal('role', 'subadmin'),
                        Query.limit(100)  // Merchants rarely >100/emp
                    ]
                );

                const merchantIds = merchantsRes.documents.map(d => d.userId);

                // console.log(`Employee ${req.user.$id} has ${merchantIds.length} assigned merchants:`, merchantIds);

                let queriesUser = [];

                let orQueries = [];

                if(merchantIds.length === 0){
                    return res.status(500).json({ message: "Failed to fetch Withdrawals No Merchants assigned." });
                }else if(merchantIds.length === 1){
                    queriesUser.push(Query.equal('parentId', merchantIds[0]));
                }else{
                    merchantIds.forEach(id => orQueries.push(Query.equal('parentId', id)));
                    queriesUser.push(Query.or(orQueries));
                }

                // let orQueries = [];
                // merchantIds.forEach(id => orQueries.push(Query.equal('parentId', id)));
                // queriesUser.push(Query.or(orQueries));

                const usersRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    queriesUser // must be an array
                );

                const userIds = usersRes.documents.map(d => d.userId);

                // console.log(`Employee ${req.user.$id} has ${userIds.length} assigned users:`, userIds);

                let orQueries2 = [];

                merchantIds.forEach(id => orQueries2.push(Query.equal('userId', id)));
                userIds.forEach(id => orQueries2.push(Query.equal('userId', id)));
                queries.push(Query.or(orQueries2));

            }

            if (req.user.role === 'subadmin' && !userId && !qrId) {
                const usersUnderSubadmin = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    [
                        Query.equal('parentId', req.user.userId),
                        Query.equal('role', 'user'),
                        Query.limit(100)  // Merchants rarely >100/emp
                    ]
                );

                const usersUnderSubadminIds = usersUnderSubadmin.documents.map(d => d.userId);

                // console.log(`Employee ${req.user.$id} has ${merchantIds.length} assigned merchants:`, merchantIds);

                let queriesUser = [];

                if(usersUnderSubadminIds.length === 0){
                    return res.status(500).json({ message: "Failed to fetch Withdrawals No Users assigned." });
                }else if(usersUnderSubadminIds.length === 1){
                    queries.push(Query.equal('userId', usersUnderSubadminIds[0]));
                }else{
                    usersUnderSubadminIds.forEach(id => queriesUser.push(Query.equal('userId', id)));
                    queries.push(Query.or(queriesUser));
                }

            }

        if (userId && qrId) {
                const userQrIds = await getQrIdsForUser(userId);
                if (userQrIds.includes(qrId)) { 
                    queries.push(Query.equal('qrId', qrId));
                } else {
                    return res.status(200).json({ transactions: [] });
                }
            } else if (qrId) {
                queries.push(Query.equal('qrId', qrId));
            } else if (userId) {
                const userQrIds = await getQrIdsForUser(userId);
                if (userQrIds.length > 0) {
                    queries.push(Query.equal('qrId', userQrIds));
                } else {
                    return res.status(200).json({ transactions: [] });
                }
            }

        if (status) {
          queries.push(Query.equal('status', status));
        }

        // Date filters (IST-aware)
        function toISTRange(dateStr) {
            const start = moment.tz(dateStr, 'Asia/Kolkata').startOf('day').utc().toDate();
            const end = moment.tz(dateStr, 'Asia/Kolkata').endOf('day').utc().toDate();
            return { start, end };
        }
        if (from && to) {
            if (from === to) {
                const { start, end } = toISTRange(from);
                queries.push(Query.between('$createdAt', start.toISOString(), end.toISOString()));
            } else {
                const { start } = toISTRange(from);
                const { end } = toISTRange(to);
                queries.push(Query.between('$createdAt', start.toISOString(), end.toISOString()));
            }
        } else if (from && !to) {
            const { start, end } = toISTRange(from);
            queries.push(Query.between('$createdAt', start.toISOString(), end.toISOString()));
        } else if (!from && to) {
            const { end } = toISTRange(to);
            queries.push(Query.lessThanEqual('$createdAt', end.toISOString()));
        }

        // Stable order by creation time (newest first)
        queries.push(Query.orderDesc('$createdAt'));

        // Apply cursor if provided (keyset pagination using $id)
        if (cursor) {
          if (!/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
            return res.status(400).json({ error: 'Invalid cursor format' });
          }
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
            companyName: doc.companyName || null,
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
            processedAt: doc.processedAt || null,
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
        const msg = (error?.message || '').toLowerCase();
        if (error?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'))) {
          return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
        }
        console.error('❌ Error fetching withdrawals:', error);
        return res.status(500).json({ error: 'Failed to fetch withdrawal requests' });
      }
    });

    // GET /user_withdrawals?userId=...&status=pending&limit=20&cursor=<docId>
    router.get('/user_withdrawals_paginated', async (req, res) => {
      try {
        const { status, userId, from, to, limit: limitStr, cursor } = req.query;

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

        // Date filters (IST-aware)
        function toISTRange(dateStr) {
            const start = moment.tz(dateStr, 'Asia/Kolkata').startOf('day').utc().toDate();
            const end = moment.tz(dateStr, 'Asia/Kolkata').endOf('day').utc().toDate();
            return { start, end };
        }
        if (from && to) {
            if (from === to) {
                const { start, end } = toISTRange(from);
                queries.push(Query.between('$createdAt', start.toISOString(), end.toISOString()));
            } else {
                const { start } = toISTRange(from);
                const { end } = toISTRange(to);
                queries.push(Query.between('$createdAt', start.toISOString(), end.toISOString()));
            }
        } else if (from && !to) {
            const { start, end } = toISTRange(from);
            queries.push(Query.between('$createdAt', start.toISOString(), end.toISOString()));
        } else if (!from && to) {
            const { end } = toISTRange(to);
            queries.push(Query.lessThanEqual('$createdAt', end.toISOString()));
        }

        // Order by $createdAt descending
        queries.push(Query.orderDesc('$createdAt'));

        // Cursor-based pagination
        if (cursor) {
          if (!/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
            return res.status(400).json({ error: 'Invalid cursor format' });
          }
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
            companyName: doc.companyName || null,
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
            processedAt: doc.processedAt || null,
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
        const msg = (error?.message || '').toLowerCase();
        if (error?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'))) {
          return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
        }
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

    // router.get('/user_withdrawals', async (req, res) => {
    //   const status = req.query.status;   // optional: 'pending', 'approved', 'rejected'
    //   const userId = req.query.userId;   // optional: to fetch specific user's withdrawals
    //   const queries = [];

    //   if (status) {
    //     queries.push(Query.equal('status', status));
    //   }

    //   if (userId) {
    //     queries.push(Query.equal('userId', userId));
    //   }

    //   queries.push(Query.orderDesc('$createdAt'));
    //   queries.push(Query.limit(100)); // adjust limit if needed

    //   try {
    //     const result = await databases.listDocuments(
    //       APPWRITE_DATABASE_ID,
    //       Withdrawal_request_collectionId,
    //       queries
    //     );

    //     const withdrawals = result.documents.map((doc) => {
    //       const {
    //         $id,
    //         $collectionId,
    //         $databaseId,
    //         $createdAt,
    //         $updatedAt,
    //         $permissions,
    //         ...customFields
    //       } = doc;

    //       return customFields;
    //     });

    //     res.json({
    //       count: result.total,
    //       withdrawals: withdrawals,
    //     });
    //   } catch (error) {
    //     console.error('❌ Error fetching withdrawals:', error.message);
    //     res.status(500).json({ error: 'Failed to fetch withdrawal requests' });
    //   }
    // });

    // POST /withdrawals/approve_new (with balance and ledger updates)
    router.post('/withdrawals/approve_new', authenticateAdminOrLabel('edit_withdrawals'), async (req, res) => {
      const { id, utrNumber } = req.body;

      if (!id || !utrNumber || utrNumber.trim().length < 5) {
        return res.status(400).json({ error: 'Invalid ID or UTR number too short' });
      }

      // const istOffsetMs = 5.5 * 60 * 60 * 1000;
      // const approvedAtIST = new Date(Date.now() + istOffsetMs).toISOString();
      // const approvedAtIST = moment().tz('Asia/Kolkata').toISOString();

      // const istOffset = 5.5 * 60 * 60 * 1000;
      // const approvedAtIST = new Date(Date.now() + istOffset).toISOString();

      const approvedAtIST = istDateTimeNow();


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

        // Acquire per-QR lock — prevents two concurrent approvals both passing the balance check
        const approveLockKey = `lock:qr:${qrId}`;
        const approveLockVal = w.id;
        let approveLockAcquired = false;
        try {
            const r = await redisClient.set(approveLockKey, approveLockVal, { NX: true, EX: LOCK_TTL_APPROVE });
            approveLockAcquired = r === 'OK';
        } catch (e) {
            console.error('Redis lock error in withdrawal approve:', e);
            approveLockAcquired = false; // fail safe
        }
        if (!approveLockAcquired) {
            return res.status(409).json({ error: 'QR is currently being processed. Please try again in a moment.' });
        }
        try {

        // 2) Load QR document — fresh read under lock, no stale data
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

        // console.log(`Approving Withdrawal - AmountPaise: ${amountPaise}, QR Requested: ${requested}, CommissionOnHold: ${commissionOnHold}`);

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

        // Guard: no field may go negative after approval
        // newRequested < 0 means we approved more than was pending (data inconsistency)
        // newCommissionOnHold < 0 means commission on hold was less than expected
        // newAvailable < 0 means the QR owes more than it ever received (e.g. a transaction was deleted after the request was raised)
        if (newRequested < 0 || newCommissionOnHold < 0 || newAvailable < 0) {
          return res.status(409).json({ error: 'Ledger computation error: approval would result in a negative balance. Check if transactions were modified after this withdrawal was requested.' });
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
            processedAt: approvedAtIST,
            rejectionReason: null,
          }
        ); // update by $id

        const preAmountPaise = toPaise(w.preAmount || 0);
        // update dashboard counters
        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalAmountPaid', preAmountPaise).catch(console.error);
        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalWithdrawalPendingAmount', -preAmountPaise).catch(console.error);

        // After updating Withdrawal request doc and QR ledger:
        const user = await getUserMeta(w.userId);
        const admin = await getadminMeta();

        if (!admin) {
          console.warn('Admin metadata not found — admin commission will be skipped');
        }

        if (!user) {
          console.warn("User metadata not found for commission processing");
        } else {
          let commissionTxs = [];

          if (user.parentId) {
            const parent = await getUserMeta(user.parentId);
            if (parent) {
              // Subadmin commission
              const subadminCommissionAmount = calculateCommissionPaise(
                Math.round(w.preAmount * 100),
                w.userCommissionRate
              );

              if (subadminCommissionAmount > 0) {
                commissionTxs.push({
                  userId: user.parentId,
                  sourceWithdrawalId: w.id,
                  amount: subadminCommissionAmount,
                  commissionRate: w.userCommissionRate,
                  earningType: 'subadmin',
                  createdAt: new Date().toISOString(),
                });

                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalMerchantProfit', subadminCommissionAmount).catch(console.error);
              }

              if (admin) {
                // Admin commission
                const adminCommissionAmount = calculateCommissionPaise(
                  Math.round(w.preAmount * 100),
                  w.parentCommissionRate
                );

                if (adminCommissionAmount > 0) {
                  commissionTxs.push({
                    userId: admin.userId,
                    sourceWithdrawalId: w.id,
                    amount: adminCommissionAmount,
                    commissionRate: w.parentCommissionRate,
                    earningType: 'admin',
                    createdAt: new Date().toISOString(),
                  });

                  await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalAdminProfit', adminCommissionAmount).catch(console.error);
                }
              }

            }
          } else {
            // User has no parent, so admin earns commission only
            if (admin) {
              const adminCommissionAmount = calculateCommissionPaise(
                Math.round(w.preAmount * 100),
                w.userCommissionRate
              );

              if (adminCommissionAmount > 0) {
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
          }
          // Create commission transaction docs (source of truth — must never be skipped)
          for (const tx of commissionTxs) {
            await databases.createDocument(
              APPWRITE_DATABASE_ID,
              APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID,
              ID.unique(),
              tx
            );
          }

          // Rollup summaries are derived from tx docs and can be rebuilt from them.
          // If rollup fails: flag the withdrawal so ops can query and reprocess.
          // Do NOT return 500 — the payment and raw audit trail are already committed.
          try {
            await recordCommissionRollups(commissionTxs);
          } catch (rollupErr) {
            console.error(`CRITICAL: Commission rollup failed for withdrawal ${w.id}. Raw tx docs saved. Needs reconciliation.`, rollupErr);
            await databases.updateDocument(
              APPWRITE_DATABASE_ID,
              Withdrawal_request_collectionId,
              w.$id,
              { commissionRollupFailed: true }
            ).catch(e => console.error(`CRITICAL: Could not mark commissionRollupFailed on withdrawal ${w.id}`, e));
          }

        }

        return res.json({ success: true, message: 'Withdrawal approved' });
        } finally {
            await releaseLock(approveLockKey, approveLockVal);
        }
      } catch (err) {
        console.error('❌ Approve error:', err);
        return res.status(500).json({ error: 'Failed to approve withdrawal' });
      }
    });

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

        // Acquire per-QR lock — prevents two concurrent rejections both passing the balance check
        const rejectLockKey = `lock:qr:${qrId}`;
        const rejectLockVal = w.id;
        let rejectLockAcquired = false;
        try {
            const r = await redisClient.set(rejectLockKey, rejectLockVal, { NX: true, EX: LOCK_TTL_APPROVE });
            rejectLockAcquired = r === 'OK';
        } catch (e) {
            console.error('Redis lock error in withdrawal reject:', e);
            rejectLockAcquired = false; // fail safe
        }
        if (!rejectLockAcquired) {
            return res.status(409).json({ error: 'QR is currently being processed. Please try again in a moment.' });
        }
        try {

        // 2) Load QR document — fresh read under lock
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

        // Recalculate available amount after adjustments (all in paise)
        const newAvailable = total - newApproved - newRequested - onHold - newCommissionOnHold - newCommissionPaid;

        // Guard: rejection should always free up balance, never make it worse
        // newRequested < 0 means we're returning more than was pending (data inconsistency)
        // newCommissionOnHold < 0 means commission on hold is less than expected
        if (newRequested < 0 || newCommissionOnHold < 0) {
          return res.status(409).json({ error: 'Ledger computation error: rejection would result in a negative balance field.' });
        }

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

      // const istOffset = 5.5 * 60 * 60 * 1000;
      // const rejectedAtIST = new Date(Date.now() + istOffset).toISOString();

      const rejectedAtIST = istDateTimeNow();

        // 5) Update withdrawal document
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          Withdrawal_request_collectionId,
          w.$id,
          {
            status: 'rejected',
            rejectionReason: reason.trim(),
            utrNumber: null,
            processedAt: rejectedAtIST,
          }
        ); // by $id

        const preAmountPaise = toPaise(w.preAmount || 0);

        // After rejecting a withdrawal
        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalWithdrawalPendingAmount', -preAmountPaise).catch(console.error);

        return res.json({ success: true, message: 'Withdrawal rejected' });
        } finally {
            await releaseLock(rejectLockKey, rejectLockVal);
        }
      } catch (err) {
        console.error('❌ Reject error:', err);
        return res.status(500).json({ error: 'Failed to reject withdrawal' });
      }
    });

    function istDayString(ts = new Date()) {
      return moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD'); // TZ-safe day key [web:51]
    }

    function istMonthString(ts = new Date()) {
      return moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM'); // TZ-safe month key [web:51]
    }

    // function istDateTimeNow(){
    //   return moment().tz('Asia/Kolkata').format('YYYY-MM-DDTHH:mm:ss.SSS[Z]');
    // }

    function istDateTimeNow(){
      return moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSS[Z]');
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

      // Per-day lock: serializes concurrent approvals updating the same day's JSON doc
      const releaseLua = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
      const dLockKey = `lock:commission:daily:${day}`;
      const dLockVal = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      let dLockAcquired = false;
      for (let i = 0; i < 10; i++) {
        const r = await redisClient.set(dLockKey, dLockVal, { NX: true, EX: 10 }).catch(() => null);
        if (r === 'OK') { dLockAcquired = true; break; }
        await new Promise(res => setTimeout(res, 50 + i * 40));
      }
      if (!dLockAcquired) throw new Error(`Could not acquire daily commission lock for ${day}`);

      try {
        const existing = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID,
          [ Query.equal('date', day), Query.limit(1) ]
        );

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

        let totalDelta = 0;
        for (const { userId, amount } of commissionTxs) {
          const amt = Number(amount || 0);
          totalDelta += amt;
          commissionsObj[userId] = (commissionsObj[userId] || 0) + amt;
          if (commissionsObj[userId] < 0) {
            throw new Error(`Negative daily total for ${userId}`);
          }
        }

        if (totalDelta === 0) return;

        const payload = { date: day, commissionsJson: JSON.stringify(commissionsObj) };

        if (docId) {
          await databases.updateDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID,
            docId,
            payload
          );
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
      } finally {
        await redisClient.eval(releaseLua, { keys: [dLockKey], arguments: [dLockVal] }).catch(() => {});
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

      const releaseLua = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;

      for (const [userId, delta] of Object.entries(perUser)) {
        if (delta === 0) continue;

        // Per-user-month lock: serializes concurrent approvals updating the same user's monthly total.
        const mLockKey = `lock:commission:monthly:${userId}:${month}`;
        const mLockVal = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
        let mLockAcquired = false;
        for (let i = 0; i < 10; i++) {
          const r = await redisClient.set(mLockKey, mLockVal, { NX: true, EX: 10 }).catch(() => null);
          if (r === 'OK') { mLockAcquired = true; break; }
          await new Promise(res => setTimeout(res, 50 + i * 40));
        }
        if (!mLockAcquired) throw new Error(`Could not acquire monthly commission lock for ${userId}`);

        try {
          const list = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID,
            [ Query.equal('userId', userId), Query.equal('month', month), Query.limit(1) ]
          );

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
        } finally {
          await redisClient.eval(releaseLua, { keys: [mLockKey], arguments: [mLockVal] }).catch(() => {});
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

      const releaseLua = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;

      for (const [userId, delta] of Object.entries(perUser)) {
        if (delta === 0) continue;

        // Per-user lock: serializes concurrent approvals updating the same user's all-time total.
        const atLockKey = `lock:commission:alltime:${userId}`;
        const atLockVal = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
        let atLockAcquired = false;
        for (let i = 0; i < 10; i++) {
          const r = await redisClient.set(atLockKey, atLockVal, { NX: true, EX: 10 }).catch(() => null);
          if (r === 'OK') { atLockAcquired = true; break; }
          await new Promise(res => setTimeout(res, 50 + i * 40));
        }
        if (!atLockAcquired) throw new Error(`Could not acquire all-time commission lock for ${userId}`);

        try {
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
        } finally {
          await redisClient.eval(releaseLua, { keys: [atLockKey], arguments: [atLockVal] }).catch(() => {});
        }
      }
    }

    // GET all config
    router.get("/config", async (req, res) => {

      try {
            await ConfigManager.refresh(); // Ensure we have the latest config
            const config = await ConfigManager.getConfig(databases);
            res.json({ success: true, config });
        } catch (err) {
          console.error("❌ Error fetching config:", err);
            res.status(500).json({ success: false, error: "Failed to fetch config" });
        }

    });

    return router;
    
};