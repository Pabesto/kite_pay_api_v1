async function handleWithdrawalApproval(withdrawal) {
  // withdrawal includes userId, amount, commission, parentId (if any)
  const userId = withdrawal.userId;

  // fetch userMeta
  const user = await getUserMeta(userId);

  if (!user) throw new Error("User not found");

  // define commission transactions list to create
  const commissionTxs = [];

  if (user.parentId) {
    // user has a parent - user is subadmin under an admin

    // fetch parent (admin) meta
    const parent = await getUserMeta(user.parentId);

    if (!parent) throw new Error("Parent (admin) user not found");

    // Calculate commission for subadmin (= user)
    const subadminCommissionAmount = calculateCommission(
      withdrawal.preAmount * 100, // amount in paise
      user.commission // as percentage, e.g. 1.5
    ) / 100; // convert back to Rs

    commissionTxs.push({
      userId: user.userId,
      sourceWithdrawalId: withdrawal.id,
      amount: subadminCommissionAmount,
      commissionRate: user.commission,
      earningType: 'subadmin',
      createdAt: new Date().toISOString(),
    });

    // Calculate commission for admin (parent)
    const adminCommissionAmount = calculateCommission(
      withdrawal.preAmount * 100,
      parent.commission
    ) / 100;

    commissionTxs.push({
      userId: parent.userId,
      sourceWithdrawalId: withdrawal.id,
      amount: adminCommissionAmount,
      commissionRate: parent.commission,
      earningType: 'admin',
      createdAt: new Date().toISOString(),
    });
  } else {
    // User has no parent - user is subadmin, admin earns commission only

    // Fetch admin userMeta (you need a way to identify admin, e.g. user with role 'admin')
    const admin = await findAdminUser(); // implement according to your logic

    const adminCommissionAmount = calculateCommission(
      withdrawal.preAmount * 100,
      admin.commission
    ) / 100;

    commissionTxs.push({
      userId: admin.userId,
      sourceWithdrawalId: withdrawal.id,
      amount: adminCommissionAmount,
      commissionRate: admin.commission,
      earningType: 'admin',
      createdAt: new Date().toISOString(),
    });
  }

  // Now create Commission Transactions in Appwrite DB
  for (const tx of commissionTxs) {
    await databases.createDocument(
      APPWRITE_DATABASE_ID,
      CommissionTransactions_collectionId,
      ID.unique(),
      tx
    );
  }
}
