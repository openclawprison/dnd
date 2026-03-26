# D&D AI Dungeon Master

An AI-powered Dungeons & Dragons 5th Edition game where Claude acts as the Dungeon Master.

## Features
- Full character creation (race, class, ability scores) with randomize option
- D&D 5e mechanics (dice rolls, AC, spell slots, combat, loot)
- AI DM generates narrative, enemies, and story dynamically
- Character sheet sidebar with live HP, inventory, combat log
- Open-ended — play as long as you want

## Deploy to Render

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "D&D AI DM"
git remote add origin https://github.com/YOUR_USER/dnd-ai-dm.git
git push -u origin main
```

### 2. Create Render Web Service
1. Go to https://dashboard.render.com
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (or Starter for better performance)

### 3. Add Environment Variable
In Render dashboard → Environment:
- **Key:** `ANTHROPIC_API_KEY`
- **Value:** Your Anthropic API key (get one at https://console.anthropic.com)

### 4. Deploy
Click Deploy. Your game will be live at `https://your-service.onrender.com`

## Cost

Uses **Claude Haiku 4.5** — the most cost-effective model:
- ~$0.001 per game turn (input ~500 tokens + output ~400 tokens)
- A full 2-hour session (~60 turns) costs about $0.06
- Rate limited to 15 requests/minute per IP

## Local Development
```bash
export ANTHROPIC_API_KEY=your_key_here
npm install
npm start
# Open http://localhost:3000
```

## Tech Stack
- **Backend:** Node.js + Express (API proxy, rate limiting)
- **Frontend:** Vanilla JS (no framework, single HTML file)
- **AI:** Claude Haiku 4.5 via Anthropic API
- **Styling:** CSS with Cinzel + EB Garamond fonts
