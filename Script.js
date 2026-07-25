import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail, createUserWithEmailAndPassword,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword, setPersistence,
  indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js";
import {
  getFirestore, collection, getDocs, addDoc, doc, getDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyC6CuhFXgzgeyyGNi-uc8gU1NJNLeFDB7M",
  authDomain: "girls-mall.firebaseapp.com",
  projectId: "girls-mall",
  storageBucket: "girls-mall.firebasestorage.app",
  messagingSenderId: "378648553476",
  appId: "1:378648553476:web:6ee7d7ec4b36b94aaaed51",
  measurementId: "G-EQ19C48DQH"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

// تسجيل الدخول (أدمن/مديرة) يفضل محفوظ حتى لو قفلت المتصفح أو الموبايل
// ومترجعش تسجلي دخول تاني غير لما تعملي "تسجيل خروج" بنفسك
// بنجرب أقوى طريقة حفظ الأول (IndexedDB)، ولو المتصفح مش داعمها بنقع لطريقة تانية بدالها
//
// ملحوظة مهمة: دي بقت async IIFE (مش top-level await) عشان الصفحة كلها،
// وعلى رأسها زرار "دخول"، تبقى شغالة فورًا من غير ما تستنى الشبكة تجاوب على
// الإعداد ده. قبل كده كانت await هنا بتأخر تعريف window.doLogin وباقي
// الدوال، فلو المستخدمة ضغطت "دخول" بسرعة كانت بتاخد رسالة غلط رغم إن
// بياناتها صح، لأن الدالة نفسها ماكانتش اتعرفت لسه.
(async ()=>{
  try{
    await setPersistence(auth, indexedDBLocalPersistence);
  }catch(e1){
    console.log('indexedDB persistence failed, trying localStorage:', e1);
    try{
      await setPersistence(auth, browserLocalPersistence);
    }catch(e2){
      console.log('localStorage persistence failed too, trying session only:', e2);
      try{ await setPersistence(auth, browserSessionPersistence); }catch(e3){ console.log('all persistence options failed:', e3); }
    }
  }
})();

// بتحول رقم موبايل مصري (01xxxxxxxxx) لصيغة دولية عشان لينك واتساب (wa.me)
function normalizeEgyptPhone(phone){
  let p = (phone || '').replace(/[^\d]/g, '');
  if(p.startsWith('0')) p = '20' + p.slice(1);
  else if(!p.startsWith('20')) p = '20' + p;
  return p;
}

let CATEGORIES = [];

let DATA = {vendors:[], products:[], reviews:{}, coupons:[]};
let CART = [];
let appliedCoupons = {}; // { brandId: {code, discountType, discountValue, discountAmount, finalTotal} }
let currentUser = null; // { uid, role, brandId, name }

function catLabel(id){ const c = CATEGORIES.find(c=>c.id===id); return c? c.label : id; }

// ============== تحميل البيانات من Firebase ==============
async function loadData(){
  const catsSnap = await getDocs(collection(db, "categories"));
  CATEGORIES = catsSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const brandsSnap = await getDocs(collection(db, "brands"));
  DATA.vendors = brandsSnap.docs
    .map(d=>({id:d.id, ...d.data()}))
    .filter(v=>v.isActive !== false);

  const productsSnap = await getDocs(collection(db, "products"));
  DATA.products = productsSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const reviewsSnap = await getDocs(collection(db, "reviews"));
  DATA.reviews = {};
  reviewsSnap.docs.forEach(d=>{
    const r = {id:d.id, ...d.data()};
    if(!DATA.reviews[r.productId]) DATA.reviews[r.productId] = [];
    DATA.reviews[r.productId].push(r);
  });

  const couponsSnap = await getDocs(collection(db, "coupons"));
  DATA.coupons = couponsSnap.docs
    .map(d=>({id:d.id, ...d.data()}))
    .filter(c=>c.active !== false);
}

function getReviewStats(productId){
  const list = DATA.reviews[productId] || [];
  if(list.length===0) return {avg:0, count:0};
  const sum = list.reduce((s,r)=>s+(r.rating||0), 0);
  return {avg: sum/list.length, count: list.length};
}
function renderStars(avg){
  const full = Math.round(avg);
  return '★'.repeat(full) + '☆'.repeat(5-full);
}
window.toggleReviewForm = function(productId){
  document.getElementById('reviewForm-'+productId).classList.toggle('show');
}
window.submitReview = async function(productId){
  const customerName = document.getElementById('revName-'+productId).value.trim() || 'عميلة';
  const rating = parseInt(document.getElementById('revStars-'+productId).value);
  const comment = document.getElementById('revComment-'+productId).value.trim();
  try{
    await addDoc(collection(db,"reviews"), { productId, customerName, rating, comment, createdAt: serverTimestamp() });
    showToast('شكراً لتقييمك ❤️');
    if(!DATA.reviews[productId]) DATA.reviews[productId] = [];
    DATA.reviews[productId].push({customerName, rating, comment});
    openVendor(DATA.products.find(p=>p.id===productId).brandId);
  }catch(e){
    showToast('حصل خطأ: ' + e.message);
  }
}

// ============== مودال تفاصيل المنتج (الصورة بتكبر والتفاصيل تظهر) ==============
window.openProductDetails = function(productId){
  const p = DATA.products.find(x=>x.id===productId);
  if(!p) return;
  const vendor = DATA.vendors.find(v=>v.id===p.brandId);
  const stats = getReviewStats(p.id);
  const reviews = (DATA.reviews[p.id]||[]).slice(-5).reverse();
  document.getElementById('productModalContent').innerHTML = `
    <div class="pmodal-img">${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}">` : (p.emoji||'📦')}</div>
    <div class="pmodal-body">
      ${vendor ? `<div class="card-vendor" onclick="closeProductModal(); openVendor('${p.brandId}')">${vendor.name}</div>` : ''}
      <h2>${p.name}</h2>
      ${stats.count>0 ? `<div class="stars">${renderStars(stats.avg)} (${stats.count} تقييم)</div>` : `<div class="stars" style="color:var(--plum-soft);">لسه من غير تقييم</div>`}
      <p style="color:var(--plum-soft); line-height:1.9; margin:14px 0;">${p.desc || 'لا يوجد وصف لهذا المنتج'}</p>
      <div class="card-footer" style="margin-bottom:14px;">
        <span class="price" style="font-size:20px;">${p.price} ج.م</span>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="fav-heart" style="position:static;" data-pid="${p.id}" onclick="toggleFavorite('${p.id}', event)">${isFavorite(p.id) ? '❤️' : '🤍'}</button>
          <button class="add-btn" onclick="addToCart('${p.id}')">♡أضيفي للسلة</button>
        </div>
      </div>
      <button class="review-toggle" onclick="togglePmReviewForm('${p.id}')">⭐ قيّمي المنتج ده</button>
      <div class="review-form" id="pmReviewForm-${p.id}">
        <input id="pmRevName-${p.id}" type="text" placeholder="اسمك">
        <select id="pmRevStars-${p.id}">
          <option value="5">★★★★★ ممتاز</option>
          <option value="4">★★★★ كويس أوي</option>
          <option value="3">★★★ عادي</option>
          <option value="2">★★ مش عاجبني</option>
          <option value="1">★ سيء</option>
        </select>
        <textarea id="pmRevComment-${p.id}" placeholder="رأيك في المنتج (اختياري)" rows="2"></textarea>
        <button onclick="submitPmReview('${p.id}')">إرسال التقييم</button>
        ${reviews.map(r=>`<div class="review-item">${'★'.repeat(r.rating)} — <b>${r.customerName||'عميلة'}</b>${r.comment ? `: ${r.comment}` : ''}</div>`).join('')}
      </div>
    </div>
  `;
  document.getElementById('productModalOverlay').classList.add('show');
}
window.closeProductModal = function(){
  document.getElementById('productModalOverlay').classList.remove('show');
}
window.togglePmReviewForm = function(productId){
  document.getElementById('pmReviewForm-'+productId).classList.toggle('show');
}
window.submitPmReview = async function(productId){
  const customerName = document.getElementById('pmRevName-'+productId).value.trim() || 'عميلة';
  const rating = parseInt(document.getElementById('pmRevStars-'+productId).value);
  const comment = document.getElementById('pmRevComment-'+productId).value.trim();
  try{
    await addDoc(collection(db,"reviews"), { productId, customerName, rating, comment, createdAt: serverTimestamp() });
    showToast('شكراً لتقييمك ❤️');
    if(!DATA.reviews[productId]) DATA.reviews[productId] = [];
    DATA.reviews[productId].push({customerName, rating, comment});
    openProductDetails(productId); // نحدّث محتوى المودال عشان يظهر التقييم الجديد
  }catch(e){
    showToast('حصل خطأ: ' + e.message);
  }
}

// ============== تقييم الموقع العام / تعليق الزوار ==============
let sfRating = 0;
window.sfSetRating = function(v){
  sfRating = v;
  document.querySelectorAll('#sfStars span').forEach(s=>{
    s.classList.toggle('on', parseInt(s.dataset.v) <= v);
  });
}
window.submitSiteFeedback = async function(){
  const comment = document.getElementById('sfComment').value.trim();
  if(sfRating===0 && !comment){ showToast('اختاري تقييم أو اكتبي تعليق الأول'); return; }
  try{
    await addDoc(collection(db,"siteFeedback"), {
      rating: sfRating || null,
      comment,
      customerName: currentUser ? currentUser.name : '',
      createdAt: serverTimestamp()
    });
    showToast('شكراً لرأيك ❤️');
    sfRating = 0;
    document.querySelectorAll('#sfStars span').forEach(s=>s.classList.remove('on'));
    document.getElementById('sfComment').value = '';
  }catch(e){
    showToast('حصل خطأ: ' + e.message);
  }
}

let FAVORITES = [];
function loadFavorites(){
  try{ FAVORITES = JSON.parse(localStorage.getItem('gm_favorites') || '[]'); }
  catch(e){ FAVORITES = []; }
}
function saveFavorites(){
  localStorage.setItem('gm_favorites', JSON.stringify(FAVORITES));
  updateFavCount();
}
function updateFavCount(){
  const el = document.getElementById('favCount');
  if(FAVORITES.length>0){ el.style.display='flex'; el.textContent = FAVORITES.length; } else{ el.style.display='none'; }
}
window.isFavorite = function(productId){ return FAVORITES.includes(productId); }
window.toggleFavorite = function(productId, event){
  if(event) event.stopPropagation();
  if(FAVORITES.includes(productId)){ FAVORITES = FAVORITES.filter(id=>id!==productId); }
  else{ FAVORITES.push(productId); }
  saveFavorites();
  // تحديث شكل القلب فورًا في كل الأماكن اللي المنتج ده ظاهر فيها
  document.querySelectorAll(`.fav-heart[data-pid="${productId}"]`).forEach(btn=>{
    btn.textContent = isFavorite(productId) ? '❤️' : '🤍';
  });
  if(document.getElementById('page-favorites').classList.contains('active')) renderFavoritesPage();
}
function renderFavoritesPage(){
  const grid = document.getElementById('favoritesGrid');
  document.getElementById('favCountLabel').textContent = `${FAVORITES.length} منتج`;
  const favProducts = DATA.products.filter(p=>FAVORITES.includes(p.id));
  if(favProducts.length===0){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="icon">🤍</div>لسه مفيش منتجات في المفضلة</div>`;
    return;
  }
  renderProductGrid('favoritesGrid', favProducts, `${favProducts.length} منتج`);
}

