import { GOOGLE_MAPS_API_KEY } from "../config/constants.js";

export const getPincodeFromCoordinates = async (latitude, longitude) => {
  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&region=in&key=${GOOGLE_MAPS_API_KEY}`
    );
    
    const data = await response.json();
    
    if (data.status === 'OK' && data.results.length > 0) {
      const addressComponents = data.results[0].address_components;
      const pincodeComponent = addressComponents.find(
        component => component.types.includes('postal_code')
      );
      
      const pincode = pincodeComponent?.long_name || null;
      console.log(`📍 Google: (${latitude}, ${longitude}) → Pincode: ${pincode}`);
      return pincode;
    }
    
    console.log(`⚠️ Google API returned: ${data.status}`);
    return null;
  } catch (error) {
    console.error("❌ Google Geocoding error:", error);
    return null;
  }
};

export async function getCoordinatesFromPincode(pincode) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${pincode}&region=in&key=${GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "OK") return null;

    const loc = data.results[0].geometry.location;
    return { latitude: loc.lat, longitude: loc.lng };
  } catch {
    return null;
  }
}

export async function getCoordinatesFromAddress(address) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "OK") return null;

    const loc = data.results[0].geometry.location;
    const components = data.results[0].address_components;
    const pincode = components.find((c) =>
      c.types.includes("postal_code")
    )?.long_name;

    return { latitude: loc.lat, longitude: loc.lng, pincode };
  } catch {
    return null;
  }
}
