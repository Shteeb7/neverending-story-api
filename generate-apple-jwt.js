/**
 * Generate Apple Sign-In JWT for Supabase
 *
 * Usage:
 *   node generate-apple-jwt.js <path-to-p8-file> <key-id> <team-id>
 *
 * Example:
 *   node generate-apple-jwt.js ~/Downloads/AuthKey_ABC123XYZ4.p8 ABC123XYZ4 DEF456ABC7
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');

// Get command line arguments
const args = process.argv.slice(2);

if (args.length < 3) {
  console.error('❌ Missing arguments!');
  console.error('');
  console.error('Usage:');
  console.error('  node generate-apple-jwt.js <path-to-p8-file> <key-id> <team-id>');
  console.error('');
  console.error('Example:');
  console.error('  node generate-apple-jwt.js ~/Downloads/AuthKey_ABC123XYZ4.p8 ABC123XYZ4 DEF456ABC7');
  console.error('');
  console.error('Where:');
  console.error('  - path-to-p8-file: Path to the .p8 key file you downloaded');
  console.error('  - key-id: 10-character Key ID from Apple Developer');
  console.error('  - team-id: 10-character Team ID from Apple Developer');
  process.exit(1);
}

const [p8FilePath, keyId, teamId] = args;
const clientId = 'com.neverendingstory.NeverendingStory'; // Your Bundle ID

// Read the .p8 private key
let privateKey;
try {
  privateKey = fs.readFileSync(p8FilePath, 'utf8');
  console.log('✅ Read .p8 file successfully');
} catch (error) {
  console.error('❌ Error reading .p8 file:', error.message);
  process.exit(1);
}

// Generate JWT
try {
  const now = Math.floor(Date.now() / 1000);
  const expiration = now + (86400 * 180); // 180 days (6 months)

  const token = jwt.sign(
    {
      iss: teamId,           // Issuer (Team ID)
      iat: now,              // Issued at
      exp: expiration,       // Expiration (6 months)
      aud: 'https://appleid.apple.com',
      sub: clientId          // Subject (Bundle ID)
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: {
        kid: keyId,          // Key ID
        alg: 'ES256'
      }
    }
  );

  console.log('');
  console.log('✅ JWT Generated Successfully!');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Copy this JWT and paste it into Supabase:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(token);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('⚠️  This JWT expires in 6 months');
  console.log('    You\'ll need to regenerate it before it expires');
  console.log('');
} catch (error) {
  console.error('❌ Error generating JWT:', error.message);
  process.exit(1);
}
