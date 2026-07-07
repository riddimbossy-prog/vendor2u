// server.js — Vendor2Me server: website + API + vendor accounts + dashboard + email.
// Backed by PostgreSQL (see db.js). Reads config from environment variables.

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

// Render (and most hosts) put the app behind a proxy. This tells Express to trust
// it, so it correctly treats HTTPS connections as secure and sets session cookies.
app.set('trust proxy', 1);

// --- Security headers (Helmet) ---
// CSP is configured to allow the CDNs the pages rely on (Tailwind, Chart.js,
// Font Awesome, Google Fonts) plus inline scripts/styles the pages use, and the
// remote images (picsum). Kept practical so nothing on the site breaks.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Rate limiting ---
// A gentle global cap, plus a stricter cap on auth endpoints to stop brute-force
// login/signup attempts. Limits are generous enough not to bother real users.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                 // 300 requests / 15 min per IP
  standardHeaders: true,
  legacyHeaders: false
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,                  // 20 login/signup attempts / 15 min per IP
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', generalLimiter);

// NOTE: session middleware is set up inside the async block below, once the
// database pool is ready, so sessions can be stored in Postgres (surviving restarts).

// --- Optional email (Resend). Works without it; just logs if not configured. ---
let resend = null;
if (process.env.RESEND_API_KEY) {
  const { Resend } = require('resend');
  resend = new Resend(process.env.RESEND_API_KEY);}
const FROM_EMAIL = process.env.FROM_EMAIL || 'Vendor2U <onboarding@resend.dev>';
const SITE_URL = process.env.SITE_URL || '';

async function sendEmail(to, subject, html) {
  if (!resend) { console.log('[email disabled] would send to', to, '-', subject); return; }
  try {
    await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
  } catch (e) {
    console.error('Email send failed:', e.message);
  }
}

// --- Photo uploads (Cloudinary). Works only if configured; endpoints report a
// clear message if not. multer holds the uploaded file in memory briefly, then
// we stream it to Cloudinary and store just the resulting URL in Postgres. ---
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per image
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpe?g|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  }
});

let cloudinary = null;
if (process.env.CLOUDINARY_URL || process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary = require('cloudinary').v2;
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config(); // reads CLOUDINARY_URL from the environment automatically
  } else if (process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
  }
  // Safe diagnostic: logs which method + cloud name + secret LENGTH (never the secret)
  const cfg = cloudinary.config();
  console.log('[cloudinary] configured via',
    process.env.CLOUDINARY_URL ? 'CLOUDINARY_URL' : 'separate vars',
    '| cloud_name:', cfg.cloud_name,
    '| api_key:', cfg.api_key,
    '| secret length:', cfg.api_secret ? cfg.api_secret.length : 0);
} else {
  console.log('[cloudinary] NOT configured (no env vars found)');
}

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    // Keep the signed upload simple (just a folder) so the signature always
    // matches. We optimize/resize at display time via the URL instead, which
    // avoids Cloudinary signed-transformation signature mismatches.
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'vendor2me' },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

// Insert Cloudinary transformations into a delivery URL so images are served
// resized and auto-optimized without affecting the upload signature.
function optimizedUrl(secureUrl) {
  if (!secureUrl || !secureUrl.includes('/upload/')) return secureUrl;
  return secureUrl.replace('/upload/', '/upload/c_limit,w_1200,h_900/q_auto,f_auto/');
}

// --- Shape a DB row into the JSON the frontend expects ---
function shapeVendor(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, owner: row.owner, email: row.email, category: row.category,
    location: { city: row.city, state: row.state, zip: row.zip },
    serviceRadius: row.service_radius, rating: row.rating, reviews: row.reviews,
    priceRange: { min: row.price_min, max: row.price_max, unit: row.price_unit },
    culturalSpecialties: row.cultural_specialties || [],
    languages: row.languages || [],
    yearsInBusiness: row.years_in_business, verified: !!row.verified,
    availability: row.availability, tags: row.tags || [],
    photos: row.photos || [],
    featuredImage: row.featured_image || null,
    // Card/profile image prefers the vendor's chosen featured photo, else their
    // first uploaded photo, else the legacy placeholder image.
    image: row.featured_image || ((row.photos && row.photos[0] && row.photos[0].url) || row.image),
    bio: row.bio
  };
}

