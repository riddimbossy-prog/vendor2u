// db.js — Pure-JavaScript SQLite (sql.js). No native compilation needed, so it
// installs and runs on any host. Data is saved to a file so it survives restarts.

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbFile = process.env.DB_PATH || path.join(__dirname, 'vendor2u.db');

// sql.js loads asynchronously; we expose a ready promise the server awaits.
let db;

// A tiny wrapper so the rest of the app can use a better-sqlite3-style API:
//   db.prepare(sql).get(params) / .all(params) / .run(params)
function wrap(rawDb) {
  function persist() {
    const data = rawDb.export();
    fs.writeFileSync(dbFile, Buffer.from(data));
  }

  return {
    _raw: rawDb,
    persist,
    exec(sql) { rawDb.exec(sql); persist(); },
    prepare(sql) {
      return {
        get(params) {
          const stmt = rawDb.prepare(sql);
          if (params !== undefined) stmt.bind(params);
          let row = null;
          if (stmt.step()) row = stmt.getAsObject();
          stmt.free();
          return row;
        },
        all(params) {
          const stmt = rawDb.prepare(sql);
          if (params !== undefined) stmt.bind(params);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
          return rows;
        },
        run(params) {
          const stmt = rawDb.prepare(sql);
          if (params !== undefined) stmt.bind(params);
          stmt.step();
          stmt.free();
          persist();
          return {};
        }
      };
    }
  };
}

