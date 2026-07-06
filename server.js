// server.js — Serves the Vendor2U website AND the API from one place.
// Data comes from a real SQLite database (see db.js) so it persists across restarts.

const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function shapeVendor(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, owner: row.owner, category: row.category,
    location: { city: row.city, state: row.state, zip: row.zip },
    serviceRadius: row.serviceRadius, rating: row.rating, reviews: row.reviews,
    priceRange: { min: row.priceMin, max: row.priceMax, unit: row.priceUnit },
    culturalSpecialties: JSON.parse(row.culturalSpecialties || '[]'),
    languages: JSON.parse(row.languages || '[]'),
    yearsInBusiness: row.yearsInBusiness, verified: !!row.verified,
    availability: row.availability, tags: JSON.parse(row.tags || '[]'),
    image: row.image, bio: row.bio
  };
}

function calculateMatchScore(vendor, criteria) {
  let score = 0;
  const weights = { category: 0.30, location: 0.25, cultural: 0.20, rating: 0.15, budget: 0.10 };
  if (criteria.service && vendor.category.toLowerCase().includes(criteria.service.toLowerCase())) score += weights.category * 100;
  const userLoc = (criteria.location || '').toLowerCase();
  if (userLoc && (vendor.location.city.toLowerCase().includes(userLoc) || vendor.location.state.toLowerCase().includes(userLoc))) score += weights.location * 100;
  else if (vendor.serviceRadius > 50) score += weights.location * 60;
  const culturalMatch = criteria.cultural && vendor.culturalSpecialties.some(c => criteria.cultural.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(criteria.cultural.toLowerCase()));
  if (culturalMatch) score += weights.cultural * 100;
  score += (vendor.rating / 5) * weights.rating * 100;
  if (criteria.budget) {
    const midPrice = (vendor.priceRange.min + vendor.priceRange.max) / 2;
    if (midPrice < criteria.budget * 0.8) score += weights.budget * 80;
    else if (midPrice < criteria.budget) score += weights.budget * 50;
  }
  return Math.min(Math.round(score), 98);
}

function generateMatchReason(vendor, criteria, score) {
  const reasons = [];
  if (score > 85) reasons.push('Excellent cultural and service alignment');
  if (vendor.verified) reasons.push('Verified professional');
  if (vendor.rating > 4.7) reasons.push('Highly rated in community');
  if (criteria.cultural && vendor.culturalSpecialties.some(c => criteria.cultural.toLowerCase().includes(c.toLowerCase()))) reasons.push(`Specializes in ${criteria.cultural} traditions`);
  return reasons.length ? reasons : ['Strong overall match'];
}

