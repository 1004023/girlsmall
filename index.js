const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

/**
 * الأدمن بس (اللي role بتاعه admin في Firestore) يقدر يستخدم الدالة دي
 * عشان يغيّر باسورد أي حساب مديرة مباشرة من غير إيميل.
 *
 * بيتنادى من الموقع كده:
 * const setPassword = httpsCallable(functions, 'adminSetManagerPassword');
 * await setPassword({ uid: managerUid, newPassword: 'كلمة السر الجديدة' });
 */
exports.adminSetManagerPassword = functions.https.onCall(async (data, context) => {
  // 1) لازم تكون مسجلة دخول
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "لازم تسجلي دخول الأول"
    );
  }

  // 2) لازم تكون أدمن فعلاً - بنتأكد من قاعدة البيانات، مش من كلام اللي بيبعت الطلب
  const callerDoc = await admin
    .firestore()
    .collection("users")
    .doc(context.auth.uid)
    .get();

  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new functions.https.HttpsError(
      "permission-denied",
      "الصلاحية دي للأدمن بس"
    );
  }

  // 3) التحقق من البيانات المطلوبة
  const { uid, newPassword } = data || {};
  if (!uid || !newPassword || String(newPassword).length < 6) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "بيانات ناقصة أو كلمة السر أقل من 6 حروف/أرقام"
    );
  }

  // 4) تغيير الباسورد فعلياً عن طريق Admin SDK
  await admin.auth().updateUser(uid, { password: newPassword });

  return { success: true };
});
