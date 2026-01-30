const mineflayer = require('mineflayer');
const express = require('express');
const { Authflow } = require('prismarine-auth');

const app = express();
app.use(express.json());

const SERVER = process.env.donutsmp.net;
const PORT = process.env.PORT || 19132;

let accounts = [];
let bots = new Map();

async function startBot(account) {
  try {
    console.log(`Starting ${account.username}`);

    const flow = new Authflow(
      account.username,
      './tokens',
      {
        flow: 'msal',
        refreshToken: account.refreshToken
      }
    );

    const mc = await flow.getMinecraftJavaToken();

    const bot = mineflayer.createBot({
      host: SERVER,
      auth: 'microsoft',
      username: mc.profile.name,
      session: {
        accessToken: mc.access_token,
        selectedProfile: {
          id: mc.profile.id,
          name: mc.profile.name
        }
      }
    });

    account.online = true;

    bot.on('end', () => {
      console.log(`${account.username} disconnected`);
      account.online = false;
      bots.delete(account.username);
    });

    bot.on('error', err => {
      console.log(`${account.username} error:`, err.message);
    });

    bots.set(account.username, bot);

  } catch (err) {
    console.error(`FAILED ${account.username}`, err.message);
  }
}

/* API */

app.get('/status', (req, res) => {
  res.json({
    total: accounts.length,
    online: [...bots.keys()].length
  });
});

app.post('/add', async (req, res) => {
  const { refreshToken, username } = req.body;

  if (!refreshToken)
    return res.status(400).json({ error: 'Missing refreshToken' });

  const acc = {
    username: username || `Bot${accounts.length}`,
    refreshToken,
    online: false
  };

  accounts.push(acc);
  startBot(acc);

  res.json({ username: acc.username });
});

app.post('/stopall', (req, res) => {
  bots.forEach(b => b.end());
  bots.clear();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`MC service running on ${PORT}`);
});
