// Token Diagnostic Tool
// Run this to check your token

const token = process.argv[2];

if (!token) {
    console.log('Usage: node diagnose.js "email:pass:token"');
    process.exit(1);
}

console.log('🔍 Analyzing token...\n');

try {
    const parts = token.split(':');
    console.log(`📧 Email: ${parts[0]}`);
    console.log(`🔐 Password: ${'*'.repeat(parts[1].length)}`);
    
    const jwt = parts.slice(2).join(':');
    console.log(`🎫 Token length: ${jwt.length} chars`);
    console.log(`🎫 Token starts with: ${jwt.substring(0, 20)}...`);
    
    // Decode JWT
    const jwtParts = jwt.split('.');
    if (jwtParts.length !== 3) {
        console.error('❌ Invalid JWT structure!');
        process.exit(1);
    }
    
    let payload = jwtParts[1];
    while (payload.length % 4 !== 0) payload += '=';
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    
    console.log('\n📦 Token Contents:');
    console.log(JSON.stringify(decoded, null, 2));
    
    console.log('\n🎮 Minecraft Profile:');
    if (decoded.profiles?.mc) {
        console.log(`   ✅ Java UUID: ${decoded.profiles.mc}`);
    } else {
        console.log('   ❌ NO JAVA PROFILE FOUND');
    }
    
    if (decoded.pfd && decoded.pfd[0]) {
        console.log(`   ✅ Username: ${decoded.pfd[0].name}`);
        console.log(`   ✅ Profile ID: ${decoded.pfd[0].id}`);
    } else {
        console.log('   ❌ NO USERNAME FOUND');
    }
    
    console.log('\n🕐 Expiration:');
    const exp = new Date(decoded.exp * 1000);
    const now = new Date();
    console.log(`   Expires: ${exp.toLocaleString()}`);
    console.log(`   Now: ${now.toLocaleString()}`);
    
    if (exp < now) {
        console.log('   ❌ TOKEN IS EXPIRED!');
    } else {
        const hoursLeft = Math.floor((exp - now) / (1000 * 60 * 60));
        console.log(`   ✅ Valid for ${hoursLeft} more hours`);
    }
    
    console.log('\n🔑 Token Type:');
    if (decoded.xuid) {
        console.log(`   ⚠️  Has XUID: ${decoded.xuid} (Xbox/Bedrock indicator)`);
    }
    if (decoded.iss) {
        console.log(`   Issuer: ${decoded.iss}`);
    }
    if (decoded.auth) {
        console.log(`   Auth type: ${decoded.auth}`);
    }
    
    console.log('\n💡 Recommendation:');
    if (!decoded.profiles?.mc) {
        console.log('   ❌ This token does NOT have a Java Edition profile!');
        console.log('   You need a token from an account that owns Java Edition.');
    } else if (exp < now) {
        console.log('   ❌ Token expired - get a fresh token');
    } else {
        console.log('   ✅ Token looks valid for Java Edition');
        console.log('   Problem must be in how we\'re using it');
    }
    
} catch (e) {
    console.error('❌ Error analyzing token:', e.message);
}
