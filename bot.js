const mineflayer = require('mineflayer');
const express = require('express');
const app = express();

app.use(express.json());

const bots = new Map();

// Parse token format: email:password:jwt_token
function parseToken(tokenString) {
    const colonIndex = tokenString.indexOf(':');
    const secondColonIndex = tokenString.indexOf(':', colonIndex + 1);
    
    if (colonIndex === -1 || secondColonIndex === -1) {
        throw new Error('Invalid token format. Expected: email:password:token');
    }
    
    return {
        email: tokenString.substring(0, colonIndex),
        password: tokenString.substring(colonIndex + 1, secondColonIndex),
        accessToken: tokenString.substring(secondColonIndex + 1)
    };
}

// Decode JWT without verification
function decodeJWT(token) {
    try {
        const parts = token.split('.');
        const payload = Buffer.from(parts[1], 'base64').toString('utf8');
        return JSON.parse(payload);
    } catch (e) {
        throw new Error('Failed to decode JWT: ' + e.message);
    }
}

// Main bot creation function
async function createBot(botId, host, port, sessionToken) {
    try {
        console.log(`[${botId}] Parsing session token...`);
        const { email, password, accessToken } = parseToken(sessionToken);
        
        console.log(`[${botId}] Decoding JWT...`);
        const tokenData = decodeJWT(accessToken);
        
        // Extract Minecraft profile from token
        const mcProfile = tokenData.profiles?.mc;
        const mcName = tokenData.pfd?.[0]?.name;
        
        if (!mcProfile || !mcName) {
            throw new Error('Token missing Minecraft profile data');
        }
        
        console.log(`[${botId}] Account: ${mcName} (${mcProfile})`);
        console.log(`[${botId}] Token expires: ${new Date(tokenData.exp * 1000).toISOString()}`);
        
        // Check if token is expired
        if (tokenData.exp * 1000 < Date.now()) {
            throw new Error('Access token has expired');
        }
        
        // Create the bot with Microsoft auth
        console.log(`[${botId}] Connecting to ${host}:${port}...`);
        
        const bot = mineflayer.createBot({
            host: host,
            port: port,
            username: email,
            auth: 'microsoft',
            session: {
                accessToken: accessToken,
                clientToken: tokenData.aid || '00000000-0000-0000-0000-000000000000',
                selectedProfile: {
                    id: mcProfile,
                    name: mcName
                }
            },
            skipValidation: true,
            version: false,
            hideErrors: false
        });
        
        // Event handlers
        bot.on('login', () => {
            console.log(`✅ [${botId}] Successfully logged in as ${bot.username}`);
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
        
        bot.on('death', () => {
            console.log(`💀 [${botId}] Died. Respawning...`);
            setTimeout(() => bot.chat('/respawn'), 1000);
        });
        
        bot.on('message', (message) => {
            console.log(`[${botId}] ${message.toString()}`);
        });
        
        bots.set(botId, bot);
        
        return {
            success: true,
            mcUsername: mcName,
            uuid: mcProfile
        };
        
    } catch (error) {
        console.error(`❌ [${botId}] Failed to create bot: ${error.message}`);
        throw error;
    }
}

// API Endpoints
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
        return res.status(400).json({ 
            success: false, 
            error: 'Missing username or message' 
        });
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
        food: bot.food || 0,
        position: bot.position ? {
            x: Math.floor(bot.position.x),
            y: Math.floor(bot.position.y),
            z: Math.floor(bot.position.z)
        } : null
    }));
    
    res.json({ 
        success: true,
        count: bots.size,
        bots: status 
    });
});

app.post('/startall', async (req, res) => {
    const { tokens, host = 'donutsmp.net', port = 25565 } = req.body;
    
    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ 
            success: false, 
            error: 'tokens must be an array' 
        });
    }
    
    console.log(`Starting ${tokens.length} bots...`);
    const results = [];
    
    for (const botData of tokens) {
        const { username, token } = botData;
        
        try {
            if (bots.has(username)) {
                results.push({ 
                    username, 
                    success: false, 
                    error: 'Already running' 
                });
                continue;
            }
            
            const result = await createBot(username, host, port, token);
            results.push({ username, ...result });
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            results.push({ 
                username, 
                success: false, 
                error: error.message 
            });
        }
    }
    
    res.json({ 
        success: true, 
        results,
        started: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
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

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    bots.forEach((bot, username) => {
        bot.quit('Server shutting down');
    });
    process.exit(0);
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('Minecraft Bot Manager Starting...');
    console.log(`Server: donutsmp.net`);
    console.log('=================================');
    console.log(`✅ Bot Manager Running on Port ${PORT}`);
    console.log('=================================');
});
