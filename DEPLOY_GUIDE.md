# إزاي تنشري ميزة "تغيير الباسورد المباشر"

الميزة دي محتاجة **Cloud Function** (كود بيشتغل على سيرفرات Firebase نفسها،
مش على المتصفح) عشان تقدري تغيّري باسورد حد تاني مباشرة. من غيرها Firebase
مش بيسمح بده خالص لأسباب أمان.

## خطوة 0: هتحتاجي مرة واحدة بس
- جهاز كمبيوتر (مش موبايل) فيه Node.js — لو مش عندك، نزّليه من nodejs.org (اختاري نسخة LTS)
- تفعيل خطة **Blaze** (Pay as you go) في مشروعك على Firebase:
  Firebase Console → ⚙️ Project settings → Usage and billing → Modify plan → Blaze
  (فيها حد مجاني كل شهر لعشرات آلاف الاستدعاءات، احتمال كبير إنك متدفعيش حاجة خالص لحجم استخدامك)

## خطوة 1: تثبيت أدوات Firebase
افتحي Terminal أو Command Prompt واكتبي:
```
npm install -g firebase-tools
firebase login
```
(هيفتح المتصفح تسجّلي دخول بحساب Google بتاع مشروع girls-mall)

## خطوة 2: تجهيز مجلد الـ functions
- اعملي مجلد فاضي لمشروعك (لو معملتيهوش قبل كده)، وافتحي فيه Terminal
- نفذي:
```
firebase init functions
```
- اختاري: **Use an existing project** → اختاري **girls-mall**
- اللغة: **JavaScript**
- ESLint: **No**
- تثبيت الباكدجات دلوقتي: **Yes**

هيتعمللك مجلد اسمه `functions` فيه `index.js` و `package.json`.

## خطوة 3: استبدلي الملفين
امسحي محتوى `functions/index.js` و `functions/package.json` اللي اتعملوا،
واستبدليهم بالملفين اللي بعتهملك (نفس الاسم بالظبط).

بعدها ادخلي مجلد functions ونفذي:
```
cd functions
npm install
cd ..
```

## خطوة 4: النشر
من مجلد المشروع الرئيسي (مش من جوه functions):
```
firebase deploy --only functions
```

استني شوية (ممكن تاخد دقيقة لدقيقتين). لما تخلص هتلاقي رسالة
`✔ Deploy complete!`

## بعد كده
مفيش أي تعديل تاني مطلوب — زرار "تغيير الباسورد" في لوحة الأدمن هيشتغل
مباشرة من الموقع من غير إيميل، وهيفتحلك واتساب تبعتي بيه الباسورد الجديد
للمديرة تلقائي.

**ملحوظة:** لو غيّرتي كود الـ function تاني في المستقبل، لازم تعملي
`firebase deploy --only functions` تاني عشان التغيير يتفعّل.
