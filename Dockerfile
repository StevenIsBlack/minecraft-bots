FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "bot.js"]
```

### 3C: Upload to GitHub
1. Click "Add file" → "Create new file"
2. Name it `package.json`, paste the code
3. Click "Commit"
4. Repeat for `bot.js` and `Dockerfile`

---

## Step 4: Deploy to Railway

### 4A: Deploy Minecraft Bots
1. Go to [Railway.app](https://railway.app)
2. Click "New Project"
3. Click "Deploy from GitHub repo"
4. Select `minecraft-bots`
5. Wait for it to deploy (2-3 mins)
6. Click on the service → "Settings" tab
7. Scroll to "Networking" → Click "Generate Domain"
8. **COPY THIS URL** (looks like: `https://minecraft-bots-production.up.railway.app`)

### 4B: Update Discord Bot
1. Go to your Discord bot project on Railway
2. Click "Variables" tab
3. Click "New Variable"
4. Name: `MC_BOT_URL`
5. Value: PASTE THE URL YOU COPIED
6. Click "Add"
7. Wait for redeploy

---

## Step 5: USE IT! 🎉

**In Discord, type:**
```
!add <your-token-here>   ← Add Minecraft account
!status                   ← Check how many bots online
!start                    ← Start all bots
!stop                     ← Stop all bots
!list                     ← List all accounts
