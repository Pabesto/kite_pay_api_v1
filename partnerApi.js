// -----------------------------------------------------------------------------------------------------
// partnerApi.js
// Public, API-key-authenticated endpoints that let an external partner system fetch the
// transactions that fall under them (i.e. under a subadmin userId). Reads are served by a
// single indexed query on the denormalized `ownerSubadminId` field that is stamped onto
// every transaction at write time (see qrOwnerCache.js + the txn-insert sites), so we never
// re-fetch a partner's QR codes per request.
//
// Auth: header  X-API-Key: <partnerId>.<secret>
//   partnerId is the public id (e.g. pk_AB12CD34); secret is compared against a bcrypt hash.
//
// Mounted at /api/partner in server.js.

const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const moment = require('moment-timezone');
const partnerWebhooks = require('./partnerWebhooks');

// Per-partner-key rate limit for the public data endpoints. Keyed by the partner's public
// id (parsed from the API key) so one partner can't throttle another or hammer the DB; falls
// back to IP for requests with no/malformed key (brute-force guard on auth). Default 120/min.
const PARTNER_RATE_LIMIT_PER_MIN = Number(process.env.PARTNER_RATE_LIMIT_PER_MIN) || 120;
const partnerLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: PARTNER_RATE_LIMIT_PER_MIN,
    standardHeaders: true,   // adds RateLimit-* and Retry-After headers
    legacyHeaders: false,
    validate: false,         // custom keyGenerator; skip the trust-proxy validation warnings
    keyGenerator: (req) => {
        const raw = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (raw && raw.includes('.')) return 'partner:' + raw.slice(0, raw.indexOf('.'));
        return 'ip:' + (req.ip || 'unknown');
    },
    handler: (req, res) => res.status(429).json({
        error: 'Rate limit exceeded. Slow down and retry shortly.',
        retryAfterSeconds: Math.ceil(60),
    }),
});

