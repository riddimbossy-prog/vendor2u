// server.js — Vendor2U server: website + API + vendor accounts + dashboard + email.
// Backed by PostgreSQL (see db.js). Reads config from environment variables.

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

// Render (and most hosts) put the app behind a proxy. This tells Express to trust
// it, so it correctly treats HTTPS connections as secure and sets session cookies.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// NOTE: session middleware is set up inside the async block below, once the
// database pool is ready, so sessions can be stored in Postgres (surviving restarts).

// --- Optional email (Resend). Works without it; just logs if not configured. ---
let resend = null;
if (process.env.RESEND_API_KEY) {
  const { Resend } = require('resend');
  resend = new Resend(process.env.RESEND_API_KEY);
}
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
    image: row.image, bio: row.bio
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
  app.post('/api/auth/signup', async (req, res) => {
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

  app.post('/api/auth/login', async (req, res) => {
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
  app.get('/api/health', (req, res) => res.json({ status: 'OK', message: 'Vendor2U Backend Running' }));

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
        const dashLink = SITE_URL ? `${SITE_URL}/dashboard` : 'your Vendor2U dashboard';
        sendEmail(vendor.email, `New quote request from ${b.customerName || 'a customer'}`,
          `<h2>New quote request on Vendor2U</h2>
           <p><b>From:</b> ${escapeHtml(b.customerName || '')} (${escapeHtml(b.customerEmail || '')})</p>
           <p><b>Event:</b> ${escapeHtml(b.eventType || '')} ${escapeHtml(b.eventDate || '')}</p>
           <p><b>Message:</b><br>${escapeHtml(b.message || '')}</p>
           <p>Log in to ${dashLink} to reply.</p>`);
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

  app.listen(PORT, () => console.log(`Vendor2U running on http://localhost:${PORT}`));
})();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
