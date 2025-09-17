router.patch('/transactions/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id: TxnID } = req.params;
    const { qrCodeId, rrnNumber, amount, isoDate /* status removed */ } = req.body;

    // Guard: status is not allowed in this endpoint
    if ('status' in req.body) {
      return res.status(400).json({ error: 'Use /transactions/:id/status to update status' });
    } // enforce separation of concerns [web:185][web:198]

    // 1) Fetch existing transaction
    const Txndocuments = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      '688cf5920023475022df',
      [Query.equal('$id', TxnID), Query.limit(1)]
    );
    const tx = Txndocuments.documents[0];
    if (!tx) return res.status(404).json({ error: 'Transaction not found' }); // standard REST practice [web:185]

    // 2) Prepare validated updates (partial)
    const updates = {};
    if (typeof rrnNumber === 'string' && rrnNumber.trim()) {
      updates.rrnNumber = rrnNumber.trim();
    }
    if (typeof qrCodeId === 'string' && qrCodeId.trim()) {
      updates.qrCodeId = qrCodeId.trim();
    }
    if (typeof isoDate === 'string' && isoDate.trim()) {
      const iso = new Date(isoDate);
      if (isNaN(iso.getTime())) {
        return res.status(400).json({ error: 'isoDate must be ISO-8601' });
      } // input validation best practice [web:185]
      updates.created_at = iso.toISOString();
    }
    let newAmountPaise;
    if (amount !== undefined && amount !== null) {
      newAmountPaise = toPaise(String(amount)); // normalize rupees to paise [web:185]
      updates.amount = newAmountPaise;
    }

    // 3) Early exit if no updates
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    } // minimal mutation principle [web:185]

    // 4) Capture old for reconciliation
    const oldQrId = tx.qrCodeId;
    const oldAmountPaise = Number(tx.amount || 0);
    const prevStatus = ((tx.status && tx.status.trim()) || 'normal').toLowerCase(); // use existing status only [web:185]

    // 5) Persist transaction updates
    const updated = await databases.updateDocument(
      APPWRITE_DATABASE_ID,
      '688cf5920023475022df',
      TxnID,
      updates
    ); // apply partial update before aggregates [web:198]

    // 6) Helpers
    const recomputeAvailable = (qrDocLike) => {
      const total = Number(qrDocLike.totalPayInAmount || 0);
      const approved = Number(qrDocLike.withdrawalApprovedAmount || 0);
      const requested = Number(qrDocLike.withdrawalRequestedAmount || 0);
      const hold = Number(qrDocLike.amountOnHold || 0);
      return total - approved - requested - hold;
    }; // available is derived, not set arbitrarily [web:170][web:176]

    const hasAmountChange = typeof newAmountPaise === 'number' && newAmountPaise !== oldAmountPaise;
    const newQrId = updates.qrCodeId ?? oldQrId;
    const movedQr = newQrId !== oldQrId;

    const isPrevNormal = prevStatus === 'normal'; // status snapshot used for reconciliation [web:185]

    // 5A) Same QR, amount changed: adjust based on existing status
    if (hasAmountChange && !movedQr) {
      const amountDiff = newAmountPaise - oldAmountPaise; // +/- delta [web:185]

      const qrList = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
        Query.equal('qrId', oldQrId),
        Query.limit(1),
      ]);
      if (qrList.documents.length) {
        const qr = qrList.documents[0];

        if (isPrevNormal) {
          // Normal: adjust ledger total; available derives from totals
          const newTotal = Number(qr.totalPayInAmount || 0) + amountDiff;
          await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, qr.$id, {
            totalPayInAmount: newTotal,
            amountAvailableForWithdrawal: recomputeAvailable({ ...qr, totalPayInAmount: newTotal }),
          }); // no hold change in normal edits [web:176][web:179]
        } else {
          // Non-normal: adjust hold only; totals unchanged
          const newHold = Number(qr.amountOnHold || 0) + (newAmountPaise - oldAmountPaise);
          await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, qr.$id, {
            amountOnHold: newHold,
            amountAvailableForWithdrawal: recomputeAvailable({ ...qr, amountOnHold: newHold }),
          }); // holds reduce available by formula [web:170][web:176]
        }
      }
    }

    // 5B) QR changed: remove prior impact from old QR, add new impact to new QR, based on existing status
    if (movedQr) {
      // Old QR: reverse prior impact
      if (oldQrId) {
        const oldQrList = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
          Query.equal('qrId', oldQrId),
          Query.limit(1),
        ]);
        if (oldQrList.documents.length) {
          const oldQr = oldQrList.documents[0];
          if (isPrevNormal) {
            const newTotal = Number(oldQr.totalPayInAmount || 0) - oldAmountPaise;
            await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, oldQr.$id, {
              totalPayInAmount: newTotal,
              totalTransactions: Math.max(0, (oldQr.totalTransactions || 0) - 1),
              amountAvailableForWithdrawal: recomputeAvailable({ ...oldQr, totalPayInAmount: newTotal }),
            }); // remove from totals for normal tx [web:176][web:179]
          } else {
            const newHold = Number(oldQr.amountOnHold || 0) - oldAmountPaise;
            await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, oldQr.$id, {
              amountOnHold: newHold,
              totalTransactions: Math.max(0, (oldQr.totalTransactions || 0) - 1),
              amountAvailableForWithdrawal: recomputeAvailable({ ...oldQr, amountOnHold: newHold }),
            }); // remove from hold for non-normal tx [web:170][web:176]
          }
        }
      }

      // New QR: apply current impact with existing status
      if (newQrId) {
        const newQrList = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
          Query.equal('qrId', newQrId),
          Query.limit(1),
        ]);
        if (newQrList.documents.length) {
          const newQr = newQrList.documents[0];
          const postAmount = Number(updated.amount ?? oldAmountPaise); // use new amount if changed [web:185]

          if (isPrevNormal) {
            const newTotal = Number(newQr.totalPayInAmount || 0) + postAmount;
            await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, newQr.$id, {
              totalPayInAmount: newTotal,
              totalTransactions: (newQr.totalTransactions || 0) + 1,
              amountAvailableForWithdrawal: recomputeAvailable({ ...newQr, totalPayInAmount: newTotal }),
            }); // add to totals for normal tx [web:176][web:179]
          } else {
            const newHold = Number(newQr.amountOnHold || 0) + postAmount;
            await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, newQr.$id, {
              amountOnHold: newHold,
              totalTransactions: (newQr.totalTransactions || 0) + 1,
              amountAvailableForWithdrawal: recomputeAvailable({ ...newQr, amountOnHold: newHold }),
            }); // add to holds for non-normal tx [web:170][web:176]
          }
        } else {
          console.warn(`Target QR ${newQrId} not found while reconciling`); // operational logging [web:185]
        }
      }
    }

    return res.status(200).json({ message: 'Transaction updated', transaction: updated });
  } catch (err) {
    console.error('❌ Edit transaction error:', err.message || err);
    return res.status(500).json({ error: err.message || 'Update failed' });
  }
});