function loadCart(){
  try{ CART = JSON.parse(localStorage.getItem('gm_cart') || '[]'); }
  catch(e){ CART = []; }
}
function saveCart(){
  localStorage.setItem('gm_cart', JSON.stringify(CART));
  updateCartCount();
}
function updateCartCount(){
  const count = CART.reduce((s,i)=>s+i.qty,0);
  const el = document.getElementById('cartCount');
  if(count>0){ el.style.display='flex'; el.textContent = count; } else{ el.style.display='none'; }
}
function showToast(msg){
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2500);
}

// ============== التنقل بين الصفحات ==============
window.goTo = function(page){
  document.querySelectorAll('section').forEach(s=>s.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.querySelectorAll('.nav-btn[data-page]').forEach(b=>b.classList.remove('active'));
  const navBtn = document.querySelector('.nav-btn[data-page="'+page+'"]');
  if(navBtn) navBtn.classList.add('active');
  window.scrollTo({top:0, behavior:'smooth'});
  if(page==='cart') renderCart();
  if(page==='favorites') renderFavoritesPage();
  if(page==='seller') loadSellerDashboard();
  if(page==='admin') loadAdminDashboard();
}
document.querySelectorAll('.nav-btn[data-page]').forEach(btn=>{
  btn.addEventListener('click', ()=>goTo(btn.dataset.page));
});

// ============== الصفحة الرئيسية / البراندات ==============
function renderCategoryStalls(){
  const wrap = document.getElementById('categoryStalls');
  if(!CATEGORIES.length){
    wrap.innerHTML = `<p class="hint" style="margin:0;">لسه مفيش أقسام متضافة، هتظهر هنا أول ما الأدمن يضيفها♡</p>`;
    return;
  }
  wrap.innerHTML = CATEGORIES.map(c=>`
    <div class="stall" data-cat="${c.id}" onclick="filterByCategory('${c.id}')">
      <span class="icon">${c.icon}</span>
      <span class="label">${c.label}</span>
    </div>`).join('');
}
window.filterByCategory = function(catId){
  goTo('home');
  const filtered = DATA.products.filter(p=>p.category===catId);
  renderProductGrid('featuredGrid', filtered, `منتجات: ${catLabel(catId)}`);

  // نلوّن القسم اللي اتضغط عليه عشان يبان واضح إنه اتفتح فعلاً
  document.querySelectorAll('#categoryStalls .stall').forEach(el=>{
    el.classList.toggle('active', el.dataset.cat===catId);
  });
  // نظبط خانة الفلترة بنفس القسم عشان تبقى متزامنة
  const filterSelect = document.getElementById('filterCategory');
  if(filterSelect) filterSelect.value = catId;

  // القسم مبيتفتحش في صفحة منفصلة، هو بيفلتر نفس صفحة المنتجات المميزة اللي تحت،
  // فلو المستخدمة كانت فوق خالص هتحس إن حاجة معملتش، فبنلف بيها لنتيجة الفلترة فورًا
  const target = document.getElementById('productCountLabel');
  if(target) target.scrollIntoView({behavior:'smooth', block:'start'});
}
function renderProductGrid(elId, products, label){
  const grid = document.getElementById(elId);
  document.getElementById('productCountLabel').textContent = label ? label : `${DATA.products.length} منتج`;
  if(products.length===0){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="icon">🔍</div>مفيش منتجات في القسم ده لسه المنتجات بتنضاف♡</div>`;
    return;
  }
  grid.innerHTML = products.map(p=>{
    const vendor = DATA.vendors.find(v=>v.id===p.brandId);
    return `
    <div class="card">
      <div class="card-media" onclick="openProductDetails('${p.id}')">${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}">` : (p.emoji||'📦')}</div>
      <button class="fav-heart" data-pid="${p.id}" onclick="toggleFavorite('${p.id}', event)">${isFavorite(p.id) ? '❤️' : '🤍'}</button>
      <div class="card-body">
        <div class="card-vendor" onclick="openVendor('${p.brandId}')">${vendor? vendor.name : ''}</div>
        <div class="card-title" onclick="openProductDetails('${p.id}')">${p.name}</div>
        <div class="card-desc">${p.desc||''}</div>
        <div class="card-footer">
          <span class="price">${p.price} ج.م</span>
          <button class="add-btn" onclick="addToCart('${p.id}')">♡أضيفي للسلة</button>
        </div>
      </div>
    </div>`;
  }).join('');
}
function renderVendorsGrid(){
  const grid = document.getElementById('vendorsGrid');
  document.getElementById('vendorCountLabel').textContent = `${DATA.vendors.length} براند`;
  if(DATA.vendors.length===0){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="icon">🌸</div>♡البراندات لسه بتتعمل يحلوة</div>`;
    return;
  }
  grid.innerHTML = DATA.vendors.map(v=>{
    const count = DATA.products.filter(p=>p.brandId===v.id).length;
    return `
    <div class="vendor-card" onclick="openVendor('${v.id}')">
      <div class="vendor-top">
        <div class="vendor-avatar">${v.logoUrl ? `<img src="${v.logoUrl}" alt="${v.name}">` : (v.emoji||'🌸')}</div>
        <div>
          <div class="vendor-name">${v.name}</div>
          ${v.ownerName ? `<div class="vendor-owner">بإدارة ${v.ownerName}</div>` : ''}
          <div class="vendor-cat">${catLabel(v.category)}</div>
        </div>
      </div>
      <div class="vendor-desc">${v.description||''}</div>
      <div class="vendor-count">${count} منتج معروض</div>
    </div>`;
  }).join('');
}
window.openVendor = function(vendorId){
  const v = DATA.vendors.find(v=>v.id===vendorId);
  if(!v) return;
  document.getElementById('vendorDetailHead').innerHTML = `
    <div class="vendor-top" style="margin-bottom:8px;">
      <div class="vendor-avatar" style="width:60px;height:60px;font-size:26px;">${v.logoUrl ? `<img src="${v.logoUrl}" alt="${v.name}">` : (v.emoji||'🌸')}</div>
      <div>
        <div class="vendor-name" style="font-size:22px;">${v.name}</div>
        ${v.ownerName ? `<div class="vendor-owner">بإدارة ${v.ownerName}</div>` : ''}
        <div class="vendor-cat">${catLabel(v.category)}</div>
      </div>
    </div>
    <p class="vendor-desc" style="max-width:600px;">${v.description||''}</p>
  `;
  const products = DATA.products.filter(p=>p.brandId===vendorId);
  const grid = document.getElementById('vendorDetailGrid');
  if(products.length===0){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="icon">📦</div>♡البراند ده لسه بيضيف المنتجات</div>`;
  } else {
    grid.innerHTML = products.map(p=>{
      const stats = getReviewStats(p.id);
      const reviews = (DATA.reviews[p.id]||[]).slice(-3).reverse();
      return `
      <div class="card">
        <div class="card-media" onclick="openProductDetails('${p.id}')">${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}">` : (p.emoji||'📦')}</div>
        <button class="fav-heart" data-pid="${p.id}" onclick="toggleFavorite('${p.id}', event)">${isFavorite(p.id) ? '❤️' : '🤍'}</button>
        <div class="card-body">
          <div class="card-title" onclick="openProductDetails('${p.id}')">${p.name}</div>
          <div class="card-desc">${p.desc||''}</div>
          ${stats.count>0 ? `<div class="stars">${renderStars(stats.avg)} (${stats.count})</div>` : `<div class="stars" style="color:var(--plum-soft);">لسه من غير تقييم</div>`}
          <button class="review-toggle" onclick="toggleReviewForm('${p.id}')">⭐ قيّمي المنتج ده</button>
          <div class="review-form" id="reviewForm-${p.id}">
            <input id="revName-${p.id}" type="text" placeholder="اسمك">
            <select id="revStars-${p.id}">
              <option value="5">★★★★★ ممتاز</option>
              <option value="4">★★★★ كويس أوي</option>
              <option value="3">★★★ عادي</option>
              <option value="2">★★ مش عاجبني</option>
              <option value="1">★ سيء</option>
            </select>
            <textarea id="revComment-${p.id}" placeholder="رأيك في المنتج (اختياري)" rows="2"></textarea>
            <button onclick="submitReview('${p.id}')">إرسال التقييم</button>
            ${reviews.map(r=>`<div class="review-item">${'★'.repeat(r.rating)} — <b>${r.customerName||'عميلة'}</b>${r.comment ? `: ${r.comment}` : ''}</div>`).join('')}
          </div>
          <div class="card-footer">
            <span class="price">${p.price} ج.م</span>
            <button class="add-btn" onclick="addToCart('${p.id}')">♡أضيفي للسلة</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }
  goTo('vendor-detail');
}
// بتوحّد أشكال الحروف العربية المتشابهة (همزات، تاء مربوطة، ألف مقصورة، تشكيل)
// عشان البحث يشتغل حتى لو المستخدمة كتبت الكلمة بشكل مختلف شوية عن المخزّن
function normalizeArabic(str){
  return (str||'')
    .toString()
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, '')      // شيل التشكيل
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .trim();
}