async function init() {
  const SQL = await initSqlJs();

  let rawDb;
  if (fs.existsSync(dbFile)) {
    const fileBuffer = fs.readFileSync(dbFile);
    rawDb = new SQL.Database(fileBuffer);
  } else {
    rawDb = new SQL.Database();
  }

  db = wrap(rawDb);

  db.exec(`
    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT, category TEXT NOT NULL,
      city TEXT, state TEXT, zip TEXT, serviceRadius INTEGER DEFAULT 50,
      rating REAL DEFAULT 5.0, reviews INTEGER DEFAULT 0,
      priceMin INTEGER DEFAULT 0, priceMax INTEGER DEFAULT 0, priceUnit TEXT DEFAULT 'total',
      culturalSpecialties TEXT DEFAULT '[]', languages TEXT DEFAULT '[]',
      yearsInBusiness INTEGER DEFAULT 0, verified INTEGER DEFAULT 0,
      availability TEXT DEFAULT 'medium', tags TEXT DEFAULT '[]',
      image TEXT, bio TEXT, createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, vendorId TEXT NOT NULL, customerName TEXT, customerEmail TEXT,
      eventType TEXT, eventDate TEXT, message TEXT, status TEXT DEFAULT 'pending',
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const count = db.prepare('SELECT COUNT(*) AS n FROM vendors').get().n;
  if (count === 0) {
    const starterVendors = [
      { id:'v1', name:'Mama Akosua Catering', owner:'Akosua Mensah', category:'Catering', city:'Newark', state:'NJ', zip:'07102', serviceRadius:80, rating:4.98, reviews:142, priceMin:18, priceMax:48, priceUnit:'per person', culturalSpecialties:['Ghanaian','Nigerian','West African','Multicultural'], languages:['English','Twi'], yearsInBusiness:12, verified:1, availability:'high', tags:['jollof','traditional','large-events'], image:'https://picsum.photos/id/64/600/400', bio:'Authentic West African cuisine for weddings, funerals, and celebrations. Famous for our jollof rice and ability to cater large traditional events.' },
      { id:'v2', name:'Kofi Lens Studio', owner:'Kofi Boateng', category:'Photography', city:'Houston', state:'TX', zip:'77001', serviceRadius:150, rating:4.95, reviews:203, priceMin:750, priceMax:2500, priceUnit:'per event', culturalSpecialties:['Ghanaian','Nigerian','Caribbean'], languages:['English'], yearsInBusiness:8, verified:1, availability:'medium', tags:['wedding','traditional','drone'], image:'https://picsum.photos/id/201/600/400', bio:'Cinematic photography and drone coverage for traditional weddings and cultural ceremonies across Texas and beyond.' },
      { id:'v3', name:'DJ Kwame Sounds', owner:'Kwame Osei', category:'DJ', city:'Atlanta', state:'GA', zip:'30301', serviceRadius:100, rating:4.89, reviews:315, priceMin:550, priceMax:1800, priceUnit:'per event', culturalSpecialties:['West African','Caribbean','African American'], languages:['English','Twi','Yoruba'], yearsInBusiness:15, verified:1, availability:'high', tags:['high-energy','traditional-music','afrobeats'], image:'https://picsum.photos/id/180/600/400', bio:'Afrobeats, highlife, dancehall and more. 15 years keeping dance floors full at weddings and parties across the Southeast.' },
      { id:'v4', name:"Nana's Decor Co.", owner:'Nana Adjei', category:'Decor', city:'Chicago', state:'IL', zip:'60601', serviceRadius:75, rating:4.92, reviews:65, priceMin:1200, priceMax:6000, priceUnit:'per event', culturalSpecialties:['Ghanaian','Nigerian','Multicultural'], languages:['English','Twi'], yearsInBusiness:6, verified:1, availability:'medium', tags:['kente','floral','luxury'], image:'https://picsum.photos/id/251/600/400', bio:'Stunning event decor blending traditional kente and modern elegance. We transform venues for weddings and milestone celebrations.' },
      { id:'v5', name:'Adaeze Makeup Artistry', owner:'Adaeze Okafor', category:'Makeup', city:'Bowie', state:'MD', zip:'20715', serviceRadius:60, rating:4.97, reviews:98, priceMin:120, priceMax:450, priceUnit:'per person', culturalSpecialties:['Nigerian','West African','Caribbean'], languages:['English','Igbo'], yearsInBusiness:7, verified:1, availability:'high', tags:['bridal','gele','glam'], image:'https://picsum.photos/id/338/600/400', bio:'Bridal glam and expert gele tying for your special day. Making brides radiant across the DMV area.' },
      { id:'v6', name:'Royal Ankara Fashions', owner:'Yaa Asantewaa', category:'Fashion', city:'Newark', state:'NJ', zip:'07103', serviceRadius:200, rating:4.9, reviews:54, priceMin:150, priceMax:900, priceUnit:'per outfit', culturalSpecialties:['Ghanaian','Nigerian','West African','Multicultural'], languages:['English','Twi'], yearsInBusiness:10, verified:1, availability:'medium', tags:['ankara','kente','custom','family-sets'], image:'https://picsum.photos/id/823/600/400', bio:'Custom Ankara and kente outfits for the whole family. Coordinated family sets for weddings, funerals, and naming ceremonies.' }
    ];

    const sql = `INSERT INTO vendors (id,name,owner,category,city,state,zip,serviceRadius,rating,reviews,priceMin,priceMax,priceUnit,culturalSpecialties,languages,yearsInBusiness,verified,availability,tags,image,bio) VALUES (@id,@name,@owner,@category,@city,@state,@zip,@serviceRadius,@rating,@reviews,@priceMin,@priceMax,@priceUnit,@culturalSpecialties,@languages,@yearsInBusiness,@verified,@availability,@tags,@image,@bio)`;
    for (const v of starterVendors) {
      db.prepare(sql).run({
        '@id':v.id,'@name':v.name,'@owner':v.owner,'@category':v.category,'@city':v.city,'@state':v.state,'@zip':v.zip,
        '@serviceRadius':v.serviceRadius,'@rating':v.rating,'@reviews':v.reviews,'@priceMin':v.priceMin,'@priceMax':v.priceMax,
        '@priceUnit':v.priceUnit,'@culturalSpecialties':JSON.stringify(v.culturalSpecialties),'@languages':JSON.stringify(v.languages),
        '@yearsInBusiness':v.yearsInBusiness,'@verified':v.verified,'@availability':v.availability,'@tags':JSON.stringify(v.tags),
        '@image':v.image,'@bio':v.bio
      });
    }
    console.log('Seeded ' + starterVendors.length + ' starter vendors.');
  }

  return db;
}

// Export a ready-promise. server.js awaits this before starting.
module.exports = init();
