// db.js — PostgreSQL data layer for Vendor2Me.
// Connects using the DATABASE_URL environment variable (set on Render).
// Creates tables on first run and seeds starter vendors.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost'))
    ? false
    : { rejectUnauthorized: false }
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function one(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

async function init() {
  await query(`
    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT,
      email TEXT UNIQUE,
      password_hash TEXT,
      category TEXT NOT NULL,
      city TEXT, state TEXT, zip TEXT,
      service_radius INTEGER DEFAULT 50,
      rating REAL DEFAULT 5.0,
      reviews INTEGER DEFAULT 0,
      price_min INTEGER DEFAULT 0,
      price_max INTEGER DEFAULT 0,
      price_unit TEXT DEFAULT 'per event',
      cultural_specialties JSONB DEFAULT '[]',
      languages JSONB DEFAULT '[]',
      years_in_business INTEGER DEFAULT 0,
      verified BOOLEAN DEFAULT false,
      availability TEXT DEFAULT 'medium',
      tags JSONB DEFAULT '[]',
      image TEXT,
      bio TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      customer_name TEXT,
      customer_email TEXT,
      event_type TEXT,
      event_date TEXT,
      message TEXT,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_bookings_vendor ON bookings(vendor_id);`);

  // Add columns if upgrading from an older schema (safe no-ops if they exist)
  await query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS email TEXT;`);
  await query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS password_hash TEXT;`);

  const countRow = await one('SELECT COUNT(*)::int AS n FROM vendors');
  if (countRow.n === 0) {
    const starter = [
      ['v1','Mama Akosua Catering','Akosua Mensah','Catering','Newark','NJ','07102',80,4.98,142,18,48,'per person',['Ghanaian','Nigerian','West African','Multicultural'],['English','Twi'],12,true,'high',['jollof','traditional','large-events'],'https://picsum.photos/id/64/600/400','Authentic West African cuisine for weddings, funerals, and celebrations. Famous for our jollof rice and ability to cater large traditional events.'],
      ['v2','Kofi Lens Studio','Kofi Boateng','Photography','Houston','TX','77001',150,4.95,203,750,2500,'per event',['Ghanaian','Nigerian','Caribbean'],['English'],8,true,'medium',['wedding','traditional','drone'],'https://picsum.photos/id/201/600/400','Cinematic photography and drone coverage for traditional weddings and cultural ceremonies across Texas and beyond.'],
      ['v3','DJ Kwame Sounds','Kwame Osei','DJ','Atlanta','GA','30301',100,4.89,315,550,1800,'per event',['West African','Caribbean','African American'],['English','Twi','Yoruba'],15,true,'high',['high-energy','traditional-music','afrobeats'],'https://picsum.photos/id/180/600/400','Afrobeats, highlife, dancehall and more. 15 years keeping dance floors full at weddings and parties across the Southeast.'],
      ['v4',"Nana's Decor Co.",'Nana Adjei','Decor','Chicago','IL','60601',75,4.92,65,1200,6000,'per event',['Ghanaian','Nigerian','Multicultural'],['English','Twi'],6,true,'medium',['kente','floral','luxury'],'https://picsum.photos/id/251/600/400','Stunning event decor blending traditional kente and modern elegance. We transform venues for weddings and milestone celebrations.'],
      ['v5','Adaeze Makeup Artistry','Adaeze Okafor','Makeup','Bowie','MD','20715',60,4.97,98,120,450,'per person',['Nigerian','West African','Caribbean'],['English','Igbo'],7,true,'high',['bridal','gele','glam'],'https://picsum.photos/id/338/600/400','Bridal glam and expert gele tying for your special day. Making brides radiant across the DMV area.'],
      ['v6','Royal Ankara Fashions','Yaa Asantewaa','Fashion','Newark','NJ','07103',200,4.9,54,150,900,'per outfit',['Ghanaian','Nigerian','West African','Multicultural'],['English','Twi'],10,true,'medium',['ankara','kente','custom','family-sets'],'https://picsum.photos/id/823/600/400','Custom Ankara and kente outfits for the whole family. Coordinated family sets for weddings, funerals, and naming ceremonies.']
    ];
    for (const v of starter) {
      await query(`
        INSERT INTO vendors (id,name,owner,category,city,state,zip,service_radius,rating,reviews,price_min,price_max,price_unit,cultural_specialties,languages,years_in_business,verified,availability,tags,image,bio)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      `, [v[0],v[1],v[2],v[3],v[4],v[5],v[6],v[7],v[8],v[9],v[10],v[11],v[12],JSON.stringify(v[13]),JSON.stringify(v[14]),v[15],v[16],v[17],JSON.stringify(v[18]),v[19],v[20]]);
    }
    console.log('Seeded ' + starter.length + ' starter vendors into Postgres.');
  }

  console.log('Database ready.');
  return { query, one, pool };
}

module.exports = init();