// db.js exports a promise that resolves to the ready database.
module.exports = (async () => {
  const db = await require('./db');

  app.get('/api/health', (req, res) => res.json({ status: 'OK', message: 'Vendor2U Backend Running' }));

  app.post('/api/match', (req, res) => {
    const { eventType, location, guests, budget, cultural, service } = req.body;
    const criteria = { eventType, location, guests, budget, cultural, service };
    const rows = db.prepare('SELECT * FROM vendors').all();
    const matches = rows.map(shapeVendor).map(v => {
      const matchScore = calculateMatchScore(v, criteria);
      return { ...v, matchScore, matchReason: generateMatchReason(v, criteria, matchScore) };
    }).sort((a, b) => b.matchScore - a.matchScore).slice(0, 8);
    res.json({ success: true, matches, totalVendors: rows.length, criteria });
  });

  app.get('/api/vendors', (req, res) => {
    const { category, state, minRating, q } = req.query;
    let rows = db.prepare('SELECT * FROM vendors').all().map(shapeVendor);
    if (category) rows = rows.filter(v => v.category.toLowerCase() === category.toLowerCase());
    if (state) rows = rows.filter(v => v.location.state.toLowerCase() === state.toLowerCase());
    if (minRating) rows = rows.filter(v => v.rating >= parseFloat(minRating));
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter(v =>
        v.name.toLowerCase().includes(needle) || v.category.toLowerCase().includes(needle) ||
        v.location.city.toLowerCase().includes(needle) || v.location.state.toLowerCase().includes(needle) ||
        v.culturalSpecialties.some(c => c.toLowerCase().includes(needle)) ||
        v.tags.some(t => t.toLowerCase().includes(needle)));
    }
    res.json(rows);
  });

  app.get('/api/vendors/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM vendors WHERE id = @id').get({ '@id': req.params.id });
    if (!row) return res.status(404).json({ error: 'Vendor not found' });
    res.json(shapeVendor(row));
  });

  app.post('/api/vendors', (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.category) return res.status(400).json({ error: 'Business name and category are required.' });
    const v = {
      '@id': uuidv4(), '@name': b.name, '@owner': b.owner || '', '@category': b.category,
      '@city': b.city || '', '@state': b.state || '', '@zip': b.zip || '',
      '@serviceRadius': Number(b.serviceRadius) || 50, '@rating': 5.0, '@reviews': 0,
      '@priceMin': Number(b.priceMin) || 0, '@priceMax': Number(b.priceMax) || 0, '@priceUnit': b.priceUnit || 'per event',
      '@culturalSpecialties': JSON.stringify(b.culturalSpecialties || []), '@languages': JSON.stringify(b.languages || []),
      '@yearsInBusiness': Number(b.yearsInBusiness) || 0, '@verified': 0, '@availability': 'medium',
      '@tags': JSON.stringify(b.tags || []), '@image': b.image || ('https://picsum.photos/seed/' + Date.now() + '/600/400'), '@bio': b.bio || ''
    };
    db.prepare(`INSERT INTO vendors (id,name,owner,category,city,state,zip,serviceRadius,rating,reviews,priceMin,priceMax,priceUnit,culturalSpecialties,languages,yearsInBusiness,verified,availability,tags,image,bio) VALUES (@id,@name,@owner,@category,@city,@state,@zip,@serviceRadius,@rating,@reviews,@priceMin,@priceMax,@priceUnit,@culturalSpecialties,@languages,@yearsInBusiness,@verified,@availability,@tags,@image,@bio)`).run(v);
    const row = db.prepare('SELECT * FROM vendors WHERE id = @id').get({ '@id': v['@id'] });
    res.status(201).json({ success: true, vendor: shapeVendor(row) });
  });

  app.post('/api/bookings', (req, res) => {
    const b = req.body || {};
    if (!b.vendorId) return res.status(400).json({ error: 'vendorId is required.' });
    const vendor = db.prepare('SELECT id FROM vendors WHERE id = @id').get({ '@id': b.vendorId });
    if (!vendor) return res.status(404).json({ error: 'That vendor does not exist.' });
    const booking = {
      '@id': uuidv4(), '@vendorId': b.vendorId, '@customerName': b.customerName || '', '@customerEmail': b.customerEmail || '',
      '@eventType': b.eventType || '', '@eventDate': b.eventDate || '', '@message': b.message || '', '@status': 'pending'
    };
    db.prepare(`INSERT INTO bookings (id,vendorId,customerName,customerEmail,eventType,eventDate,message,status) VALUES (@id,@vendorId,@customerName,@customerEmail,@eventType,@eventDate,@message,@status)`).run(booking);
    res.status(201).json({ success: true, booking: { id: booking['@id'], vendorId: b.vendorId, status: 'pending' } });
  });

  app.get('/api/bookings/vendor/:vendorId', (req, res) => {
    const rows = db.prepare('SELECT * FROM bookings WHERE vendorId = @v ORDER BY createdAt DESC').all({ '@v': req.params.vendorId });
    res.json(rows);
  });

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.listen(PORT, () => console.log(`Vendor2U running on http://localhost:${PORT}`));
})();
