// ===== הגדרות החיבור ל-Firebase =====
// מעתיקים לכאן את הפרטים מ-Firebase Console → Project settings → Your apps → Web app.
// הפרטים האלה ציבוריים מטבעם (הם מופיעים בכל אתר שמשתמש ב-Firebase) – האבטחה נעשית בקובץ firestore.rules.
export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  appId: 'REPLACE_ME'
};

// שם המשתמש של רבקה בדף הניהול. בפועל Firebase שומר אותו כמייל: rivka@rivka-cohen.studio
// (המייל לא צריך להיות אמיתי – הוא רק מזהה. אותו מייל בדיוק חייב להופיע גם ב-firestore.rules)
export const ADMIN_EMAIL_DOMAIN = 'rivka-cohen.studio';