window.handleSearch = function(){
  const raw = document.getElementById('searchInput').value.trim();
  const q = normalizeArabic(raw);
  document.getElementById('filterCategory').value = '';
  document.getElementById('filterSort').value = '';
  if(!q){ renderProductGrid('featuredGrid', DATA.products); return; }
  const vendorMatches = DATA.vendors.filter(v=>normalizeArabic(v.name).includes(q)).map(v=>v.id);
  const catMatches = CATEGORIES.filter(c=>normalizeArabic(c.label).includes(q)).map(c=>c.id);
  const combined = DATA.products.filter(p=>
    normalizeArabic(p.name).includes(q) ||
    normalizeArabic(p.desc).includes(q) ||
    vendorMatches.includes(p.brandId) ||
    catMatches.includes(p.category)
  );
  renderProductGrid('featuredGrid', combined, `نتائج البحث عن "${raw}"`);
}
document.getElementById('searchInput').addEventListener('keydown', e=>{ if(e.key==='Enter') handleSearch(); });

function populateCategorySelects(){
  const opts = CATEGORIES.map(c=>`<option value="${c.id}">${c.label}</option>`).join('');
  document.getElementById('joinCategory').innerHTML = opts;
  document.getElementById('pCategory').innerHTML = opts;
  document.getElementById('filterCategory').innerHTML = `<option value="">كل الأقسام</option>` + opts;
  const nbBox = document.getElementById('nbCategoriesBox');
  if(nbBox){
    nbBox.innerHTML = CATEGORIES.length ? CATEGORIES.map(c=>`
      <label style="display:flex; align-items:center; gap:8px; font-size:14px; margin-bottom:8px; font-weight:400;">
        <input type="checkbox" value="${c.id}" class="nb-cat-check" style="width:auto;"> ${c.label}
      </label>`).join('') : `<p class="hint" style="margin:0;">لسه مفيش أي قسم متضاف. ضيفي قسم واحد على الأقل من فوق ⬆️ الأول.</p>`;
  }
  const ownBox = document.getElementById('ownBrandCategoriesBox');
  if(ownBox){
    ownBox.innerHTML = CATEGORIES.length ? CATEGORIES.map(c=>`
      <label style="display:flex; align-items:center; gap:8px; font-size:14px; margin-bottom:8px; font-weight:400;">
        <input type="checkbox" value="${c.id}" class="own-cat-check" style="width:auto;"> ${c.label}
      </label>`).join('') : `<p class="hint" style="margin:0;">لسه مفيش أي قسم متضاف. ضيفي قسم واحد على الأقل من فوق ⬆️ الأول.</p>`;
  }
}
window.applyFilters = function(){
  const cat = document.getElementById('filterCategory').value;
  const sort = document.getElementById('filterSort').value;
  let list = cat ? DATA.products.filter(p=>p.category===cat) : [...DATA.products];
  if(sort==='asc') list.sort((a,b)=>a.price-b.price);
  if(sort==='desc') list.sort((a,b)=>b.price-a.price);
  renderProductGrid('featuredGrid', list, cat ? catLabel(cat) : `${list.length} منتج`);
}