module.exports = (
    databases, ID, Query,
    APPWRITE_DATABASE_ID,
    APPWRITE_API_PARTNERS_COLLECTION_ID,
    APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
    APPWRITE_USERS_META_COLLECTION_ID,
    APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID,
    authenticateAdmin
) => {
    const router = express.Router();

    function isCursorError(err) {
        const msg = (err?.message || '').toLowerCase();
        return err?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'));
    }

    // Confirm a userId exists in users_meta and is a subadmin (partners scope to a subadmin
    // subtree; linking to anyone else would silently return zero transactions).
    async function findSubadmin(userId) {
        // users_meta docId is usually the userId; fall back to a query for older rows.
        let doc = null;
        try {
            doc = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, userId);
        } catch (e) {
            if (e?.code === 404) {
                const list = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
                    [Query.equal('userId', userId), Query.limit(1)]
                );
                doc = list.documents[0] || null;
            } else throw e;
        }
        return doc && doc.role === 'subadmin' ? doc : null;
    }

    // ── Partner API-key auth ─────────────────────────────────────────────────
    async function authenticatePartner(req, res, next) {
        try {
            const raw = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (!raw || !raw.includes('.')) {
                return res.status(401).json({ error: 'Missing or malformed API key' });
            }
            const dot = raw.indexOf('.');
            const partnerId = raw.slice(0, dot);
            const secret = raw.slice(dot + 1);
            if (!partnerId || !secret) {
                return res.status(401).json({ error: 'Missing or malformed API key' });
            }

            const partnerDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_API_PARTNERS_COLLECTION_ID,
                [Query.equal('partnerId', partnerId), Query.limit(1)]
            );
            const partner = partnerDocs.documents[0];
            if (!partner) return res.status(401).json({ error: 'Invalid API key' });

            const ok = await bcrypt.compare(secret, partner.apiKeyHash);
            if (!ok) return res.status(401).json({ error: 'Invalid API key' });
            if (!partner.status) return res.status(403).json({ error: 'Partner account suspended' });
            if (!partner.userId) return res.status(403).json({ error: 'Partner is not linked to a user' });

            req.partner = { partnerId: partner.partnerId, userId: partner.userId, name: partner.name };
            next();
        } catch (e) {
            console.error('Partner auth error:', e);
            res.status(500).json({ error: 'Authentication failed' });
        }
    }

    // ── GET /api/partner/transactions ────────────────────────────────────────
    // Cursor-paginated, filterable list of the partner's transactions.
    // Query params: limit, cursor, from, to, status, qrId, searchField, searchValue, isSortByUpdatedAt
    router.get('/transactions', partnerLimiter, authenticatePartner, async (req, res) => {
        const { qrId, limit = 25, cursor, from, to, status, searchField, searchValue, isSortByUpdatedAt } = req.query;
        const limitNum = Math.min(parseInt(limit) || 25, 100);
        const sortByUpdatedAt = isSortByUpdatedAt === true || isSortByUpdatedAt === 'true';

        // Scope: only transactions owned by this partner's subadmin. This single indexed
        // filter replaces per-request QR lookups and scales to any number of QR codes.
        const filters = [Query.equal('ownerSubadminId', req.partner.userId)];

        try {
            // Optional narrow to a single QR (still scoped, so no cross-partner leakage).
            if (qrId) filters.push(Query.equal('qrCodeId', qrId));

            // Date filters — IST day boundaries, timezone-safe (matches admin /transactions).
            function toISTRange(dateStr) {
                const start = moment.tz(dateStr, 'Asia/Kolkata').startOf('day').utc().toDate();
                const end = moment.tz(dateStr, 'Asia/Kolkata').endOf('day').utc().toDate();
                return { start, end };
            }
            if (from && to) {
                if (from === to) {
                    const { start, end } = toISTRange(from);
                    filters.push(Query.between('created_at', start.toISOString(), end.toISOString()));
                } else {
                    const { start } = toISTRange(from);
                    const { end } = toISTRange(to);
                    filters.push(Query.between('created_at', start.toISOString(), end.toISOString()));
                }
            } else if (from && !to) {
                const { start, end } = toISTRange(from);
                filters.push(Query.between('created_at', start.toISOString(), end.toISOString()));
            } else if (!from && to) {
                const { end } = toISTRange(to);
                filters.push(Query.lessThanEqual('created_at', end.toISOString()));
            }

            // Single-field search
            if (searchField && searchValue) {
                const fulltextFields = ['vpa', 'paymentId', 'qrCodeId'];
                if (fulltextFields.includes(searchField)) {
                    filters.push(Query.search(searchField, searchValue));
                } else if (searchField === 'amount') {
                    const amountValue = parseInt(searchValue, 10);
                    if (isNaN(amountValue)) return res.status(400).json({ error: 'Amount must be an integer value' });
                    filters.push(Query.equal('amount', amountValue * 100));
                } else if (searchField === 'rrnNumber') {
                    filters.push(Query.equal('rrnNumber', searchValue));
                } else {
                    return res.status(400).json({ error: 'Invalid searchField parameter' });
                }
            }

            // Status filter
            if (status) {
                const allowedStatuses = new Set(['normal', 'cyber', 'refund', 'chargeback', 'failed', 'suspicious']);
                if (!allowedStatuses.has(status.toLowerCase())) {
                    return res.status(400).json({ error: 'Invalid status filter' });
                }
                if (status.toLowerCase() === 'normal') {
                    filters.push(Query.or([
                        Query.equal('status', 'normal'),
                        Query.equal('status', ''),
                        Query.isNull('status'),
                    ]));
                } else {
                    filters.push(Query.equal('status', status.toLowerCase()));
                }
            }

            if (cursor && !/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
                return res.status(400).json({ error: 'Invalid cursor format' });
            }

            // Exclude soft-deleted
            filters.push(Query.or([Query.equal('deleted', false), Query.isNull('deleted')]));

            const sortField = sortByUpdatedAt ? '$updatedAt' : 'created_at';
            const queries = [...filters, Query.orderDesc(sortField), Query.limit(limitNum)];
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const result = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, queries);

            const pickTxn = (d) => ({
                id: d.$id,
                qrCodeId: d.qrCodeId,
                paymentId: d.paymentId,
                rrnNumber: d.rrnNumber,
                amount: d.amount,
                vpa: d.vpa,
                created_at: d.created_at,
            });

            const docs = result.documents.map(pickTxn);
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].id : null;

            return res.status(200).json({ transactions: docs, nextCursor, limit: limitNum });
        } catch (error) {
            if (isCursorError(error)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
            console.error('Partner transactions error:', error);
            return res.status(500).json({ error: 'Failed to fetch transactions' });
        }
    });

    // Lightweight identity/health check for the calling partner.
    router.get('/me', partnerLimiter, authenticatePartner, (req, res) => {
        res.json({ success: true, partner: req.partner });
    });

    // ── Admin management of partner keys ─────────────────────────────────────
    async function generatePartnerCredentials() {
        const partnerId = 'pk_' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const secret = crypto.randomBytes(32).toString('hex');
        const apiKeyHash = await bcrypt.hash(secret, 12);
        // The full key the partner uses in the X-API-Key header:
        const apiKey = `${partnerId}.${secret}`;
        return { partnerId, secret, apiKeyHash, apiKey };
    }

    // Create a partner linked to a subadmin userId. Returns the API key + webhookSecret ONCE.
    // Optional: webhookUrl (https), webhookEnabled.
    router.post('/admin/partners', authenticateAdmin, async (req, res) => {
        try {
            const { name, userId, webhookUrl, webhookEnabled } = req.body || {};
            if (!name || !userId) return res.status(400).json({ error: 'name and userId are required' });

            const subadmin = await findSubadmin(userId);
            if (!subadmin) return res.status(400).json({ error: 'userId must be an existing subadmin' });

            if (webhookUrl && !partnerWebhooks.isSafeUrl(webhookUrl)) {
                return res.status(400).json({ error: 'webhookUrl must be a valid public https URL' });
            }

            const creds = await generatePartnerCredentials();
            const webhookSecret = partnerWebhooks.generateSecret();

            const doc = await databases.createDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_API_PARTNERS_COLLECTION_ID,
                ID.unique(),
                {
                    partnerId: creds.partnerId,
                    apiKeyHash: creds.apiKeyHash,
                    userId,
                    name,
                    status: true,
                    webhookUrl: webhookUrl || null,
                    webhookSecret,
                    webhookEnabled: !!webhookEnabled,
                }
            );

            partnerWebhooks.reloadIndex().catch(() => {});

            res.status(201).json({
                success: true,
                partnerId: creds.partnerId,
                name,
                userId,
                status: true,
                webhookUrl: webhookUrl || null,
                webhookEnabled: !!webhookEnabled,
                // Both secrets shown once — store them now.
                apiKey: creds.apiKey,        // for X-API-Key auth
                webhookSecret,               // for verifying X-Kitepay-Signature on webhooks
                _id: doc.$id,
            });
        } catch (e) {
            console.error('Create partner error:', e);
            res.status(500).json({ error: 'Failed to create partner' });
        }
    });

    // List partners (paginated, no secrets).
    router.get('/admin/partners', authenticateAdmin, async (req, res) => {
        try {
            const { limit = 25, cursor } = req.query;
            const queries = [Query.orderDesc('$createdAt'), Query.limit(Math.min(parseInt(limit) || 25, 100))];
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const list = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_API_PARTNERS_COLLECTION_ID, queries);
            const partners = list.documents.map(d => ({
                _id: d.$id,
                partnerId: d.partnerId,
                name: d.name,
                userId: d.userId,
                status: d.status,
                webhookUrl: d.webhookUrl || null,
                webhookEnabled: !!d.webhookEnabled,
                createdAt: d.$createdAt,
            }));
            res.json({
                success: true,
                partners,
                total: list.total,
                nextCursor: partners.length ? partners[partners.length - 1]._id : null,
            });
        } catch (e) {
            console.error('List partners error:', e);
            res.status(500).json({ error: 'Failed to list partners' });
        }
    });

    // Rotate a partner's secret and/or update fields (incl. webhook config).
    router.put('/admin/partners/:partnerId', authenticateAdmin, async (req, res) => {
        try {
            const { partnerId } = req.params;
            const { name, userId, status, rotateKey, webhookUrl, webhookEnabled, rotateWebhookSecret } = req.body || {};

            const docs = await databases.listDocuments(
                APPWRITE_DATABASE_ID, APPWRITE_API_PARTNERS_COLLECTION_ID,
                [Query.equal('partnerId', partnerId), Query.limit(1)]
            );
            const partner = docs.documents[0];
            if (!partner) return res.status(404).json({ error: 'Partner not found' });

            const updates = {};
            if (name !== undefined) updates.name = name;
            if (userId !== undefined) {
                const subadmin = await findSubadmin(userId);
                if (!subadmin) return res.status(400).json({ error: 'userId must be an existing subadmin' });
                updates.userId = userId;
            }
            if (status !== undefined) updates.status = status;

            // Webhook config
            if (webhookUrl !== undefined) {
                if (webhookUrl && !partnerWebhooks.isSafeUrl(webhookUrl)) {
                    return res.status(400).json({ error: 'webhookUrl must be a valid public https URL' });
                }
                updates.webhookUrl = webhookUrl || null;
            }
            if (webhookEnabled !== undefined) updates.webhookEnabled = !!webhookEnabled;

            let newApiKey = null;
            if (rotateKey === true) {
                const secret = crypto.randomBytes(32).toString('hex');
                updates.apiKeyHash = await bcrypt.hash(secret, 12);
                newApiKey = `${partner.partnerId}.${secret}`;
            }

            let newWebhookSecret = null;
            if (rotateWebhookSecret === true) {
                newWebhookSecret = partnerWebhooks.generateSecret();
                updates.webhookSecret = newWebhookSecret;
            }

            const updated = await databases.updateDocument(
                APPWRITE_DATABASE_ID, APPWRITE_API_PARTNERS_COLLECTION_ID, partner.$id, updates
            );

            // Keep the webhook dispatch index in sync with any change.
            partnerWebhooks.reloadIndex().catch(() => {});

            res.json({
                success: true,
                partner: {
                    partnerId: updated.partnerId, name: updated.name, userId: updated.userId, status: updated.status,
                    webhookUrl: updated.webhookUrl || null, webhookEnabled: !!updated.webhookEnabled,
                },
                ...(newApiKey && { newApiKey }),
                ...(newWebhookSecret && { newWebhookSecret }),
            });
        } catch (e) {
            console.error('Update partner error:', e);
            res.status(500).json({ error: 'Failed to update partner' });
        }
    });

    // ── Webhook delivery log + manual retry (admin) ──────────────────────────
    // List a partner's webhook deliveries, newest first. Optional ?status=failed|dead|success|pending
    router.get('/admin/partners/:partnerId/deliveries', authenticateAdmin, async (req, res) => {
        try {
            const { partnerId } = req.params;
            const { status, limit = 25, cursor } = req.query;

            const queries = [Query.equal('partnerId', partnerId)];
            if (status) queries.push(Query.equal('status', String(status).toLowerCase()));
            queries.push(Query.orderDesc('$createdAt'));
            queries.push(Query.limit(Math.min(parseInt(limit) || 25, 100)));
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const list = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID, queries);
            const deliveries = list.documents.map(d => ({
                _id: d.$id,
                deliveryId: d.deliveryId,
                eventType: d.eventType,
                txnId: d.txnId,
                status: d.status,
                attempts: d.attempts,
                maxAttempts: d.maxAttempts,
                responseCode: d.responseCode ?? null,
                error: d.error || null,
                nextAttemptAt: d.nextAttemptAt || null,
                lastAttemptAt: d.lastAttemptAt || null,
                createdAt: d.createdAt || d.$createdAt,
            }));
            res.json({
                success: true,
                deliveries,
                total: list.total,
                nextCursor: deliveries.length ? deliveries[deliveries.length - 1]._id : null,
            });
        } catch (e) {
            console.error('List deliveries error:', e);
            res.status(500).json({ error: 'Failed to list deliveries' });
        }
    });

    // Manually re-send a delivery now (e.g. after a partner fixed their endpoint).
    router.post('/admin/deliveries/:deliveryId/retry', authenticateAdmin, async (req, res) => {
        try {
            const { deliveryId } = req.params;
            const result = await partnerWebhooks.requeue(deliveryId);
            if (!result) return res.status(404).json({ error: 'Delivery not found' });
            res.json({ success: true, deliveryId, status: result.status, attempts: result.attempts, responseCode: result.responseCode ?? null });
        } catch (e) {
            console.error('Retry delivery error:', e);
            res.status(500).json({ error: 'Failed to retry delivery' });
        }
    });

    return router;
};
