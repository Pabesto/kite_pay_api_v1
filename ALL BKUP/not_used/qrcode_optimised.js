const express = require('express');
const Razorpay = require("razorpay");
const fs = require("fs");
const axios = require("axios");
const { File } = require('buffer');
const path = require('path');

// --------------------
// Razorpay Setup
// --------------------
// TEST MODE
// const razorpay = new Razorpay({
//   key_id: 'rzp_test_R9fF4cePyFbq4m',
//   key_secret: 'YK65c6Y1AO6rNSx6SzMUv8wP',
// });
// Production mode
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

module.exports = (
  databases, storage, users, ID,
  APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
  Qr_collectionId, bucketId,
  authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin,
  roleAuth, requireRole
) => {
  const router = express.Router();

  function getISTTime() {
    return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString();
  }

  function mapQrCode(doc) {
    return {
      qrId: doc.qrId,
      fileId: doc.fileId,
      imageUrl: doc.imageUrl,
      assignedUserId: doc.assignedUserId || null,
      createdAt: doc.createdAt,
      isActive: doc.isActive,
      totalTransactions: doc.totalTransactions || 0,
      totalPayInAmount: doc.totalPayInAmount || 0,
    };
  }

  async function getUserDetails(userId) {
    try {
      const user = await users.get(userId);
      return { name: user.name || null, email: user.email || null };
    } catch {
      return { name: null, email: null };
    }
  }

  async function assignQrToUser({ qrId, assignedUserId }) {
    const docResult = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
      Query.equal('qrId', qrId)
    ]);
    if (docResult.documents.length === 0) throw new Error("QR Code not found");
    const docId = docResult.documents[0].$id;
    await databases.updateDocument(
      APPWRITE_DATABASE_ID,
      Qr_collectionId,
      docId,
      { assignedUserId: assignedUserId === '' ? null : assignedUserId }
    );
    return { success: true, docId };
  }

  async function saveQrEntry({ qrId, fileId, imageUrl, createdByUserId, createdAt, assignedUserId = null }) {
    return await databases.createDocument(
      APPWRITE_DATABASE_ID,
      Qr_collectionId,
      ID.unique(),
      { qrId, fileId, imageUrl, assignedUserId, createdByUserId, isActive: true, createdAt }
    );
  }

  async function hasFiveActiveQRCodes(userId) {
    const response = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      Qr_collectionId,
      [Query.equal('assignedUserId', userId)]
    );
    const activeCount = response.documents.filter(doc => doc.isActive === true).length;
    return { hasFiveActive: activeCount >= 5, activeCount };
  }

    function sanitizeFileName(name) {
        // Only allow alphanumeric, dash, underscore
        return name.replace(/[^a-zA-Z0-9-_]/g, '');
    }

  async function createAndAssignQr(userId) {
    const { hasFiveActive, activeCount } = await hasFiveActiveQRCodes(userId);
    if (hasFiveActive) throw new Error(`User already has ${activeCount} active QR codes. Cannot assign more.`);
    const { name, email } = await getUserDetails(userId);
    const qr = await razorpay.qrCode.create({
      type: "upi_qr",
      name: email || "Kite User",
      usage: "multiple_use",
      fixed_amount: false,
      description: `${name || "Kite User"} : ${email || ""}`,
      notes: { userId },
    });
    const safeQrId = sanitizeFileName(qr.id);
    const localPath = `/tmp/${safeQrId}.png`;
    const response = await axios.get(qr.image_url, { responseType: "arraybuffer" });
    fs.writeFileSync(localPath, response.data);
    const fileBuffer = fs.readFileSync(localPath);
    const fileName = path.basename(localPath);
    const fileObject = new File([fileBuffer], fileName, { type: 'image/png' });
    const file = await storage.createFile(bucketId, ID.unique(), fileObject);
    const imageUrl = `https://fra.cloud.appwrite.io/v1/storage/buckets/${bucketId}/files/${file.$id}/view?project=688c98fd002bfe3cf596`;
    const newQrCode = await saveQrEntry({
      qrId: qr.id,
      fileId: file.$id,
      imageUrl,
      createdByUserId: userId,
      createdAt: getISTTime(),
    });
    await assignQrToUser({ qrId: qr.id, assignedUserId: userId });
    return { qr, file, newQrCode };
  }

  // GET all QR codes (admin)
  router.get('/qr-codes', authenticateAdmin, async (req, res) => {
    try {
      const result = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
        Query.orderDesc('createdAt'),
        Query.limit(100)
      ]);
      res.status(200).json(result.documents.map(mapQrCode).reverse());
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch QR codes.", error: error.message });
    }
  });

  // POST a new QR code entry (admin)
  router.post('/create-qr-entry', authenticateAdmin, async (req, res) => {
    const { qrId, fileId, imageUrl, createdAt } = req.body;
    if (!qrId || !fileId || !imageUrl) {
      return res.status(400).json({ message: "Missing required fields: qrId, fileId, or imageUrl." });
    }
    try {
      const newQrCode = await saveQrEntry({
        qrId,
        fileId,
        imageUrl,
        createdByUserId: req.user.userId,
        createdAt,
      });
      res.status(201).json({ message: "QR Code entry created successfully.", qrCode: newQrCode });
    } catch (error) {
      res.status(500).json({ message: "Failed to create QR code entry.", error: error.message });
    }
  });

  // DELETE a QR code (admin)
  router.delete('/delete-qr/:qrId', authenticateAdmin, async (req, res) => {
    const { qrId } = req.params;
    try {
      const docResult = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
        Query.equal('qrId', qrId)
      ]);
      if (docResult.documents.length === 0) {
        return res.status(404).json({ message: "QR Code not found." });
      }
      const doc = docResult.documents[0];
      await storage.deleteFile(bucketId, doc.fileId);
      await databases.deleteDocument(APPWRITE_DATABASE_ID, Qr_collectionId, doc.$id);
      res.status(200).json({ message: "QR Code and file deleted successfully." });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete QR code.", error: error.message });
    }
  });

  // PUT to toggle the isActive status
  router.put('/toggle-qr-status/:qrId', authenticateAdminOrSubAdmin, async (req, res) => {
    const { qrId } = req.params;
    const { isActive } = req.body;
    const userRequested = req.user;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: "Invalid value for 'isActive'." });
    }
    try {
      const docResult = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
        Query.equal('qrId', qrId)
      ]);
      if (docResult.documents.length === 0) {
        return res.status(404).json({ message: "QR Code not found." });
      }
      const doc = docResult.documents[0];
      if (userRequested.role === 'subadmin') {
        if (doc.createdByUserId !== userRequested.$id) {
          return res.status(403).json({ message: 'Forbidden: Cannot edit QR codes not created by you' });
        }
        if (isActive === true) {
          return res.status(403).json({ message: 'Forbidden: Subadmin cannot activate an active QR code' });
        }
      }
      await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, doc.$id, { isActive });
      res.status(200).json({ message: "QR Code status updated successfully." });
    } catch (error) {
      res.status(500).json({ message: "Failed to update QR code status.", error: error.message });
    }
  });

  // PUT to assign a user to a QR code
  router.put('/assign-qr/:qrId', authenticateAdminOrSubAdmin, async (req, res) => {
    const { qrId } = req.params;
    const { assignedUserId } = req.body;
    try {
      await assignQrToUser({ qrId, assignedUserId });
      res.status(200).json({ message: "User assignment updated successfully." });
    } catch (error) {
      res.status(500).json({ message: "Failed to update user assignment.", error: error.message });
    }
  });

  // GET QR codes for a user
  router.get('/qr-codes/user/:userId', async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ message: 'Missing userId parameter' });
    try {
      const response = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        Qr_collectionId,
        [Query.or([
          Query.equal('assignedUserId', userId),
          Query.equal('createdByUserId', userId),
        ])]
      );
      res.status(200).json(response.documents.map(mapQrCode));
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch user QR codes.', error: error.message });
    }
  });

  // Unified QR creation endpoint for admin and subadmin
  async function handleCreateQr(req, res, userId) {
    try {
      const { qr } = await createAndAssignQr(userId);
      res.json({
        success: true,
        razorpayQrId: qr.id,
        qrImageUrl: qr.image_url,
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  router.post("/create-qr/:userId", authenticateAdminOrSubAdmin, async (req, res) => {
    const userId = req.user.userId;
    await handleCreateQr(req, res, userId);
  });

  router.post("/create-admin-qr/:userId", authenticateAdmin, async (req, res) => {
    const { userId } = req.params;
    await handleCreateQr(req, res, userId);
  });

  return router;
};