// ============== السلة ==============
window.addToCart = function(productId){
  const existing = CART.find(i=>i.productId===productId);
  if(existing){ existing.qty += 1; } else{ CART.push({productId, qty:1}); }
  saveCart();
  showToast('اتضاف للسلة ✓');
}
window.changeQty = function(productId, delta){
  const item = CART.find(i=>i.productId===productId);
  if(!item) return;
  item.qty += delta;
  if(item.qty<=0){ CART = CART.filter(i=>i.productId!==productId); }
  saveCart(); renderCart();
}
window.removeFromCart = function(productId){
  CART = CART.filter(i=>i.productId!==productId);
  saveCart(); renderCart();
}
function renderCart(){
  appliedCoupons = {};
  const wrap = document.getElementById('cartContent');
  if(CART.length===0){
    wrap.innerHTML = `<div class="empty-state"><div class="icon">🧺</div>♡السلة فاضية، روحي شوفي المنتجات</div>`;
    return;
  }
  // تجميع المنتجات حسب كل براند عشان نعرض رقم فودافون كاش والمقدم الخاص بكل براند لوحده
  const byBrand = {};
  let grandTotal = 0;
  CART.forEach(item=>{
    const p = DATA.products.find(p=>p.id===item.productId);
    if(!p) return;
    if(!byBrand[p.brandId]) byBrand[p.brandId] = [];
    byBrand[p.brandId].push({product:p, qty:item.qty});
    grandTotal += p.price * item.qty;
  });

  const rows = CART.map(item=>{
    const p = DATA.products.find(p=>p.id===item.productId);
    if(!p) return '';
    const vendor = DATA.vendors.find(v=>v.id===p.brandId);
    return `
    <div class="cart-row">
      <div class="media">${p.emoji||'📦'}</div>
      <div class="info">
        <div class="name">${p.name}</div>
        <div class="vendor">${vendor?vendor.name:''} · ${p.price} ج.م</div>
      </div>
      <div class="qty-ctl">
        <button onclick="changeQty('${item.productId}', -1)">−</button>
        <span>${item.qty}</span>
        <button onclick="changeQty('${item.productId}', 1)">+</button>
      </div>
      <span class="remove-link" onclick="removeFromCart('${item.productId}')">إزالة</span>
    </div>`;
  }).join('');

  // خانة تحويل + رقم فودافون كاش لكل براند لوحده
  const brandPaySections = Object.keys(byBrand).map(brandId=>{
    const brand = DATA.vendors.find(v=>v.id===brandId);
    const brandTotal = byBrand[brandId].reduce((s,i)=>s+i.product.price*i.qty, 0);
    const brandHalf = (brandTotal/2).toFixed(2);
    const vodafoneNum = brand ? (brand.vodafoneNumber || brand.managerPhone) : '';
    return `
      <div class="form-wrap" style="margin:14px 0 0; padding:14px;">
        <h3 style="font-size:15px; margin-bottom:8px;">💳 الدفع لبراند "${brand?brand.name:''}"</h3>
        <div style="font-size:13px; color:var(--plum-soft); margin-bottom:8px;" id="brandSummary-${brandId}" data-total="${brandTotal}">
          إجمالي منتجات البراند ده: ${brandTotal} ج.م — المقدم المطلوب أونلاين: <b>${brandHalf} ج.م</b>
        </div>
        <div class="field">
          <label>عندك كود خصم من البراند ده؟ (اختياري)</label>
          <div style="display:flex; gap:8px;">
            <input class="co-coupon-input" id="couponInput-${brandId}" type="text" placeholder="اكتبي الكود هنا" style="flex:1;">
            <button type="button" class="small-btn" onclick="applyCartCoupon('${brandId}')">تطبيق</button>
          </div>
          <div id="couponResult-${brandId}" style="font-size:13px; margin-top:6px;"></div>
        </div>
        ${vodafoneNum
          ? `<div style="font-size:14px; margin-bottom:10px;">حوّلي المقدم على رقم فودافون كاش: <b style="direction:ltr; display:inline-block;">${vodafoneNum}</b></div>`
          : `<div style="font-size:13px; color:#a24545; margin-bottom:10px;">⚠️ البراند ده لسه معملش رقم فودافون كاش، اتواصلي معاها الأول.</div>`}
        <div class="field"><label>رقم عملية فودافون كاش (بعد التحويل)</label><input class="co-ref-input" data-brand="${brandId}" type="text" placeholder="مثال: 123456789"></div>
      </div>`;
  }).join('');

  const half = (grandTotal/2).toFixed(2);
  wrap.innerHTML = `
    <div class="cart-list">${rows}</div>
    <div class="cart-summary">
      <div>الإجمالي: <span class="total">${grandTotal} ج.م</span></div>
      <div style="margin-top:6px; font-size:13px; color:var(--plum-soft);">هتدفعي مقدم ${half} ج.م أونلاين (موزّع حسب كل براند تحت)، والباقي عند الاستلام.</div>

      <div class="field" style="margin-top:18px;"><label>اسمك</label><input id="coName" type="text"></div>
      <div class="field"><label>رقم موبايلك</label><input id="coPhone" type="tel" placeholder="01♡♡♡♡♡♡♡♡♡"></div>
      <div class="field"><label>عنوانك بالتفصيل</label><textarea id="coAddress"></textarea></div>

      ${brandPaySections}

      <button class="checkout-btn" style="margin-top:16px;" onclick="checkout()">♡تأكيد الطلب</button>
    </div>`;
}
window.applyCartCoupon = function(brandId){
  const input = document.getElementById('couponInput-'+brandId);
  const resultBox = document.getElementById('couponResult-'+brandId);
  const summaryBox = document.getElementById('brandSummary-'+brandId);
  const code = input.value.trim().toUpperCase();
  const brandTotal = parseFloat(summaryBox.dataset.total);

  if(!code){ resultBox.innerHTML = `<span style="color:#a24545;">اكتبي الكود الأول</span>`; return; }

  const coupon = DATA.coupons.find(c=>c.brandId===brandId && (c.code||'').toUpperCase()===code);
  if(!coupon){
    resultBox.innerHTML = `<span style="color:#a24545;">الكود ده مش موجود أو غلط</span>`;
    delete appliedCoupons[brandId];
    summaryBox.innerHTML = `إجمالي منتجات البراند ده: ${brandTotal} ج.م — المقدم المطلوب أونلاين: <b>${(brandTotal/2).toFixed(2)} ج.م</b>`;
    return;
  }

  let discountAmount = coupon.discountType==='percent'
    ? brandTotal * (coupon.discountValue/100)
    : Math.min(coupon.discountValue, brandTotal);
  discountAmount = +discountAmount.toFixed(2);
  const finalTotal = +(brandTotal - discountAmount).toFixed(2);
  const finalHalf = (finalTotal/2).toFixed(2);

  appliedCoupons[brandId] = { code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue, discountAmount, finalTotal };

  resultBox.innerHTML = `<span style="color:#3a7d44;">تم تطبيق الكود ✅ خصم ${discountAmount} ج.م</span>`;
  summaryBox.innerHTML = `الإجمالي بعد الخصم: <b>${finalTotal} ج.م</b> (كان ${brandTotal} ج.م) — المقدم المطلوب أونلاين: <b>${finalHalf} ج.م</b>`;
}
window.checkout = async function(){
  const customerName = document.getElementById('coName').value.trim();
  const customerPhone = document.getElementById('coPhone').value.trim();
  const address = document.getElementById('coAddress').value.trim();

  if(!customerName || !customerPhone || !address){
    showToast('من فضلك املي بياناتك كاملة'); return;
  }

  // بنجمع رقم عملية فودافون كاش الخاص بكل براند من خانته
  const refInputs = document.querySelectorAll('.co-ref-input');
  const refsByBrand = {};
  for(const input of refInputs){
    const val = input.value.trim();
    if(!val){ showToast('من فضلك اكتبي رقم عملية فودافون كاش لكل براند طلبتي منه'); return; }
    refsByBrand[input.dataset.brand] = val;
  }

  // تقسيم السلة حسب كل براند - كل براند طلبه لوحده
  const byBrand = {};
  CART.forEach(item=>{
    const p = DATA.products.find(p=>p.id===item.productId);
    if(!p) return;
    if(!byBrand[p.brandId]) byBrand[p.brandId] = [];
    byBrand[p.brandId].push({productId:p.id, name:p.name, price:p.price, quantity:item.qty});
  });

  try{
    const waButtons = [];
    for(const brandId in byBrand){
      const items = byBrand[brandId];
      const totalAmount = items.reduce((s,i)=>s+i.price*i.quantity, 0);
      const coupon = appliedCoupons[brandId];
      const discountAmount = coupon ? coupon.discountAmount : 0;
      const finalAmount = +(totalAmount - discountAmount).toFixed(2);
      const paidAmount = +(finalAmount/2).toFixed(2);
      const remainingAmount = +(finalAmount-paidAmount).toFixed(2);
      const vodafoneTransactionRef = refsByBrand[brandId];

      await addDoc(collection(db, "orders"), {
        brandId, customerName, customerPhone, address,
        totalAmount: finalAmount, paidAmount, remainingAmount,
        couponCode: coupon ? coupon.code : null,
        discountAmount,
        vodafoneTransactionRef,
        paymentStatus: "paid_half_pending_confirm",
        fulfillmentStatus: "pending",
        items,
        createdAt: serverTimestamp()
      });

      const brand = DATA.vendors.find(v=>v.id===brandId);
      if(brand && brand.managerPhone){
        const itemsText = items.map(i=>`- ${i.name} × ${i.quantity} = ${i.price*i.quantity} ج.م`).join('\n');
        const discountLine = discountAmount>0 ? `\nكود الخصم: ${coupon.code} (خصم ${discountAmount} ج.م)` : '';
        const msg = `طلب جديد ❤️\nالاسم: ${customerName}\nالموبايل: ${customerPhone}\nالعنوان: ${address}\n\n${itemsText}${discountLine}\n\nالإجمالي بعد الخصم: ${finalAmount} ج.م\nمدفوع مقدماً: ${paidAmount} ج.م (رقم عملية فودافون كاش: ${vodafoneTransactionRef})\nالباقي عند الاستلام: ${remainingAmount} ج.م`;
        waButtons.push({
          brandName: brand.name,
          link: `https://wa.me/${normalizeEgyptPhone(brand.managerPhone)}?text=${encodeURIComponent(msg)}`
        });
      }
    }
    CART = []; appliedCoupons = {}; saveCart();

    if(waButtons.length > 0){
      document.getElementById('cartContent').innerHTML = `
        <div class="empty-state" style="margin-bottom:14px;"><div class="icon">✅</div>تم إرسال طلبك بنجاح ❤️</div>
        <p class="hint" style="padding:0 4px;">دوسي تحت لتأكيدي طلبك على واتساب مع كل براند:</p>
        ${waButtons.map(b=>`<a class="submit-btn" style="display:block; text-align:center; text-decoration:none; margin-bottom:10px;" href="${b.link}" target="_blank" rel="noopener">إرسال طلب "${b.brandName}" على واتساب</a>`).join('')}
        <button class="submit-btn" style="background:var(--berry);" onclick="goTo('home')">رجوع للرئيسية</button>
      `;
    }else{
      showToast('تم إرسال طلبك بنجاح ❤️');
      goTo('home');
    }
  }catch(e){
    showToast('حصل خطأ: ' + e.message);
  }
}

// ============== طلب الانضمام كبائعة ==============
window.submitJoinRequest = async function(){
  const applicantName = document.getElementById('joinName').value.trim();
  const phone = document.getElementById('joinPhone').value.trim();
  const proposedBrand = document.getElementById('joinBrand').value.trim();
  const category = document.getElementById('joinCategory').value;
  const description = document.getElementById('joinDesc').value.trim();

  if(!applicantName || !phone || !proposedBrand){
    showToast('من فضلك املي كل البيانات المطلوبة'); return;
  }
  try{
    await addDoc(collection(db, "joinRequests"), {
      applicantName, phone, proposedBrand, category, description,
      status: "pending", createdAt: serverTimestamp()
    });
    showToast('تم إرسال طلبك، هنتواصل معاكِ قريباً ❤️');
    document.getElementById('joinName').value='';
    document.getElementById('joinPhone').value='';
    document.getElementById('joinBrand').value='';
    document.getElementById('joinDesc').value='';
    goTo('home');
  }catch(e){
    showToast('حصل خطأ: ' + e.message);
  }
}

// ============== تسجيل الدخول ==============
window.togglePasswordView = function(inputId){
  inputId = inputId || 'loginPassword'; // لو الاسم مجاش، افتراضيًا خانة تسجيل الدخول
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
}
window.doForgotPassword = async function(){
  const email = document.getElementById('loginEmail').value.trim();
  if(!email){ showToast('اكتبي إيميلك الأول في الخانة فوق'); return; }
  try{
    await sendPasswordResetEmail(auth, email);
    showToast('اتبعت رسالة لإيميلك فيها رابط تغيير كلمة السر ✓');
  }catch(e){
    showToast('حصل خطأ: ' + e.message);
  }
}
let loginInFlight = false;
window.doLogin = async function(){
  if(loginInFlight) return; // تمنع الضغط أكتر من مرة أثناء ما الطلب لسه شغال
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if(!email || !password){ showToast('من فضلك اكتبي الإيميل وكلمة المرور'); return; }

  const btn = document.querySelector('#page-login .submit-btn');
  const originalLabel = btn ? btn.textContent : '';
  loginInFlight = true;
  if(btn){ btn.disabled = true; btn.textContent = '...بنسجل دخولك'; }

  try{
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged هيتكفل بالباقي
  }catch(e){
    // رسالة مختلفة حسب نوع الخطأ الحقيقي بدل ما نقول "بيانات غلط" دايمًا
    const code = e && e.code;
    if(code==='auth/invalid-email'){ showToast('صيغة الإيميل مش صح'); }
    else if(code==='auth/user-not-found' || code==='auth/wrong-password' || code==='auth/invalid-credential'){ showToast('الإيميل أو كلمة المرور غلط'); }
    else if(code==='auth/too-many-requests'){ showToast('محاولات كتير غلط، استنِّي شوية وحاولي تاني'); }
    else if(code==='auth/network-request-failed'){ showToast('في مشكلة في الاتصال بالإنترنت، جرّبي تاني'); }
    else{ showToast('حصل خطأ غير متوقع: ' + (e && e.message ? e.message : 'حاولي تاني')); }
  }finally{
    loginInFlight = false;
    if(btn){ btn.disabled = false; btn.textContent = originalLabel || '♡دخول♡'; }
  }
}
document.getElementById('navLogout').addEventListener('click', async ()=>{
  await signOut(auth);
  showToast('تم تسجيل الخروج');
  goTo('home');
});
document.getElementById('navDashboard').addEventListener('click', ()=>{
  if(currentUser?.role==='admin') goTo('admin');
  else if(currentUser?.role==='brand_manager') goTo('seller');
});
document.getElementById('navMyBrand').addEventListener('click', ()=>{
  if(currentUser?.brandId) goTo('seller');
});

