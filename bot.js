const mineflayer = require('mineflayer');
const express = require('express');
const app = express();

app.use(express.json());

const bots = new Map();

function parseToken(tokenString) {
    try {
        // Handle format: email:password:jwt_token
        const parts = tokenString.split(':');
        
        if (parts.length < 3) {
            throw new Error('Invalid token format. Expected: email:password:token');
        }
        
        const email = parts[0];
        const password = parts[1];
        const accessToken = parts.slice(2).join(':'); // JWT might contain colons
        
        return { email, password, accessToken };
    } catch (e) {
        throw new Error('Token parsing failed: ' + e.message);
    }
}

function decodeJWT(token) {
    try {
        // Remove any whitespace
        token = token.trim();
        
        const parts = token.split('.');
        if (parts.length !== 3) {
            throw new Error('Invalid JWT format');
        }
        
        // Add padding if needed
        let payload = parts[1];
        while (payload.length % 4 !== 0) {
            payload += '=';
        }
        
        const decoded = Buffer.from(payload, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (e) {
        throw new Error('Failed to decode JWT: ' + e.message);
    }
}

async function createBot(botId, host, port, sessionToken) {
    try {
        console.log(`[${botId}] Parsing session token...`);
        const { email, password, accessToken } = parseToken(sessionToken);
        
        console.log(`[${botId}] Decoding JWT...`);
        const tokenData = decodeJWT(accessToken);
        
        console.log(`[${botId}] Token data:`, JSON.stringify(tokenData, null, 2));
        
        // Extract Minecraft profile
        const mcProfile = tokenData.profiles?.mc || tokenData.pfd?.[0]?.id;
        const mcName = tokenData.pfd?.[0]?.name;
        const xuid = tokenData.xuid;
        
        if (!mcName) {
            throw new Error('Token missing Minecraft username');
        }
        
        console.log(`[${botId}] Account: ${mcName}`);
        console.log(`[${botId}] UUID: ${mcProfile}`);
        console.log(`[${botId}] XUID: ${xuid}`);
        
        // Check expiration
        if (tokenData.exp && tokenData.exp * 1000 < Date.now()) {
            throw new Error('Access token has expired');
        }
        
        console.log(`[${botId}] Connecting to ${host}:${port}...`);
        
        const bot = mineflayer.createBot({
            host: host,
            port: port,
            username: mcName,
            auth: 'offline', // Critical: use offline mode
            skipValidation: true,
            version: false,
            hideErrors: false
        });
        
        // Manually inject session after connection
        bot.session = {
            accessToken: accessToken,
            clientToken: xuid || '00000000-0000-0000-0000-000000000000',
            selectedProfile: {
                id: mcProfile || '00000000-0000-0000-0000-000000000000',
                name: mcName
            }
        };
        
        bot.on('login', () => {
            console.log(`✅ [${botId}] Logged in as ${bot.username}`);
        });
        
        bot.on('spawn', () => {
            console.log(`✅ [${botId}] Spawned in game`);
        });
        
        bot.on('error', (err) => {
            console.error(`❌ [${botId}] Error: ${err.message}`);
        });
        
        bot.on('kicked', (reason) => {
            console.log(`❌ [${botId}] Kicked: ${reason}`);
            bots.delete(botId);
        });
        
        bot.on('end', (reason) => {
            console.log(`[${botId}] Disconnected: ${reason}`);
            bots.delete(botId);
        });
        
        bot.on('messagestr', (message) => {
            console.log(`[${botId}] ${message}`);
        });
        
        bots.set(botId, bot);
        
        return {
            success: true,
            mcUsername: mcName,
            uuid: mcProfile
        };
        
    } catch (error) {
        console.error(`❌ [${botId}] Failed: ${error.message}`);
        console.error(error.stack);
        throw error;
    }
}

app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565 } = req.body;
        
        if (!username || !token) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields: username, token' 
            });
        }
        
        if (bots.has(username)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Bot already running' 
            });
        }
        
        console.log(`[${username}] Received start request`);
        const result = await createBot(username, host, port, token);
        
        res.json({ 
            success: true, 
            message: `Bot ${username} started successfully`,
            ...result
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ success: false, error: 'Missing username' });
    }
    
    const bot = bots.get(username);
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    bot.quit('Stopped via API');
    bots.delete(username);
    
    res.json({ success: true, message: `Bot ${username} stopped` });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    
    if (!username || !message) {
        return res.status(400).json({ success: false, error: 'Missing username or message' });
    }
    
    const bot = bots.get(username);
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    bot.chat(message);
    console.log(`[${username}] Sent: ${message}`);
    
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, bot]) => ({
        username,
        mcUsername: bot.username,
        connected: bot.player !== undefined && bot.player !== null,
        health: bot.health || 0,
        food: bot.food || 0
    }));
    
    res.json({ 
        success: true,
        count: bots.size,
        bots: status 
    });
});

app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        uptime: process.uptime(),
        bots: bots.size
    });
});

app.get('/health', (req, res) => {
    res.json({ healthy: true, bots: bots.size });
});

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    bots.forEach((bot) => bot.quit('Server shutting down'));
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('✅ Bot Manager Running on Port', PORT);
    console.log('=================================');
});
