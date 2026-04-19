# DAC Inception — Daily Testnet Bot

Automated daily activities for [DAC Inception](https://inception.dachain.io/activity) testnet.

**Chain:** DAC Quantum Chain (ID: 21894)
**RPC:** `https://rpctest.dachain.tech`
**Explorer:** `https://exptest.dachain.tech`

---

## Activities

| # | Action | Description |
|---|--------|-------------|
| 1 | 🚰 Faucet | Claim free DACC (requires X or Discord linked) |
| 2 | 📦 Crate | Open daily Quantum Crate → earn QE |
| 3 | 💸 TX | Self-transfer transactions → earn TX badges |
| 4 | 🔥 Burn | Burn DACC → Quantum Energy (QE) |
| 5 | 🔄 Sync | Sync all activity to API |

## Badges (Auto-earned)

| Badge | Requirement | QE Reward |
|-------|------------|-----------|
| Sign In | First login | 25 |
| First Crate | Open 1 crate | 25 |
| First Transaction | Send 1 tx | 50 |
| Getting Started | Send 3 tx | 25 |
| 10 Transactions | Send 10 tx | 100 |
| 50 Transactions | Send 50 tx | 250 |
| First Drip | Claim faucet 1x | 25 |
| Regular | Claim faucet 10x | 50 |
| Daily Streak | 3/7/14/21/30 days | 50–1000 |
| QE milestones | 500+ total QE | 50–5000 |

---

## Setup

### 1. Prerequisites

```bash
# clone repo
git clone https://github.com/v325-max/Dachain-Bot.git
cd Dachain-Bot

# Install dependencies
npm install
```

### 2. Wallet Keys

Create `pk.txt` in the project directory — one private key per line:

```bash
# Single wallet
echo "0xYOUR_PRIVATE_KEY_HERE" > pk.txt

# Multi-wallet
echo "0xWALLET_1_KEY" > pk.txt
echo "0xWALLET_2_KEY" >> pk.txt
echo "0xWALLET_3_KEY" >> pk.txt
```

> ⚠️ Never share or commit `pk.txt`!

### 3. Prerequisites per Wallet

Each wallet must have:
- ✅ Connected at [inception.dachain.io](https://inception.dachain.io) at least once
- ✅ Linked Twitter (X) or Discord for faucet
- ✅ Some DAC balance for txs and burn (claim faucet first)

---

## Usage

### Single Run
```bash
node bot.js --once
```

### Loop Mode (every 10 min)
```bash
node bot.js
```

### Cron Mode (4x daily: 00:00, 06:00, 12:00, 18:00 UTC)
```bash
node bot.js --cron
```

### Custom Options
```bash
node bot.js --tx 5              # 5 self-transfers per cycle
node bot.js --burn 0.01         # burn 0.01 DAC per cycle
node bot.js --tx 10 --burn 0.02 # combine options
```

---

## Systemd Service (Linux)

Run as background service with auto-restart:

```bash
sudo tee /etc/systemd/system/dachain-bot.service << 'EOF'
[Unit]
Description=DAC Inception Daily Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/dachain-bot
ExecStart=/usr/bin/node bot.js --cron
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable dachain-bot
sudo systemctl start dachain-bot

# Check logs
sudo journalctl -u dachain-bot -f
```

## Crontab (Alternative)

```bash
# Edit crontab
crontab -e

# Add (runs at 00:00, 06:00, 12:00, 18:00 UTC):
0 0,6,12,18 * * * cd /root/dachain-bot && /usr/bin/node bot.js --once >> bot.log 2>&1
```

---

## Files

| File | Description |
|------|-------------|
| `bot.js` | Main bot script |
| `pk.txt` | Private keys (one per line) |
| `state.json` | Runtime state (auto-generated) |
| `bot.log` | Activity log (auto-generated) |
| `package.json` | Project config |

---

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  pk.txt     │────▶│  bot.js      │────▶│  DAC API        │
│  (wallets)  │     │  (ethers.js) │     │  (CSRF+cookie)  │
└─────────────┘     └──────┬───────┘     └────────┬────────┘
                           │                       │
                    ┌──────▼───────┐        ┌──────▼────────┐
                    │  DAC Chain   │        │  Inception    │
                    │  (RPC)       │        │  Dashboard    │
                    └──────────────┘        └───────────────┘
```

**Auth flow:**
1. `GET /csrf/` → get CSRF cookie
2. `POST /api/auth/wallet/` → register/login wallet
3. `POST /api/inception/faucet/` → claim DACC
4. `POST /api/inception/crate/open/` → open daily crate
5. `POST tx` → self-transfer on-chain
6. `POST burnForQE()` → burn DACC on-chain
7. `POST /api/inception/sync/` → sync activity

---

## Contracts

| Contract | Address |
|----------|---------|
| QE Exchange | `0x3691A78bE270dB1f3b1a86177A8f23F89A8Cef24` |
| Rank Badge | `0xB36ab4c2Bd6aCfC36e9D6c53F39F4301901Bd647` |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Faucet: link X or Discord` | Link social at [inception.dachain.io](https://inception.dachain.io) |
| `Low balance — skip TX` | Claim faucet first for DAC |
| `CSRF verification failed` | Cookie expired — restart bot |
| `Auth failed` | Check private key format in `pk.txt` |
| `Crate limit reached` | Already opened today — wait 24h |

---

## License

MIT