onAuthStateChanged(auth, async (user)=>{
  const navLogin = document.getElementById('navLogin');
  const navDash = document.getElementById('navDashboard');
  const navLogout = document.getElementById('navLogout');
  const navChecking = document.getElementById('navChecking');
  if(navChecking) navChecking.style.display='none';

  if(!user){
    currentUser = null;
    navLogin.style.display='inline-block';
    navDash.style.display='none';
    navLogout.style.display='none';
    return;
  }

  const userSnap = await getDoc(doc(db, "users", user.uid));
  if(!userSnap.exists()){
    showToast('الحساب ده مش متسجل صح، كلمي أمولة: 01093291983 ');
    await signOut(auth);
    return;
  }
  const userData = userSnap.data();
  currentUser = { uid:user.uid, role:userData.role, brandId:userData.brandId||null, name:userData.name };

  navLogin.style.display='none';
  navDash.style.display='inline-block';
  navLogout.style.display='inline-block';
  document.getElementById('navDashLabel').textContent = currentUser.role==='admin' ? 'لوحة الأدمن' : 'لوحتي';

  const navMyBrand = document.getElementById('navMyBrand');
  if(navMyBrand) navMyBrand.style.display = (currentUser.role==='admin' && currentUser.brandId) ? 'inline-block' : 'none';

  if(currentUser.role==='admin') goTo('admin');
  else{ goTo('seller'); }
  checkNewOrdersBadge();
});

async function checkNewOrdersBadge(){
  if(!currentUser || !currentUser.brandId) return;
  const lastSeen = parseInt(localStorage.getItem('lastSeenOrders_'+currentUser.brandId) || '0');
  const ordersSnap = await getDocs(query(collection(db,"orders"), where("brandId","==",currentUser.brandId)));
  const newCount = ordersSnap.docs.filter(d=>{
    const t = d.data().createdAt;
    return t && t.toMillis && t.toMillis() > lastSeen;
  }).length;
  const badge = document.getElementById('notifBadge');
  if(newCount>0){ badge.style.display='inline-block'; badge.textContent = newCount; }
  else{ badge.style.display='none'; }
}

