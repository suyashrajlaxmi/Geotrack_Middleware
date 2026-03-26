// ============================================
// ROBUST GEOCODING WITH MULTIPLE FALLBACKS
// ============================================

import { pool } from "../db.js";
import { GOOGLE_MAPS_API_KEY } from "../config/constants.js";

let isGeocoding = false;

export async function startBackgroundGeocode() {
  if (isGeocoding) {
    console.log("⚠️ Geocoding already in progress, skipping...");
    return;
  }

  if (!GOOGLE_MAPS_API_KEY) {
    console.log("⚠️ No Google Maps API key found, skipping geocoding");
    return;
  }

  console.log("🌍 Starting intelligent background geocoding...");
  
  setImmediate(() => {
    geocodeClientsInBackground().catch(err => {
      console.error("❌ Background geocoding job failed:", err);
      isGeocoding = false;
    });
  });
}

async function geocodeClientsInBackground() {
  if (isGeocoding) return;
  isGeocoding = true;

  const startTime = Date.now();
  let processed = 0;
  let updated = 0;
  let failed = 0;
  let skippedForeign = 0;
  const failures = [];

  try {
    // Find clients missing lat/lon (ONLY Indian addresses)
    const result = await pool.query(`
      SELECT id, name, address, pincode
      FROM clients
      WHERE (latitude IS NULL OR longitude IS NULL)
        AND (address IS NOT NULL OR pincode IS NOT NULL)
        AND (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$')
      ORDER BY 
        CASE 
          WHEN pincode IS NOT NULL AND pincode ~ '^[1-9][0-9]{5}$' THEN 1
          WHEN address ~ '[1-9][0-9]{5}' THEN 2
          ELSE 3 
        END,
        id DESC
      LIMIT 1000
    `);

    const clientsToGeocode = result.rows;
    
    if (clientsToGeocode.length === 0) {
      console.log("✅ No clients need geocoding");
      isGeocoding = false;
      return;
    }

    console.log(`🔍 Found ${clientsToGeocode.length} clients needing geocoding\n`);

    const BATCH_SIZE = 3;
    const DELAY_BETWEEN_BATCHES = 1500;
    
    for (let i = 0; i < clientsToGeocode.length; i += BATCH_SIZE) {
      const batch = clientsToGeocode.slice(i, i + BATCH_SIZE);
      
      for (const client of batch) {
        // Validate pincode is Indian
        const isIndianPincode = !client.pincode || /^[1-9][0-9]{5}$/.test(client.pincode);
        
        if (!isIndianPincode) {
          skippedForeign++;
          console.log(`   ⏭️  [${processed + 1}/${clientsToGeocode.length}] ${client.name} - Foreign address`);
          processed++;
          continue;
        }

        const result = await geocodeSingleClientWithStrategies(client);
        
        processed++;
        
        if (result.success) {
          updated++;
          console.log(`   ✅ [${processed}/${clientsToGeocode.length}] ${client.name} → ${result.strategy}`);
        } else {
          failed++;
          failures.push({
            id: client.id,
            name: client.name,
            address: client.address,
            pincode: client.pincode,
            error: result.error
          });
          console.log(`   ❌ [${processed}/${clientsToGeocode.length}] ${client.name} → ${result.error}`);
        }
        
        await sleep(300);
      }
      
      const progress = ((processed / clientsToGeocode.length) * 100).toFixed(1);
      console.log(`\n📊 Progress: ${progress}% | Updated: ${updated} | Failed: ${failed} | Skipped: ${skippedForeign}\n`);
      
      if (i + BATCH_SIZE < clientsToGeocode.length) {
        await sleep(DELAY_BETWEEN_BATCHES);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Geocoding completed in ${duration}s`);
    console.log(`   📊 Total: ${processed}`);
    console.log(`   ✅ Success: ${updated} (${((updated/processed)*100).toFixed(1)}%)`);
    console.log(`   ❌ Failed: ${failed} (${((failed/processed)*100).toFixed(1)}%)`);
    console.log(`   ⏭️  Skipped (foreign): ${skippedForeign}`);

    if (failures.length > 0) {
      console.log(`\n⚠️ Failed addresses (sample):`);
      failures.slice(0, 10).forEach(f => {
        console.log(`   - ${f.name}: ${f.address?.substring(0, 50)}... (PIN: ${f.pincode || 'N/A'})`);
      });
      
      await saveFailedGeocodingAttempts(failures);
    }

  } catch (error) {
    console.error("❌ Background geocoding error:", error);
  } finally {
    isGeocoding = false;
  }
}

/**
 * Try multiple geocoding strategies in order of reliability
 */
async function geocodeSingleClientWithStrategies(client) {
  if (!GOOGLE_MAPS_API_KEY) {
    return { success: false, error: "No API key configured" };
  }

  // Extract and validate pincode
  let pincode = client.pincode || extractPincodeFromAddress(client.address);
  
  // Validate pincode is Indian format
  if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) {
    pincode = null;
  }

  // =============================================
  // STRATEGY 1: FULL ADDRESS (Most Accurate)
  // =============================================
  if (client.address && client.address.length > 10) {
    const fullAddress = pincode 
      ? `${client.address}, ${pincode}, India`
      : `${client.address}, India`;
      
    const result = await tryGeocode(fullAddress);
    if (result.success) {
      const finalPincode = result.pincode || pincode;
      await updateClientLocation(client.id, result.latitude, result.longitude, finalPincode);
      return { success: true, strategy: "Full Address", ...result };
    }
  }

  // =============================================
  // STRATEGY 2: SIMPLIFIED ADDRESS
  // =============================================
  if (client.address) {
    const simplified = simplifyAddress(client.address);
    if (simplified && simplified !== client.address) {
      const query = pincode ? `${simplified}, ${pincode}, India` : `${simplified}, India`;
      const result = await tryGeocode(query);
      if (result.success) {
        const finalPincode = result.pincode || pincode;
        await updateClientLocation(client.id, result.latitude, result.longitude, finalPincode);
        return { success: true, strategy: "Simplified Address", ...result };
      }
    }
  }

  // =============================================
  // STRATEGY 3: CITY + PINCODE
  // =============================================
  if (client.address && pincode) {
    const city = extractCityFromAddress(client.address);
    if (city) {
      const cityPinQuery = `${city}, ${pincode}, India`;
      const result = await tryGeocode(cityPinQuery);
      if (result.success) {
        await updateClientLocation(client.id, result.latitude, result.longitude, pincode);
        return { success: true, strategy: "City + Pincode", ...result };
      }
    }
  }

  // =============================================
  // STRATEGY 4: AREA + PINCODE
  // =============================================
  if (client.address && pincode) {
    const area = extractAreaFromAddress(client.address);
    if (area) {
      const areaPinQuery = `${area}, ${pincode}, India`;
      const result = await tryGeocode(areaPinQuery);
      if (result.success) {
        await updateClientLocation(client.id, result.latitude, result.longitude, pincode);
        return { success: true, strategy: "Area + Pincode", ...result };
      }
    }
  }

  // =============================================
  // STRATEGY 5: PINCODE ONLY (Fallback)
  // =============================================
  if (pincode) {
    const result = await tryGeocode(`${pincode}, India`);
    if (result.success) {
      await updateClientLocation(client.id, result.latitude, result.longitude, pincode);
      return { success: true, strategy: "Pincode Only", ...result };
    }
  }

  // =============================================
  // ALL STRATEGIES FAILED
  // =============================================
  return { 
    success: false, 
    error: pincode ? "All geocoding strategies failed" : "No valid pincode or address",
    clientId: client.id
  };
}

/**
 * Try geocoding a single address
 */
async function tryGeocode(address) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=in&key=${GOOGLE_MAPS_API_KEY}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.status === 'OVER_QUERY_LIMIT') {
      console.log(`   ⏳ Rate limit hit, waiting...`);
      await sleep(3000);
      return { success: false, error: 'OVER_QUERY_LIMIT' };
    }
    
    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      return { success: false, error: data.status || 'NO_RESULTS' };
    }

    const result = data.results[0];
    const location = result.geometry.location;
    
    // Validate coordinates are in India
    const latitude = location.lat;
    const longitude = location.lng;
    
    if (latitude < 6 || latitude > 37 || longitude < 68 || longitude > 98) {
      return { success: false, error: 'COORDINATES_OUT_OF_INDIA' };
    }
    
    // Extract pincode from result
    const components = result.address_components;
    const pincodeComponent = components.find(c => 
      c.types.includes('postal_code')
    );
    const pincode = pincodeComponent?.long_name || null;

    return { 
      success: true,
      latitude,
      longitude,
      pincode,
      formattedAddress: result.formatted_address
    };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function updateClientLocation(clientId, latitude, longitude, pincode) {
  await pool.query(
    `UPDATE clients 
     SET latitude = $1, 
         longitude = $2, 
         pincode = COALESCE(pincode, $3),
         updated_at = NOW()
     WHERE id = $4`,
    [latitude, longitude, pincode, clientId]
  );
}

function extractPincodeFromAddress(address) {
  if (!address) return null;
  
  const matches = address.match(/\b[1-9][0-9]{5}\b/g);
  if (!matches || matches.length === 0) return null;
  
  return matches[matches.length - 1];
}

function extractCityFromAddress(address) {
  if (!address) return null;
  
  const majorCities = [
    'Mumbai', 'Delhi', 'Bangalore', 'Bengaluru', 'Hyderabad', 'Ahmedabad', 
    'Chennai', 'Kolkata', 'Pune', 'Jaipur', 'Surat', 'Lucknow', 'Kanpur',
    'Nagpur', 'Indore', 'Thane', 'Bhopal', 'Visakhapatnam', 'Pimpri', 'Patna',
    'Vadodara', 'Ghaziabad', 'Ludhiana', 'Agra', 'Nashik', 'Faridabad',
    'Meerut', 'Rajkot', 'Varanasi', 'Srinagar', 'Aurangabad', 'Dhanbad',
    'Amritsar', 'Navi Mumbai', 'Allahabad', 'Prayagraj', 'Ranchi', 'Howrah', 
    'Coimbatore', 'Jabalpur', 'Gwalior', 'Vijayawada', 'Jodhpur', 'Madurai', 
    'Raipur', 'Kota', 'Guwahati', 'Chandigarh', 'Solapur', 'Hubli', 'Bareilly',
    'Moradabad', 'Mysore', 'Mysuru', 'Gurgaon', 'Gurugram', 'Aligarh', 
    'Jalandhar', 'Noida', 'Panvel', 'Nanded', 'Kolhapur', 'Ajmer', 'Akola'
  ];
  
  for (const city of majorCities) {
    const regex = new RegExp(`\\b${city}\\b`, 'i');
    if (regex.test(address)) {
      return city;
    }
  }
  
  return null;
}

function extractAreaFromAddress(address) {
  if (!address) return null;
  
  const areaPatterns = [
    /(?:near|opp|opposite)\s+([A-Za-z\s]+?)(?:,|\.|\s+\d)/i,
    /([A-Za-z\s]+?)\s+(?:industrial\s+)?(?:estate|road|rd|nagar|colony|area|sector|park|complex)/i,
  ];
  
  for (const pattern of areaPatterns) {
    const match = address.match(pattern);
    if (match && match[1]) {
      const area = match[1].trim();
      if (area.length > 3) {
        return area;
      }
    }
  }
  
  return null;
}

function simplifyAddress(address) {
  if (!address) return null;
  
  let simplified = address;
  
  simplified = simplified.replace(/\b(shop|flat|unit|office|room|plot|floor|wing|block)\s*(no\.?|number|#)?\s*[a-z0-9\-\/]+,?\s*/gi, '');
  simplified = simplified.replace(/\b\d{10}\b/g, '');
  simplified = simplified.replace(/\+?\d{1,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/g, '');
  simplified = simplified.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  simplified = simplified.replace(/\b(mr|ms|mrs|shri|smt|m\/s|dr)\s+[a-z\s]+,?\s*/gi, '');
  simplified = simplified.replace(/,+/g, ',').replace(/\s+/g, ' ').trim();
  simplified = simplified.replace(/^,+|,+$/g, '').trim();
  
  return simplified.length > 10 ? simplified : null;
}

async function saveFailedGeocodingAttempts(failures) {
  try {
    for (const failure of failures) {
      await pool.query(
        `INSERT INTO geocoding_failures (client_id, address, pincode, error, attempted_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (client_id) DO UPDATE 
         SET attempted_at = NOW(), error = $4, attempt_count = geocoding_failures.attempt_count + 1`,
        [failure.id, failure.address, failure.pincode, failure.error]
      );
    }
    console.log(`\n💾 Saved ${failures.length} failed attempts to database`);
  } catch (error) {
    console.error("Failed to save geocoding failures:", error);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retryFailedGeocodings() {
  console.log("🔄 Retrying failed geocoding attempts...");
  
  const result = await pool.query(`
    SELECT c.id, c.name, c.address, c.pincode
    FROM clients c
    INNER JOIN geocoding_failures gf ON c.id = gf.client_id
    WHERE c.latitude IS NULL 
      AND gf.attempt_count < 3
      AND gf.attempted_at < NOW() - INTERVAL '1 day'
      AND (c.pincode IS NULL OR c.pincode ~ '^[1-9][0-9]{5}$')
    LIMIT 100
  `);
  
  console.log(`Found ${result.rows.length} clients to retry`);
  
  for (const client of result.rows) {
    const geocodeResult = await geocodeSingleClientWithStrategies(client);
    
    if (geocodeResult.success) {
      console.log(`✅ Retry success: ${client.name}`);
      await pool.query(`DELETE FROM geocoding_failures WHERE client_id = $1`, [client.id]);
    } else {
      console.log(`❌ Retry failed: ${client.name}`);
    }
    
    await sleep(500);
  }
}