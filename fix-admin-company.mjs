// fix-admin-company.mjs — Run: node fix-admin-company.mjs
// Moves admin@test.com to Default Company (the one with 1924 clients)

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: 'postgresql://geotrackdb_user:gDBJB8LnmVT6UrIwKwv7uI13LH9BPMGp@dpg-d4rqmoc9c44c738du6dg-a.singapore-postgres.render.com/geotrackdb',
  ssl: { rejectUnauthorized: false }
});

try {
  console.log('Checking current state...');

  // Confirm Default Company has 1924 clients
  const clients = await pool.query(
    'SELECT COUNT(*) as cnt FROM clients WHERE company_id = $1',
    ['d9740a4d-e20c-4964-b89b-cb1ae4015c92']
  );
  console.log('Default Company clients:', clients.rows[0].cnt);

  // Move admin@test.com to Default Company
  const r = await pool.query(`
    UPDATE users 
    SET company_id = 'd9740a4d-e20c-4964-b89b-cb1ae4015c92'
    WHERE email = 'admin@test.com'
    RETURNING id, email, company_id
  `);

  console.log('✅ admin@test.com moved to Default Company');
  console.log('   user id:    ', r.rows[0].id);
  console.log('   email:      ', r.rows[0].email);
  console.log('   company_id: ', r.rows[0].company_id);
  console.log('');
  console.log('Now login at https://dashboard.geo-track.org/login');
  console.log('Email: admin@test.com');
  console.log('Password: 123456');
  console.log('You should see 1924 clients again.');

} catch(e) {
  console.error('❌ Error:', e.message);
} finally {
  await pool.end();
}
