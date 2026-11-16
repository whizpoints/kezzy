# 🚀 Ultra-Lightweight WhatsApp-to-Telegram Forum Bridge (Turso Edition)

A high-performance, two-way bridge connecting **WhatsApp** to a **Telegram Supergroup (Forum)** using a single bot. Every WhatsApp chat and group gets its own dedicated **Topic**, creating a native, multi-chat messenger experience inside Telegram.

Built with **Baileys (WebSockets)**, **Telegraf**, and **Turso (libSQL Edge SQLite)**.

---

## 🌟 Why Turso DB?

1. **Zero Cold Starts:** Turso edge databases never sleep or pause due to inactivity (unlike Supabase or Render PostgreSQL free tiers).
2. **Lightning Fast:** Powered by libSQL over HTTP/WebSockets with sub-millisecond edge reads.
3. **Massive Free Tier:** 9GB storage, 1 Billion reads/month, 25 Million writes/month.
4. **Permanent Session Persistence:** Baileys auth keys and session state are written directly to Turso using atomic batch transactions (`client.batch`), surviving Render restarts and redeployments forever.

---

## 📁 Project Structure

```
whatsapp-telegram-bridge/
├── src/
│   ├── db.js             # Turso (libSQL) connection & queries
│   ├── tursoAuth.js      # Baileys Turso multi-device auth adapter
│   ├── media.js          # File & media download/upload helpers
│   ├── server.js         # Lightweight Express health check server
│   ├── telegram.js       # Telegraf bot, commands & topic routing
│   ├── whatsapp.js       # Baileys socket, QR generator & message relay
│   └── index.js          # Main application orchestrator
├── schema.sql            # SQLite / libSQL database tables
├── .env.example          # Sample environment variables
├── package.json
└── README.md
```

---

## 🛠️ Step-by-Step Setup Guide

### Step 1: Create Your Free Turso Database

1. Install the Turso CLI (or use the web dashboard at [turso.tech](https://turso.tech)):
   ```bash
   # On macOS/Linux:
   curl -sSfL https://get.tur.so/install.sh | bash

   # On Windows (PowerShell):
   irm get.tur.so/install.ps1 | iex
   ```
2. Log in and create a database:
   ```bash
   turso auth signup
   turso db create wa-bridge
   ```
3. Get your **Database URL**:
   ```bash
   turso db show wa-bridge --url
   # Output: libsql://wa-bridge-<your-username>.turso.io
   ```
4. Create an **Auth Token**:
   ```bash
   turso db tokens create wa-bridge
   # Output: eyJhbGciOi... (long token string)
   ```
*(The app automatically creates and migrates all database tables on first startup via `schema.sql`).*

---

### Step 2: Create Your Telegram Bot & Supergroup

1. **Create the Bot:**
   - Open Telegram and message `@BotFather`.
   - Send `/newbot`, name your bot, and copy the **API Token** (`TELEGRAM_BOT_TOKEN`).
2. **Create the Forum Supergroup:**
   - Create a new Telegram Group.
   - Go to **Group Settings** > **Permissions** / **Chat Type** > Enable **Topics** (this converts the group into a Forum).
3. **Add Bot as Administrator:**
   - Add your bot to the group as an **Administrator**.
   - Ensure the bot has permissions to:
     - ✅ **Manage Topics**
     - ✅ **Post Messages**
     - ✅ **Delete Messages** (used to clear old QR codes)
4. **Get the Group ID:**
   - Add `@userinfobot` or `@raw_data_bot` to your group, or inspect the URL in Telegram Web.
   - The Supergroup ID begins with `-100` (e.g., `-1001987654321`).

---

### Step 3: Configure Environment Variables

Create a `.env` file based on `.env.example`:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_GROUP_ID=-1001987654321
TURSO_DATABASE_URL=libsql://wa-bridge-youruser.turso.io
TURSO_AUTH_TOKEN=your_turso_jwt_auth_token
PORT=3000
SESSION_ID=main_wa_session
GENERAL_TOPIC_ID=1
```

---

## 🚀 Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Start the bridge
npm start
```

---

## 🌐 Deploying to Render

### Option A: Free Web Service (100% Free 24/7 Setup)
1. Push this project to your GitHub repository.
2. Go to [Render.com](https://render.com) and click **New +** > **Web Service**.
3. Connect your GitHub repository.
4. Settings:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** `Free`
5. Under **Environment Variables**, add:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_GROUP_ID`
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `SESSION_ID` (set to `main_wa_session`)
   - `PORT` (defaults to `3000`)
6. Click **Deploy Web Service**.
7. **Keep-Alive via UptimeRobot:**
   - Go to [UptimeRobot.com](https://uptimerobot.com) (free).
   - Create an **HTTP(s) Monitor** pointing to `https://your-service.onrender.com/health` with a 5-minute interval.
   - This keeps your Render container active 24/7 without ever sleeping.

### Option B: Render Background Worker
- If you use Render's paid individual plan ($7/mo), deploy this as a **Background Worker**. It runs 24/7 continuously and does not require an external ping.

---

## 📱 How It Works in Telegram

1. **Initial WhatsApp Authentication:**
   - When the bot boots, it sends a QR code photo directly into the **General** topic of your Supergroup.
   - Open WhatsApp on your phone > **Settings** > **Linked Devices** > **Link a Device** and scan it.
   - The bot deletes the QR image and confirms: `🟢 WhatsApp Connected!`.
2. **Incoming WhatsApp Messages:**
   - Each WhatsApp contact or group automatically creates a dedicated topic named after them.
   - All documents (PDFs, Word docs), photos, videos, voice notes, and text arrive in real-time.
3. **Replying:**
   - Simply type text, attach files with the paperclip 📎, or send voice notes inside any topic. It routes instantly to WhatsApp.
4. **Starting a New Chat from Telegram:**
   - In the **General** topic, type:
     ```text
     /chat 254712345678 Alex
     ```
   - The bot checks WhatsApp, verifies the number, creates the topic `Alex`, and lets you start typing.
5. **Admin-Only Groups:**
   - If an announcement-only group is detected where you are not an admin, the bot locks the topic (`🔒 [Read-Only]`) and notifies you if you try to send.