function calculateMatchScore(vendor, criteria) {
  let score = 0;
  const w = { category: 0.30, location: 0.25, cultural: 0.20, rating: 0.15, budget: 0.10 };
  if (criteria.service && vendor.category.toLowerCase().includes(criteria.service.toLowerCase())) score += w.category * 100;
  const userLoc = (criteria.location || '').toLowerCase();
  if (userLoc && (vendor.location.city.toLowerCase().includes(userLoc) || vendor.location.state.toLowerCase().includes(userLoc))) score += w.location * 100;
  else if (vendor.serviceRadius > 50) score += w.location * 60;
  if (criteria.cultural && vendor.culturalSpecialties.some(c => criteria.cultural.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(criteria.cultural.toLowerCase()))) score += w.cultural * 100;
  score += (vendor.rating / 5) * w.rating * 100;
  if (criteria.budget) {
    const mid = (vendor.priceRange.min + vendor.priceRange.max) / 2;
    if (mid < criteria.budget * 0.8) score += w.budget * 80;
    else if (mid < criteria.budget) score += w.budget * 50;
  }
  return Math.min(Math.round(score), 98);
}
function matchReasons(vendor, criteria, score) {
  const r = [];
  if (score > 85) r.push('Excellent cultural and service alignment');
  if (vendor.verified) r.push('Verified professional');
  if (vendor.rating > 4.7) r.push('Highly rated in community');
  if (criteria.cultural && vendor.culturalSpecialties.some(c => criteria.cultural.toLowerCase().includes(c.toLowerCase()))) r.push(`Specializes in ${criteria.cultural} traditions`);
  return r.length ? r : ['Strong overall match'];
}

// Require login for protected routes
function requireAuth(req, res, next) {
  if (!req.session.vendorId) return res.status(401).json({ error: 'Please log in.' });
  next();
}