// ============== لوحة المديرة ==============
async function loadSellerDashboard(){
  if(!currentUser || !currentUser.brandId) return;
  const brandSnap = await getDoc(doc(db, "brands", currentUser.brandId));
  const brand = brandSnap.exists() ? brandSnap.data() : null;
  document.getElementById('sellerBrandName').textContent = brand ? brand.name : '';
  document.getElementById('sellerBrandNameInput').value = (brand && brand.name) || '';

  const coverPreview = document.getElementById('brandCoverPreview');
  coverPreview.innerHTML = brand && brand.logoUrl
    ? `<img src="${brand.logoUrl}" style="width:100%; height:100%; object-fit:cover;">`
    : (brand && brand.emoji ? brand.emoji : '🌸');

  document.getElementById('sellerWhatsapp').value = (brand && brand.managerPhone) || '';
  document.getElementById('sellerVodafone').value = (brand && brand.vodafoneNumber) || '';

  await renderSellerCoupons();

  // خانة القسم في نموذج إضافة المنتج تتقفل على أقسام البراند بتاعها بس
  // (يدعم قسم واحد أو أكتر لو البراند بيبيع في أكتر من قسم)
  const catSelect = document.getElementById('pCategory');
  if(brand){
    const allowedCats = Array.isArray(brand.categories) && brand.categories.length>0
      ? brand.categories
      : (brand.category ? [brand.category] : null);
    if(allowedCats){
      catSelect.innerHTML = allowedCats.map(catId=>{
        const catInfo = CATEGORIES.find(c=>c.id===catId);
        return `<option value="${catId}">${catInfo ? catInfo.label : catId}</option>`;
      }).join('');
      catSelect.disabled = allowedCats.length===1;
    }
  }

  const productsSnap = await getDocs(query(collection(db,"products"), where("brandId","==",currentUser.brandId)));
  const myProducts = productsSnap.docs.map(d=>({id:d.id, ...d.data()}));
  const grid = document.getElementById('sellerProductsGrid');
  grid.innerHTML = myProducts.length===0
    ? `<div class="empty-state"><div class="icon">📦</div>لسه معملتيش منتجات</div>`
    : myProducts.map(p=>`
      <div class="card">
        <div class="card-media">${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}">` : (p.emoji||'📦')}</div>
        <div class="card-body">
          <div class="card-title">${p.name}</div>
          <div class="card-desc">${p.desc||''}</div>
          <div class="card-footer">
            <span class="price">${p.price} ج.م</span>
            <div style="display:flex; gap:6px;">
              <button class="add-btn" onclick='sellerEditProduct(${JSON.stringify(p).replace(/'/g,"&#39;")})'>تعديل</button>
              <button class="del-btn" onclick="sellerDeleteProduct('${p.id}', '${(p.name||'').replace(/'/g,"")}')">حذف</button>
            </div>
          </div>
        </div>
      </div>`).join('');

  const ordersSnap = await getDocs(query(collection(db,"orders"), where("brandId","==",currentUser.brandId), orderBy("createdAt","desc")));
  const myOrders = ordersSnap.docs.map(d=>({id:d.id, ...d.data()}));
  const statusLabels = {pending:'قيد المراجعة', confirmed:'تم التأكيد', shipped:'جاري الشحن', delivered:'تم التسليم'};
  const ordersWrap = document.getElementById('sellerOrders');
  ordersWrap.innerHTML = myOrders.length===0
    ? `<div class="empty-state"><div class="icon">🧾</div>لسه مفيش طلبات</div>`
    : myOrders.map(o=>{
      const fs = o.fulfillmentStatus || 'pending';
      return `
      <div class="order-card">
        <div class="row"><span>${o.customerName} — ${o.customerPhone}</span><span>${o.totalAmount} ج.م</span></div>
        <div class="row"><span>${o.address}</span></div>
        <div class="row"><span>رقم عملية فودافون: ${o.vodafoneTransactionRef}</span></div>
        <div class="row">
          <span class="badge ${o.paymentStatus==='confirmed'?'ok':'pending'}">${o.paymentStatus==='confirmed'?'الدفع متأكد':'مستني تأكيد الدفع'}</span>
          <span class="badge ${fs==='delivered'?'ok':'pending'}">${statusLabels[fs] || 'قيد المراجعة'}</span>
        </div>
        ${o.paymentStatus!=='confirmed' ? `<button class="small-btn" onclick="sellerConfirmPayment('${o.id}')">تأكيد استلام الدفعة</button>`:''}
        ${fs==='pending' ? `<button class="small-btn" onclick="sellerUpdateStatus('${o.id}','confirmed')">تأكيد الطلب</button>`:''}
        ${fs==='confirmed' ? `<button class="small-btn" onclick="sellerUpdateStatus('${o.id}','shipped')">بدء الشحن</button>`:''}
        ${fs==='shipped' ? `<button class="small-btn" onclick="sellerUpdateStatus('${o.id}','delivered')">تم التسليم</button>`:''}
      </div>`;
    }).join('');

  localStorage.setItem('lastSeenOrders_'+currentUser.brandId, Date.now().toString());
  const badge = document.getElementById('notifBadge');
  if(badge) badge.style.display='none';
}
const IMGBB_API_KEY = "efb5f77053c39e1114779bf101efbfe1";

async function uploadToImgbb(file){
  const formData = new FormData();
  formData.append("image", file);

  const controller = new AbortController();
  const timeoutId = setTimeout(()=>controller.abort(), 15000); // 15 ثانية كحد أقصى

  let res;
  try{
    res = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
      method: "POST",
      body: formData,
      signal: controller.signal
    });
  }catch(networkErr){
    if(networkErr.name === 'AbortError'){
      throw new Error("الرفع أخد وقت طويل أوي ووقف تلقائي (مشكلة في سرعة النت). جربي صورة أصغر أو نت أحسن.");
    }
    throw new Error("مفيش اتصال بالإنترنت أو في مشكلة في الاتصال بخدمة الصور");
  }finally{
    clearTimeout(timeoutId);
  }

  const data = await res.json();
  console.log("imgbb response:", data);
  if(!data.success){
    throw new Error(data?.error?.message || "فشل رفع الصورة (رد غير متوقع من imgbb)");
  }
  return data.data.url;
}

let editingProductId = null;

window.sellerEditProduct = function(product){
  editingProductId = product.id;
  document.getElementById('pName').value = product.name || '';
  document.getElementById('pPrice').value = product.price || '';
  document.getElementById('pCategory').value = product.category || '';
  document.getElementById('pDesc').value = product.desc || '';
  document.getElementById('pEmoji').value = product.emoji || '📦';
  document.getElementById('productFormTitle').textContent = 'تعديل المنتج';
  document.getElementById('productFormSubmitBtn').textContent = 'حفظ التعديل';
  document.getElementById('cancelEditBtn').style.display = 'block';
  document.getElementById('productFormWrap').scrollIntoView({behavior:'smooth'});
}
window.sellerCancelEdit = function(){
  editingProductId = null;
  document.getElementById('pName').value=''; document.getElementById('pPrice').value='';
  document.getElementById('pDesc').value=''; document.getElementById('pImageFile').value='';
  document.getElementById('productFormTitle').textContent = 'ضيفي منتج جديد';
  document.getElementById('productFormSubmitBtn').textContent = 'إضافة المنتج';
  document.getElementById('cancelEditBtn').style.display = 'none';
}

window.sellerUpdateBrandName = async function(){
  if(!currentUser || !currentUser.brandId){ showToast('مفيش براند مرتبط بحسابك'); return; }
  const name = document.getElementById('sellerBrandNameInput').value.trim();
  if(!name){ alert('اكتبي اسم البراند الأول'); return; }
  try{
    await updateDoc(doc(db,"brands",currentUser.brandId), { name });
    await logActivity("غيّرت اسم البراند بتاعها", '');
    showToast('اتحفظ اسم البراند الجديد ❤️');
    await loadData();
    loadSellerDashboard();
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

// ============== أكواد الخصم بتاعة كل مديرة ==============
async function renderSellerCoupons(){
  if(!currentUser || !currentUser.brandId) return;
  const wrap = document.getElementById('sellerCouponsList');
  const snap = await getDocs(query(collection(db,"coupons"), where("brandId","==",currentUser.brandId)));
  const coupons = snap.docs.map(d=>({id:d.id, ...d.data()}));
  wrap.innerHTML = coupons.length===0
    ? `<div class="empty-state" style="padding:14px;"><div class="icon">🎟️</div>لسه معملتيش أي كود خصم</div>`
    : coupons.map(c=>`
      <div class="log-item" style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <span><b style="direction:ltr; display:inline-block;">${c.code}</b> — ${c.discountType==='percent' ? `خصم ${c.discountValue}%` : `خصم ${c.discountValue} ج.م`}</span>
        <button class="small-btn" style="background:#a24545;" onclick="sellerDeleteCoupon('${c.id}')">حذف</button>
      </div>`).join('');
}
window.sellerAddCoupon = async function(){
  if(!currentUser || !currentUser.brandId){ showToast('مفيش براند مرتبط بحسابك'); return; }
  const code = document.getElementById('couponCode').value.trim().toUpperCase();
  const discountType = document.getElementById('couponType').value;
  const discountValue = parseFloat(document.getElementById('couponValue').value);

  if(!code){ alert('اكتبي الكود الأول'); return; }
  if(!discountValue || discountValue<=0){ alert('اكتبي قيمة خصم صحيحة'); return; }
  if(discountType==='percent' && discountValue>100){ alert('نسبة الخصم متقدرش تتعدى 100%'); return; }

  try{
    await addDoc(collection(db,"coupons"), {
      brandId: currentUser.brandId, code, discountType, discountValue, active: true, createdAt: serverTimestamp()
    });
    await logActivity("أضافت كود خصم جديد: " + code, '');
    showToast('اتضاف الكود بنجاح ❤️');
    document.getElementById('couponCode').value='';
    document.getElementById('couponValue').value='';
    await loadData();
    renderSellerCoupons();
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}
window.sellerDeleteCoupon = async function(couponId){
  if(!confirm('متأكدة إنك عايزة تمسحي الكود ده؟')) return;
  try{
    await deleteDoc(doc(db,"coupons",couponId));
    showToast('اتمسح الكود');
    await loadData();
    renderSellerCoupons();
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

window.sellerUpdateBrandCover = async function(){
  if(!currentUser || !currentUser.brandId){ showToast('مفيش براند مرتبط بحسابك'); return; }
  const file = document.getElementById('brandCoverFile').files[0];
  if(!file){ alert('اختاري صورة الأول'); return; }
  try{
    showToast('جاري رفع الصورة...');
    const logoUrl = await uploadToImgbb(file);
    await updateDoc(doc(db,"brands",currentUser.brandId), { logoUrl });
    await logActivity("غيّرت صورة غلاف البراند", '');
    showToast('اتحفظت صورة الغلاف ❤️');
    document.getElementById('brandCoverFile').value='';
    await loadData();
    loadSellerDashboard();
  }catch(e){
    alert('حصل خطأ في رفع الصورة: ' + e.message);
  }
}

window.sellerUpdateWhatsapp = async function(){
  if(!currentUser || !currentUser.brandId){ showToast('مفيش براند مرتبط بحسابك'); return; }
  const phone = document.getElementById('sellerWhatsapp').value.trim();
  if(!phone){ alert('اكتبي رقم موبايلك الأول'); return; }
  try{
    await updateDoc(doc(db,"brands",currentUser.brandId), { managerPhone: phone });
    await logActivity("حدّثت رقم الواتساب بتاعها", '');
    showToast('اتحفظ رقم الواتساب ❤️');
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

window.sellerUpdateVodafone = async function(){
  if(!currentUser || !currentUser.brandId){ showToast('مفيش براند مرتبط بحسابك'); return; }
  const phone = document.getElementById('sellerVodafone').value.trim();
  if(!phone){ alert('اكتبي رقم فودافون كاش الأول'); return; }
  try{
    await updateDoc(doc(db,"brands",currentUser.brandId), { vodafoneNumber: phone });
    await logActivity("حدّثت رقم فودافون كاش بتاعها", '');
    showToast('اتحفظ رقم فودافون كاش ❤️');
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

window.adminChangeOwnPassword = async function(){
  const oldPass = document.getElementById('adminOldPass').value;
  const newPass = document.getElementById('adminNewPass').value;
  const newPass2 = document.getElementById('adminNewPass2').value;

  if(!oldPass || !newPass || !newPass2){ alert('من فضلك املي كل الحقول'); return; }
  if(newPass.length<6){ alert('كلمة السر الجديدة لازم تكون 6 حروف/أرقام على الأقل'); return; }
  if(newPass !== newPass2){ alert('كلمة السر الجديدة والتأكيد مش متطابقين'); return; }

  try{
    const cred = EmailAuthProvider.credential(auth.currentUser.email, oldPass);
    await reauthenticateWithCredential(auth.currentUser, cred);
    await updatePassword(auth.currentUser, newPass);
    await logActivity("غيّر الأدمن باسوردها بنفسها", '');
    showToast('اتغيّرت كلمة المرور بنجاح ❤️');
    document.getElementById('adminOldPass').value='';
    document.getElementById('adminNewPass').value='';
    document.getElementById('adminNewPass2').value='';
  }catch(e){
    if(e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password'){
      alert('كلمة المرور الحالية غلط');
    }else{
      alert('حصل خطأ: ' + e.message);
    }
  }
}
window.sellerChangeOwnPassword = async function(){
  const oldPass = document.getElementById('sellerOldPass').value;
  const newPass = document.getElementById('sellerNewPass').value;
  const newPass2 = document.getElementById('sellerNewPass2').value;

  if(!oldPass || !newPass || !newPass2){ alert('من فضلك املي كل الحقول'); return; }
  if(newPass.length<6){ alert('كلمة السر الجديدة لازم تكون 6 حروف/أرقام على الأقل'); return; }
  if(newPass !== newPass2){ alert('كلمة السر الجديدة والتأكيد مش متطابقين'); return; }

  try{
    const cred = EmailAuthProvider.credential(auth.currentUser.email, oldPass);
    await reauthenticateWithCredential(auth.currentUser, cred);
    await updatePassword(auth.currentUser, newPass);
    await logActivity("غيّرت باسوردها بنفسها", '');
    showToast('اتغيّرت كلمة المرور بنجاح ❤️');
    document.getElementById('sellerOldPass').value='';
    document.getElementById('sellerNewPass').value='';
    document.getElementById('sellerNewPass2').value='';
  }catch(e){
    if(e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password'){
      alert('كلمة المرور الحالية غلط');
    }else{
      alert('حصل خطأ: ' + e.message);
    }
  }
}

window.sellerSaveProduct = async function(){
  if(!currentUser || !currentUser.brandId){ showToast('مفيش براند مرتبط بحسابك'); return; }
  const name = document.getElementById('pName').value.trim();
  const price = parseFloat(document.getElementById('pPrice').value);
  const category = document.getElementById('pCategory').value;
  const desc = document.getElementById('pDesc').value.trim();
  const emoji = document.getElementById('pEmoji').value.trim() || '📦';
  const fileInput = document.getElementById('pImageFile');
  const file = fileInput.files[0];
  if(!name || isNaN(price)){ showToast('اكتبي اسم المنتج والسعر'); return; }

  let imageUrl;
  if(file){
    try{
      showToast('جاري رفع الصورة...');
      imageUrl = await uploadToImgbb(file);
      console.log("رابط الصورة اللي اترفعت:", imageUrl);
    }catch(e){
      alert('حصل خطأ في رفع الصورة: ' + e.message);
      return;
    }
  }

  if(editingProductId){
    try{
      const updateData = { name, price, category, desc, emoji };
      if(imageUrl) updateData.imageUrl = imageUrl;
      await updateDoc(doc(db,"products",editingProductId), updateData);
      await logActivity("عدّلت منتج", name);
      showToast('اتحفظ التعديل ✓');
      sellerCancelEdit();
    }catch(e){
      alert('حصل خطأ وقت حفظ التعديل: ' + e.message);
      return;
    }
  } else {
    try{
      await addDoc(collection(db,"products"), { brandId: currentUser.brandId, name, price, category, desc, emoji, imageUrl: imageUrl||"" });
      await logActivity("أضافت منتج", name);
      document.getElementById('pName').value=''; document.getElementById('pPrice').value=''; document.getElementById('pDesc').value=''; fileInput.value='';
      showToast('اتضاف المنتج 🎉');
    }catch(e){
      alert('حصل خطأ وقت إضافة المنتج: ' + e.message);
      return;
    }
  }
  loadSellerDashboard();
}
window.sellerDeleteProduct = async function(productId, productName){
  await deleteDoc(doc(db,"products",productId));
  await logActivity("حذفت منتج", productName);
  showToast('اتحذف المنتج');
  loadSellerDashboard();
}
window.sellerConfirmPayment = async function(orderId){
  await updateDoc(doc(db,"orders",orderId), { paymentStatus:"confirmed" });
  loadSellerDashboard();
}
window.sellerUpdateStatus = async function(orderId, newStatus){
  await updateDoc(doc(db,"orders",orderId), { fulfillmentStatus:newStatus });
  loadSellerDashboard();
}

// ============== لوحة الأدمن ==============
window.adminChangeManagerPassword = async function(brandId, savedPhone, brandName){
  if(!confirm(`هيتبعت لمديرة "${brandName}" إيميل فيه رابط تختار بيه كلمة مرور جديدة بنفسها. تكملي؟`)) return;
  try{
    // نلاقي إيميل حساب المديرة (uid) المرتبط بالبراند ده
    const usersSnap = await getDocs(query(collection(db,"users"), where("brandId","==",brandId)));
    if(usersSnap.empty){ alert('مش لاقية حساب مديرة مرتبط بالبراند ده'); return; }
    const brandSnap = await getDoc(doc(db,"brands",brandId));
    const managerEmail = brandSnap.exists() ? brandSnap.data().managerEmail : null;
    if(!managerEmail){ alert('مفيش إيميل محفوظ لحساب المديرة دي، مقدرش أبعتلها رابط.'); return; }

    await sendPasswordResetEmail(auth, managerEmail);
    await logActivity("بعتت رابط تغيير باسورد لمديرة", brandName);
    showToast('اتبعت رسالة لإيميل المديرة فيها رابط تغيير كلمة المرور ✓');
  }catch(e){
    alert('حصل خطأ: ' + (e.message || e));
  }
}

window.adminSendResetLink = async function(){
  const email = document.getElementById('resetEmail').value.trim();
  if(!email){ alert('اكتبي الإيميل الأول'); return; }
  try{
    await sendPasswordResetEmail(auth, email);
    await logActivity("بعتت لينك تغيير باسورد لـ", email);
    alert('اتبعت رسالة على ' + email + ' فيها لينك تغيير الباسورد ✓');
    document.getElementById('resetEmail').value='';
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

window.adminCreateCategory = async function(){
  const label = document.getElementById('ncLabel').value.trim();
  const icon = document.getElementById('ncIcon').value.trim() || '🏷️';
  if(!label){ alert('اكتبي اسم القسم'); return; }
  try{
    await addDoc(collection(db,"categories"), { label, icon });
    await logActivity("أضافت قسم جديد", label);
    document.getElementById('ncLabel').value=''; document.getElementById('ncIcon').value='';
    showToast('اتضاف القسم 🎉');
    await loadData();
    populateCategorySelects();
    renderCategoryStalls();
    renderAdminCategoriesList();
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

function renderAdminProductsList(){
  const filterSelect = document.getElementById('adminProductsBrandFilter');
  let brandFilter = '';
  if(filterSelect){
    brandFilter = filterSelect.value;
    filterSelect.innerHTML = `<option value="">كل البراندات</option>` +
      DATA.vendors.map(v=>`<option value="${v.id}">${v.name}</option>`).join('');
    filterSelect.value = brandFilter;
  }
  const wrap = document.getElementById('adminProductsList');
  if(!wrap) return;
  const list = brandFilter ? DATA.products.filter(p=>p.brandId===brandFilter) : DATA.products;
  if(list.length===0){ wrap.innerHTML = `<div class="empty-state"><div class="icon">📦</div>مفيش منتجات</div>`; return; }
  wrap.innerHTML = list.map(p=>{
    const vendor = DATA.vendors.find(v=>v.id===p.brandId);
    return `
    <div class="order-card">
      <div class="row"><span>${p.emoji||'📦'} ${p.name} — ${p.price} ج.م</span><span class="hint">${catLabel(p.category)}</span></div>
      <div class="row"><span class="hint">البراند: ${vendor?vendor.name:'—'}</span></div>
      <button class="del-btn" onclick="adminDeleteProduct('${p.id}', '${(p.name||'').replace(/'/g,"")}')">حذف المنتج</button>
    </div>`;
  }).join('');
}
window.adminDeleteProduct = async function(productId, productName){
  if(!confirm(`متأكدة إنك عايزة تمسحي منتج "${productName}"؟`)) return;
  try{
    await deleteDoc(doc(db,"products",productId));
    await logActivity("مسحت منتج (من لوحة الأدمن)", productName);
    showToast('اتمسح المنتج');
    await loadData();
    renderAdminProductsList();
    renderAdminCategoriesList();
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

function renderAdminCategoriesList(){
  const wrap = document.getElementById('adminCategoriesList');
  if(!wrap) return;
  if(!CATEGORIES.length){ wrap.innerHTML = `<p class="hint">مفيش أقسام لسه.</p>`; return; }
  wrap.innerHTML = CATEGORIES.map(c=>{
    const count = DATA.products.filter(p=>p.category===c.id).length;
    return `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line);">
      <span>${c.icon||'🏷️'} ${c.label} <span class="hint">(${count} منتج)</span></span>
      <button class="del-btn" onclick="adminDeleteCategory('${c.id}')">حذف</button>
    </div>`;
  }).join('');
}

window.adminDeleteCategory = async function(catId){
  const inUse = DATA.products.some(p=>p.category===catId);
  if(inUse){
    alert('مينفعش تمسحي القسم ده، فيه منتجات مرتبطة بيه. لازم تنقلي أو تمسحي المنتجات دي الأول.');
    return;
  }
  const cat = CATEGORIES.find(c=>c.id===catId);
  if(!confirm(`متأكدة إنك عايزة تمسحي قسم "${cat?cat.label:''}"؟`)) return;
  try{
    await deleteDoc(doc(db,"categories",catId));
    await logActivity("مسحت قسم", cat?cat.label:catId);
    showToast('اتمسح القسم');
    await loadData();
    populateCategorySelects();
    renderCategoryStalls();
    renderAdminCategoriesList();
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

window.adminCreateBrand = async function(){
  const ownerName = document.getElementById('nbOwnerName').value.trim();
  const email = document.getElementById('nbEmail').value.trim();
  const phone = document.getElementById('nbPhone').value.trim();
  const vodafoneNumber = document.getElementById('nbVodafone').value.trim() || phone;
  const brandName = document.getElementById('nbBrandName').value.trim();
  const description = document.getElementById('nbDesc').value.trim();
  const categories = Array.from(document.querySelectorAll('.nb-cat-check:checked')).map(c=>c.value);

  if(!ownerName || !email || !brandName){ alert('من فضلك املي كل الحقول (الاسم، الإيميل، اسم البراند)'); return; }
  if(categories.length===0){ alert('اختاري قسم واحد على الأقل'); return; }

  // كلمة مرور مؤقتة عشوائية بنستخدمها لإنشاء الحساب بس — محدش هيشوفها ولا هتتبعت لحد
  // المديرة هتحط كلمة مرورها هي بنفسها من رابط بيوصلها في إيميلها
  const tempPassword = crypto.randomUUID ? crypto.randomUUID() : ('gm_'+Math.random().toString(36).slice(2)+Date.now());

  // بنستخدم تطبيق Firebase ثانوي مؤقت عشان إنشاء الحساب الجديد
  // من غير ما يسجل خروج الأدمن من حسابه الحالي
  let secondaryApp;
  try{
    secondaryApp = initializeApp(firebaseConfig, "SecondaryApp_"+Date.now());
    const secondaryAuth = getAuth(secondaryApp);
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, tempPassword);
    const newUid = cred.user.uid;
    await signOut(secondaryAuth);
    await deleteApp(secondaryApp);

    const brandDoc = await addDoc(collection(db,"brands"), {
      name: brandName, ownerName, description, categories,
      category: categories[0], isActive: true, managerEmail: email, managerPhone: phone, vodafoneNumber
    });

    await setDoc(doc(db,"users", newUid), {
      name: ownerName, role: "brand_manager", brandId: brandDoc.id, phone
    });

    // إيميل فيه رابط تختار بيه المديرة كلمة مرورها هي بنفسها بأمان
    await sendPasswordResetEmail(auth, email);

    await logActivity("أنشأت براند ومديرة جديدة", brandName);

    alert(`تم إنشاء البراند بنجاح! ✓\n\nاتبعت رسالة لإيميل "${email}" فيها رابط تختار بيه المديرة كلمة مرورها بنفسها. قوليلها تتابع الإيميل (وتشيك على السبام لو مالقتوش).`);

    document.getElementById('nbOwnerName').value='';
    document.getElementById('nbEmail').value='';
    document.getElementById('nbPhone').value='';
    document.getElementById('nbVodafone').value='';
    document.getElementById('nbBrandName').value='';
    document.getElementById('nbDesc').value='';
    document.querySelectorAll('.nb-cat-check').forEach(c=>c.checked=false);

    await loadData();
    loadAdminDashboard();
  }catch(e){
    if(secondaryApp){ try{ await deleteApp(secondaryApp); }catch(err){} }
    alert('حصل خطأ: ' + e.message);
  }
}

// الأدمن بتعمل براند خاص بيها هي، بنفس حسابها (من غير حساب دخول جديد)
window.adminCreateOwnBrand = async function(){
  if(!currentUser || currentUser.role!=='admin') return;
  const brandName = document.getElementById('ownBrandName').value.trim();
  const description = document.getElementById('ownBrandDesc').value.trim();
  const vodafoneNumber = document.getElementById('ownBrandVodafone').value.trim();
  const categories = Array.from(document.querySelectorAll('.own-cat-check:checked')).map(c=>c.value);

  if(!brandName){ alert('اكتبي اسم البراند الأول'); return; }
  if(categories.length===0){ alert('اختاري قسم واحد على الأقل'); return; }

  try{
    const brandDoc = await addDoc(collection(db,"brands"), {
      name: brandName, ownerName: currentUser.name || '', description, categories,
      category: categories[0], isActive: true, managerPhone: '', vodafoneNumber
    });

    // بنربط البراند بحساب الأدمن الحالي، فتفضل أدمن وفي نفس الوقت صاحبة براند
    await updateDoc(doc(db,"users", currentUser.uid), { brandId: brandDoc.id });
    currentUser.brandId = brandDoc.id;

    const navMyBrand = document.getElementById('navMyBrand');
    if(navMyBrand) navMyBrand.style.display = 'inline-block';

    await logActivity("أنشأت براندها الخاص", brandName);
    showToast('اتعمل براندك بنجاح 🎉 دوسي على "الذهاب إلى براندي" فوق');

    document.getElementById('ownBrandName').value='';
    document.getElementById('ownBrandDesc').value='';
    document.getElementById('ownBrandVodafone').value='';
    document.querySelectorAll('.own-cat-check').forEach(c=>c.checked=false);

    await loadData();
    loadAdminDashboard();
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

// ============== ثيم الموقع ==============
const VALID_THEMES = ['default','ramadan','eid-fitr','eid-adha','mothers-day','valentine','spring','summer','winter','blackfriday','newyear'];
function applyTheme(themeId){
  VALID_THEMES.forEach(t=>{ if(t!=='default') document.body.classList.remove('theme-'+t); });
  if(themeId && themeId!=='default' && VALID_THEMES.includes(themeId)){
    document.body.classList.add('theme-'+themeId);
  }
}
async function loadAndApplyTheme(){
  try{
    const snap = await getDoc(doc(db,"settings","site"));
    const themeId = snap.exists() ? (snap.data().theme || 'default') : 'default';
    applyTheme(themeId);
    const sel = document.getElementById('themeSelect');
    if(sel) sel.value = themeId;
  }catch(e){
    console.log('theme load error:', e);
  }
}
window.adminSetTheme = async function(){
  if(!currentUser || currentUser.role!=='admin') return;
  const themeId = document.getElementById('themeSelect').value;
  try{
    await setDoc(doc(db,"settings","site"), { theme: themeId }, { merge:true });
    applyTheme(themeId);
    await logActivity("غيّرت ثيم الموقع", themeId);
    showToast('اتغيّر شكل الموقع للكل ✓');
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

async function loadAdminDashboard(){
  if(!currentUser || currentUser.role!=='admin') return;
  renderAdminCategoriesList();
  renderAdminProductsList();

  // الإحصائيات
  const allProductsSnap = await getDocs(collection(db,"products"));
  const allOrdersSnap = await getDocs(collection(db,"orders"));
  const allOrders = allOrdersSnap.docs.map(d=>d.data());
  const totalRevenue = allOrders.reduce((s,o)=>s+(o.totalAmount||0), 0);
  document.getElementById('adminStats').innerHTML = `
    <div class="stat-card"><div class="num">${allOrders.length}</div><div class="lbl">إجمالي الطلبات</div></div>
    <div class="stat-card"><div class="num">${allProductsSnap.size}</div><div class="lbl">إجمالي المنتجات</div></div>
    <div class="stat-card"><div class="num">${DATA.vendors.length}</div><div class="lbl">البراندات النشطة</div></div>
    <div class="stat-card"><div class="num">${totalRevenue} ج.م</div><div class="lbl">إجمالي المبيعات</div></div>
  `;

  const reqSnap = await getDocs(query(collection(db,"joinRequests"), where("status","==","pending")));
  const requests = reqSnap.docs.map(d=>({id:d.id, ...d.data()}));
  const reqWrap = document.getElementById('adminJoinRequests');
  reqWrap.innerHTML = requests.length===0
    ? `<div class="empty-state"><div class="icon">📭</div>مفيش طلبات جديدة</div>`
    : requests.map(r=>`
      <div class="order-card">
        <div class="row"><span>${r.applicantName} — ${r.phone}</span></div>
        <div class="row"><span>البراند المقترح: ${r.proposedBrand}</span></div>
        <div class="row"><span>${r.description||''}</span></div>
        <button class="small-btn" onclick="adminApproveRequest('${r.id}', '${(r.applicantName||'').replace(/'/g,"")}')">موافقة</button>
        <button class="small-btn" style="background:#a24545;" onclick="adminRejectRequest('${r.id}', '${(r.applicantName||'').replace(/'/g,"")}')">رفض</button>
      </div>`).join('');

  const brandsSnap = await getDocs(collection(db,"brands"));
  const brands = brandsSnap.docs.map(d=>({id:d.id, ...d.data()}));
  const brandsWrap = document.getElementById('adminBrands');
  brandsWrap.innerHTML = brands.length===0
    ? `<div class="empty-state"><div class="icon">🌸</div>لسه مفيش براندات</div>`
    : brands.map(b=>{
      const currentCats = Array.isArray(b.categories) && b.categories.length ? b.categories : (b.category ? [b.category] : []);
      return `
      <div class="order-card">
        <div class="row"><span>${b.name}${b.ownerName ? ` (${b.ownerName})` : ''}</span><span class="badge ${b.isActive!==false?'ok':'pending'}">${b.isActive!==false?'نشط':'موقوف'}</span></div>
        <div class="row"><span class="hint">الأقسام الحالية: ${currentCats.map(cid=>catLabel(cid)).join('، ') || '—'}</span></div>
        <button class="small-btn" onclick="adminToggleBrand('${b.id}', ${b.isActive!==false}, '${(b.name||'').replace(/'/g,"")}')">${b.isActive!==false?'إيقاف':'تفعيل'}</button>
        <button class="small-btn" style="background:var(--rosegold);" onclick="adminChangeManagerPassword('${b.id}', '${b.managerPhone||''}', '${(b.name||'').replace(/'/g,"")}')">إرسال رابط تغيير الباسورد</button>
        <button class="small-btn" style="background:#8a7ea8;" onclick="adminToggleEditCats('${b.id}')">تعديل الأقسام</button>
        <div id="editCatsBox-${b.id}" style="display:none; margin-top:10px; padding-top:10px; border-top:1px dashed var(--line);">
          ${CATEGORIES.map(c=>`
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; margin-bottom:8px; font-weight:400;">
              <input type="checkbox" value="${c.id}" class="ec-cat-check-${b.id}" style="width:auto;" ${currentCats.includes(c.id)?'checked':''}> ${c.label}
            </label>`).join('')}
          <button class="submit-btn" style="margin-top:4px;" onclick="adminSaveBrandCategories('${b.id}')">حفظ الأقسام</button>
        </div>
      </div>`;
    }).join('');

  // آراء الزوار على الموقع
  const fbSnap = await getDocs(query(collection(db,"siteFeedback"), orderBy("createdAt","desc")));
  const feedbacks = fbSnap.docs.slice(0,20).map(d=>d.data());
  const fbWrap = document.getElementById('adminSiteFeedback');
  fbWrap.innerHTML = feedbacks.length===0
    ? `<div class="empty-state"><div class="icon">💬</div>لسه محدش قيّم الموقع</div>`
    : feedbacks.map(f=>`
      <div class="log-item">
        ${f.rating ? `<span class="stars">${renderStars(f.rating)}</span> ` : ''}
        ${f.customerName ? `<b>${f.customerName}</b> — ` : ''}${f.comment || ''}
      </div>`).join('');

  // سجل العمليات
  const logSnap = await getDocs(query(collection(db,"activityLog"), orderBy("createdAt","desc")));
  const logs = logSnap.docs.slice(0,20).map(d=>d.data());
  const logWrap = document.getElementById('adminActivityLog');
  logWrap.innerHTML = logs.length===0
    ? `<div class="empty-state"><div class="icon">📜</div>مفيش عمليات مسجلة لسه</div>`
    : logs.map(l=>`<div class="log-item"><b>${l.actorName||'-'}</b> ${l.action}${l.targetName ? ` — ${l.targetName}` : ''}</div>`).join('');
}

async function logActivity(action, targetName){
  if(!currentUser) return;
  try{
    await addDoc(collection(db,"activityLog"), {
      actorName: currentUser.name || '-',
      actorRole: currentUser.role,
      action, targetName: targetName || '',
      createdAt: serverTimestamp()
    });
  }catch(e){ console.log("activity log error:", e); }
}
window.adminApproveRequest = async function(reqId, applicantName){
  await updateDoc(doc(db,"joinRequests",reqId), { status:"approved" });
  await logActivity("وافقت على طلب انضمام", applicantName);
  showToast('تمت الموافقة — دلوقتي اعملي حساب ومنتج البراند لها يدوياً زي ما في ملف SETUP_ACCOUNTS');
  loadAdminDashboard();
}
window.adminRejectRequest = async function(reqId, applicantName){
  await updateDoc(doc(db,"joinRequests",reqId), { status:"rejected" });
  await logActivity("رفضت طلب انضمام", applicantName);
  loadAdminDashboard();
}
window.adminToggleBrand = async function(brandId, currentlyActive, brandName){
  await updateDoc(doc(db,"brands",brandId), { isActive: !currentlyActive });
  await logActivity(currentlyActive ? "أوقفت براند" : "فعّلت براند", brandName);
  loadAdminDashboard();
}
window.adminToggleEditCats = function(brandId){
  const box = document.getElementById('editCatsBox-'+brandId);
  if(box) box.style.display = box.style.display==='none' ? 'block' : 'none';
}
window.adminSaveBrandCategories = async function(brandId){
  const checks = document.querySelectorAll('.ec-cat-check-'+brandId+':checked');
  const categories = Array.from(checks).map(c=>c.value);
  if(categories.length===0){ alert('اختاري قسم واحد على الأقل'); return; }
  try{
    await updateDoc(doc(db,"brands",brandId), { categories, category: categories[0] });
    await logActivity("عدّلت أقسام براند", brandId);
    showToast('اتحفظت الأقسام 🎉');
    loadAdminDashboard();
  }catch(e){
    alert('حصل خطأ: ' + e.message);
  }
}

document.addEventListener('keydown', (e)=>{
  if(e.key==='Escape') closeProductModal();
});

// ============== البداية ==============
async function init(){
  await loadData();
  populateCategorySelects();
  renderCategoryStalls();
  loadCart();
  loadFavorites();
  renderProductGrid('featuredGrid', DATA.products);
  renderVendorsGrid();
  updateCartCount();
  updateFavCount();
  loadAndApplyTheme();
}
init();