module.exports = (async () => {
  const db = await require('./db');

  // --- Sessions stored in Postgres, so they survive server restarts (free tier sleeps) ---
  const pgSession = require('connect-pg-simple')(session);
  app.use(session({
    store: new pgSession({
      pool: db.pool,
      createTableIfMissing: true   // makes its own "session" table automatically
    }),
    secret: process.env.SESSION_SECRET || 'vendor2u-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
    }
  }));

  // ============ AUTH ============
  app.post('/api/auth/signup', authLimiter, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.name || !b.category || !b.email || !b.password) {
        return res.status(400).json({ error: 'Business name, category, email, and password are required.' });
      }
      if (String(b.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

      const existing = await db.one('SELECT id FROM vendors WHERE lower(email) = lower($1)', [b.email]);
      if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

      const id = uuidv4();
      const hash = await bcrypt.hash(String(b.password), 10);
      await db.query(`
        INSERT INTO vendors (id,name,owner,email,password_hash,category,city,state,zip,service_radius,rating,reviews,price_min,price_max,price_unit,cultural_specialties,languages,years_in_business,verified,availability,tags,image,bio)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      `, [
        id, b.name, b.owner || '', b.email, hash, b.category,
        b.city || '', (b.state || '').toUpperCase(), b.zip || '',
        Number(b.serviceRadius) || 50, 5.0, 0,
        Number(b.priceMin) || 0, Number(b.priceMax) || 0, b.priceUnit || 'per event',
        JSON.stringify(b.culturalSpecialties || []), JSON.stringify(b.languages || []),
        Number(b.yearsInBusiness) || 0, false, 'medium',
        JSON.stringify(b.tags || []),
        b.image || ('https://picsum.photos/seed/' + Date.now() + '/600/400'),
        b.bio || ''
      ]);

      req.session.vendorId = id;
      const row = await db.one('SELECT * FROM vendors WHERE id=$1', [id]);
      res.status(201).json({ success: true, vendor: shapeVendor(row) });
    } catch (e) {
      console.error('signup error', e);
      res.status(500).json({ error: 'Could not create account.' });
    }
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
      const row = await db.one('SELECT * FROM vendors WHERE lower(email)=lower($1)', [email]);
      if (!row || !row.password_hash) return res.status(401).json({ error: 'Invalid email or password.' });
      const ok = await bcrypt.compare(String(password), row.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
      req.session.vendorId = row.id;
      res.json({ success: true, vendor: shapeVendor(row) });
    } catch (e) {
      console.error('login error', e);
      res.status(500).json({ error: 'Login failed.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
  });

  app.get('/api/auth/me', async (req, res) => {
    if (!req.session.vendorId) return res.json({ loggedIn: false });
    const row = await db.one('SELECT * FROM vendors WHERE id=$1', [req.session.vendorId]);
    if (!row) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, vendor: shapeVendor(row) });
  });

  // ============ PUBLIC VENDOR ENDPOINTS ============
  app.get('/api/health', (req, res) => res.json({ status: 'OK', message: 'Vendor2Me Backend Running' }));

  app.post('/api/match', async (req, res) => {
    const { location, budget, cultural, service } = req.body || {};
    const criteria = { location, budget, cultural, service };
    const rows = (await db.query('SELECT * FROM vendors')).map(shapeVendor);
    const matches = rows.map(v => {
      const s = calculateMatchScore(v, criteria);
      return { ...v, matchScore: s, matchReason: matchReasons(v, criteria, s) };
    }).sort((a, b) => b.matchScore - a.matchScore).slice(0, 8);
    res.json({ success: true, matches, totalVendors: rows.length, criteria });
  });

  app.get('/api/vendors', async (req, res) => {
    const { category, state, minRating, q } = req.query;
    let rows = (await db.query('SELECT * FROM vendors ORDER BY rating DESC')).map(shapeVendor);
    if (category) rows = rows.filter(v => v.category.toLowerCase() === category.toLowerCase());
    if (state) rows = rows.filter(v => v.location.state.toLowerCase() === String(state).toLowerCase());
    if (minRating) rows = rows.filter(v => v.rating >= parseFloat(minRating));
    if (q) {
      const n = String(q).toLowerCase();
      rows = rows.filter(v =>
        v.name.toLowerCase().includes(n) || v.category.toLowerCase().includes(n) ||
        v.location.city.toLowerCase().includes(n) || v.location.state.toLowerCase().includes(n) ||
        v.culturalSpecialties.some(c => c.toLowerCase().includes(n)) ||
        v.tags.some(t => t.toLowerCase().includes(n)));
    }
    res.json(rows);
  });

  app.get('/api/vendors/:id', async (req, res) => {
    const row = await db.one('SELECT * FROM vendors WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Vendor not found' });
    res.json(shapeVendor(row));
  });

  // Update own profile (must be logged in, can only edit self)
  app.put('/api/vendors/me', requireAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const id = req.session.vendorId;
      await db.query(`
        UPDATE vendors SET
          name=COALESCE($2,name), owner=COALESCE($3,owner), category=COALESCE($4,category),
          city=COALESCE($5,city), state=COALESCE($6,state), zip=COALESCE($7,zip),
          service_radius=COALESCE($8,service_radius), price_min=COALESCE($9,price_min),
          price_max=COALESCE($10,price_max), price_unit=COALESCE($11,price_unit),
          cultural_specialties=COALESCE($12,cultural_specialties), languages=COALESCE($13,languages),
          years_in_business=COALESCE($14,years_in_business), tags=COALESCE($15,tags),
          image=COALESCE($16,image), bio=COALESCE($17,bio)
        WHERE id=$1
      `, [
        id, b.name ?? null, b.owner ?? null, b.category ?? null,
        b.city ?? null, b.state ? String(b.state).toUpperCase() : null, b.zip ?? null,
        b.serviceRadius ?? null, b.priceMin ?? null, b.priceMax ?? null, b.priceUnit ?? null,
        b.culturalSpecialties ? JSON.stringify(b.culturalSpecialties) : null,
        b.languages ? JSON.stringify(b.languages) : null,
        b.yearsInBusiness ?? null,
        b.tags ? JSON.stringify(b.tags) : null,
        b.image ?? null, b.bio ?? null
      ]);
      const row = await db.one('SELECT * FROM vendors WHERE id=$1', [id]);
      res.json({ success: true, vendor: shapeVendor(row) });
    } catch (e) {
      console.error('profile update error', e);
      res.status(500).json({ error: 'Could not update profile.' });
    }
  });

  // ============ PHOTOS (Cloudinary) ============
  // Upload a photo (max 5 total per vendor). Returns the updated photo list.
  app.post('/api/my/photos', requireAuth, upload.single('photo'), async (req, res) => {
    try {
      if (!cloudinary) return res.status(503).json({ error: 'Photo uploads are not configured yet.' });
      if (!req.file) return res.status(400).json({ error: 'No image received.' });

      const id = req.session.vendorId;
      const vendor = await db.one('SELECT photos, featured_image FROM vendors WHERE id=$1', [id]);
      const photos = vendor.photos || [];
      if (photos.length >= 5) return res.status(400).json({ error: 'You can upload up to 5 photos. Delete one first.' });

      const result = await uploadToCloudinary(req.file.buffer);
      const photo = { url: optimizedUrl(result.secure_url), public_id: result.public_id };
      photos.push(photo);

      // If this is their first photo, make it the featured one automatically
      const featured = vendor.featured_image || photo.url;

      await db.query('UPDATE vendors SET photos=$1, featured_image=$2 WHERE id=$3',
        [JSON.stringify(photos), featured, id]);
      res.status(201).json({ success: true, photos, featuredImage: featured });
    } catch (e) {
      console.error('photo upload error', e);
      res.status(500).json({ error: e.message || 'Upload failed.' });
    }
  });

  // Delete a photo by its Cloudinary public_id
  app.delete('/api/my/photos', requireAuth, async (req, res) => {
    try {
      const { public_id } = req.body || {};
      if (!public_id) return res.status(400).json({ error: 'Which photo?' });
      const id = req.session.vendorId;
      const vendor = await db.one('SELECT photos, featured_image FROM vendors WHERE id=$1', [id]);
      let photos = vendor.photos || [];
      const removed = photos.find(p => p.public_id === public_id);
      photos = photos.filter(p => p.public_id !== public_id);

      if (cloudinary && removed) {
        try { await cloudinary.uploader.destroy(public_id); } catch (e) { /* ignore cloud delete errors */ }
      }

      // If we removed the featured photo, fall back to the first remaining (or null)
      let featured = vendor.featured_image;
      if (removed && vendor.featured_image === removed.url) {
        featured = photos[0] ? photos[0].url : null;
      }
      await db.query('UPDATE vendors SET photos=$1, featured_image=$2 WHERE id=$3',
        [JSON.stringify(photos), featured, id]);
      res.json({ success: true, photos, featuredImage: featured });
    } catch (e) {
      console.error('photo delete error', e);
      res.status(500).json({ error: 'Could not delete photo.' });
    }
  });

  // Choose which photo is featured (shows on their card)
  app.put('/api/my/photos/featured', requireAuth, async (req, res) => {
    try {
      const { url } = req.body || {};
      const id = req.session.vendorId;
      const vendor = await db.one('SELECT photos FROM vendors WHERE id=$1', [id]);
      const photos = vendor.photos || [];
      if (!photos.some(p => p.url === url)) return res.status(400).json({ error: 'That photo is not in your gallery.' });
      await db.query('UPDATE vendors SET featured_image=$1 WHERE id=$2', [url, id]);
      res.json({ success: true, featuredImage: url });
    } catch (e) {
      console.error('set featured error', e);
      res.status(500).json({ error: 'Could not set featured photo.' });
    }
  });

  // ============ BOOKINGS ============
  app.post('/api/bookings', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.vendorId) return res.status(400).json({ error: 'vendorId is required.' });
      const vendor = await db.one('SELECT id,name,email FROM vendors WHERE id=$1', [b.vendorId]);
      if (!vendor) return res.status(404).json({ error: 'That vendor does not exist.' });

      const id = uuidv4();
      await db.query(`
        INSERT INTO bookings (id,vendor_id,customer_name,customer_email,event_type,event_date,message,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'new')
      `, [id, b.vendorId, b.customerName || '', b.customerEmail || '', b.eventType || '', b.eventDate || '', b.message || '']);

      // Notify the vendor by email if they have one
      if (vendor.email) {
        const dashUrl = SITE_URL ? `${SITE_URL}/dashboard` : '#';
        sendEmail(
          vendor.email,
          `New quote request from ${b.customerName || 'a customer'}`,
          brandedEmail({
            heading: 'You have a new quote request',
            intro: `${escapeHtml(b.customerName || 'A customer')} is interested in your services on Vendor2Me.`,
            rows: [
              ['From', `${escapeHtml(b.customerName || '—')}`],
              ['Email', `${escapeHtml(b.customerEmail || '—')}`],
              ['Event', `${escapeHtml(b.eventType || '—')}${b.eventDate ? ' &middot; ' + escapeHtml(b.eventDate) : ''}`],
              ['Message', `${escapeHtml(b.message || '—')}`]
            ],
            buttonText: 'View & reply in your dashboard',
            buttonUrl: dashUrl
          })
        );
      }

      res.status(201).json({ success: true, booking: { id, vendorId: b.vendorId, status: 'new' } });
    } catch (e) {
      console.error('booking error', e);
      res.status(500).json({ error: 'Could not send request.' });
    }
  });

  // A vendor's own bookings (must be logged in)
  app.get('/api/my/bookings', requireAuth, async (req, res) => {
    const rows = await db.query('SELECT * FROM bookings WHERE vendor_id=$1 ORDER BY created_at DESC', [req.session.vendorId]);
    res.json(rows.map(r => ({
      id: r.id, customerName: r.customer_name, customerEmail: r.customer_email,
      eventType: r.event_type, eventDate: r.event_date, message: r.message,
      status: r.status, createdAt: r.created_at
    })));
  });

  // Update a booking's status (must own it)
  app.put('/api/my/bookings/:id/status', requireAuth, async (req, res) => {
    const { status } = req.body || {};
    const allowed = ['new', 'replied', 'booked', 'declined'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const owned = await db.one('SELECT id FROM bookings WHERE id=$1 AND vendor_id=$2', [req.params.id, req.session.vendorId]);
    if (!owned) return res.status(404).json({ error: 'Request not found.' });
    await db.query('UPDATE bookings SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ success: true });
  });

  // ============ PAGES ============
  app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.listen(PORT, () => console.log(`Vendor2Me running on http://localhost:${PORT}`));
})();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Branded HTML email matching the Vendor2Me navy + orange identity.
function brandedEmail({ heading, intro, rows, buttonText, buttonUrl }) {
  const detailRows = (rows || []).map(([label, value]) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eef0f3;color:#7a8494;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;width:110px;vertical-align:top;">${label}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eef0f3;color:#1f2733;font-size:15px;vertical-align:top;">${value}</td>
    </tr>`).join('');

  const button = (buttonText && buttonUrl && buttonUrl !== '#') ? `
    <tr><td style="padding:28px 0 8px;">
      <a href="${buttonUrl}" style="display:inline-block;background:#E0A010;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:14px;">${buttonText}</a>
    </td></tr>` : '';

  return `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
          <!-- Header -->
          <tr><td style="background:linear-gradient(135deg,#1C043A,#400880);padding:28px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="background:#ffffff;width:40px;height:40px;border-radius:10px;text-align:center;vertical-align:middle;font-weight:800;font-size:16px;color:#400880;">V<span style="color:#E0A010;">2</span>M</td>
              <td style="padding-left:12px;color:#ffffff;font-size:20px;font-weight:700;">Vendor<span style="color:#E0A010;">2</span>Me</td>
            </tr></table>
          </td></tr>
          <!-- Body -->
          <tr><td style="padding:36px 32px;">
            <h1 style="margin:0 0 8px;font-size:22px;color:#1C043A;font-weight:700;">${heading}</h1>
            <p style="margin:0 0 24px;color:#5a6473;font-size:15px;line-height:1.5;">${intro}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${detailRows}
              ${button}
            </table>
          </td></tr>
          <!-- Footer -->
          <tr><td style="padding:24px 32px;background:#fafbfc;border-top:1px solid #eef0f3;">
            <p style="margin:0;color:#9aa3b0;font-size:12px;line-height:1.5;">You're receiving this because you have a vendor account on Vendor2Me.com &mdash; your event, your culture, your vendors.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
  </html>`;
}
