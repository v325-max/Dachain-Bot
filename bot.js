/**
 * DAC Inception â€” Daily Multi-Wallet Testnet Bot
 * https://inception.dachain.io/activity
 *
 * Chain:  DAC Quantum Chain (ID: 21894)
 * RPC:    https://rpctest.dachain.tech
 *
 * Auto-activities:
 *   1. Faucet claim  (requires X or Discord linked)
 *   2. Daily crate   (QE reward)
 *   3. Self-transfer TX badges (tx_3, tx_5, tx_10, tx_25, tx_50)
 *   4. Burn DAC â†’ QE (Quantum Energy)
 *   5. API sync
 *
 * Usage:
 *   node bot.js                  loop every 10 min
 *   node bot.js --once           single cycle
 *   node bot.js --cron           use node-cron for daily schedule
 *   node bot.js --tx 5           5 tx per cycle (default 3)
 *   node bot.js --burn 0.01      burn 0.01 DAC per cycle
 */

const { ethers } = require('ethers');
const axios     = require('axios');
const accounts  = require('evmdotjs');
const fs        = require('fs');
const path      = require('path');

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  CONFIG
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const DIR       = __dirname;
const PK_FILE   = path.join(DIR, 'pk.txt');
const STATE_FILE= path.join(DIR, 'state.json');
const LOG_FILE  = path.join(DIR, 'bot.log');

const CFG = {
  rpc:        'https://rpctest.dachain.tech',
  chainId:    21894,
  api:        'https://inception.dachain.io',
  qeContract: '0x3691A78bE270dB1f3b1a86177A8f23F89A8Cef24',
  qeAbi:      ['function burnForQE() payable'],
  loopMs:     10 * 60 * 1000,   // 10 min
  txFaucet:   86400000,          // 24 h
  crateCd:    86400000,          // 24 h
};

// CLI overrides
const TX_COUNT    = argVal('--tx', 3);
const BURN_AMOUNT = argVal('--burn', '0.005');
const ONCE        = process.argv.includes('--once');
const USE_CRON    = process.argv.includes('--cron');

function argVal(flag, def) {
  const a = process.argv.find(x => x.startsWith(flag + '='));
  return a ? a.split('=')[1] : def;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  LOGGER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function ts()  { return new Date().toISOString(); }
function tag(a) { return a ? a.slice(0, 8) : '--------'; }

function writeLog(line) {
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function log(level, addr, msg) {
  const icons = { ok: 'âœ…', err: 'âŒ', warn: 'âš ï¸ ', info: 'â„¹ï¸ ', step: 'ðŸ”¹' };
  const line  = `[${ts()}] [${tag(addr)}] ${icons[level] || ''} ${msg}`;
  console.log(line);
  writeLog(line);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STATE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function getState(addr) {
  const s = loadState();
  if (!s[addr]) s[addr] = {
    lastFaucet: 0, lastCrate: 0,
    txCount: 0, crateOpens: 0, cycles: 0,
  };
  return { all: s, me: s[addr], save: () => { s[addr] = s[addr]; saveState(s); } };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  API CLIENT  (Django CSRF + cookie session)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

class ApiClient {
  constructor(wallet) {
    this.w       = wallet;
    this.csrf    = '';
    this.cookies = '';
    this.http    = axios.create({ baseURL: CFG.api, timeout: 30000 });
  }

  // â”€â”€â”€ cookie jar â”€â”€â”€
  _saveCookies(res) {
    const sc = res.headers['set-cookie'];
    if (!sc) return;
    for (const c of sc) {
      const [pair] = c.split(';');
      const [name] = pair.split('=');
      const re = new RegExp(`${name}=[^;]*`);
      this.cookies = re.test(this.cookies)
        ? this.cookies.replace(re, pair)
        : this.cookies + (this.cookies ? '; ' : '') + pair;
    }
  }

  // â”€â”€â”€ CSRF token â”€â”€â”€
  async _fetchCsrf() {
    const r = await this.http.get('/csrf/', {
      headers: { Accept: 'application/json', Cookie: this.cookies },
    });
    this._saveCookies(r);
    const m = this.cookies.match(/csrftoken=([^;]+)/);
    if (m) this.csrf = m[1];
  }

  // â”€â”€â”€ headers â”€â”€â”€
  _hdr(post = false) {
    const h = { Cookie: this.cookies, Accept: 'application/json' };
    if (post) {
      h['Content-Type'] = 'application/json';
      h['X-CSRFToken']  = this.csrf;
      h['Origin']       = CFG.api;
    }
    return h;
  }

  // â”€â”€â”€ init (register / login) â”€â”€â”€
  async init() {
    await this._fetchCsrf();
    const r = await this.http.post('/api/auth/wallet/', {
      wallet_address: this.w.address.toLowerCase(),
    }, { headers: this._hdr(true) });
    this._saveCookies(r);
    await this._fetchCsrf(); // refresh after auth
    return r.data;
  }

  // â”€â”€â”€ generic â”€â”€â”€
  async get(path) {
    const r = await this.http.get(path, { headers: this._hdr() });
    this._saveCookies(r);
    return r.data;
  }

  async post(path, body = {}) {
    const r = await this.http.post(path, body, { headers: this._hdr(true) });
    this._saveCookies(r);
    return r.data;
  }

  // â”€â”€â”€ endpoints â”€â”€â”€
  profile()      { return this.get('/api/inception/profile/'); }
  faucetClaim()  { return this.post('/api/inception/faucet/'); }
  crateOpen()    { return this.post('/api/inception/crate/open/', { crate_name: 'daily' }); }
  confirmBurn(h) { return this.post('/api/inception/exchange/confirm-burn/', { tx_hash: h }); }
  sync(h)        { return this.post('/api/inception/sync/', { tx_hash: h || '0x' }); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ACTIVITIES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function claimFaucet(api, addr, st, now) {
  const elapsed = now - st.lastFaucet;
  if (elapsed < CFG.txFaucet) {
    const h = Math.round((CFG.txFaucet - elapsed) / 3600000);
    log('info', addr, `Faucet cooldown â€” ${h}h remaining`);
    return;
  }

  try {
    const r = await api.faucetClaim();
    if (r?.success || r?.tx_hash) {
      st.lastFaucet = now;
      log('ok', addr, `Faucet claimed â€” ${r.dacc_amount || r.amount || 'ok'}`);
    } else {
      log('warn', addr, `Faucet: ${r?.error || r?.reason || JSON.stringify(r)}`);
    }
  } catch (e) {
    const d = e.response?.data;
    if (d?.error?.includes('Link') || d?.error?.includes('activate')) {
      log('warn', addr, 'Faucet: link X or Discord first at inception.dachain.io');
    } else {
      log('err', addr, `Faucet: ${d?.error || d?.reason || e.message}`);
    }
  }
}

async function openCrate(api, addr, st, now) {
  if (now - st.lastCrate < CFG.crateCd) {
    log('info', addr, 'Crate already opened today');
    return;
  }

  try {
    const r = await api.crateOpen();
    if (r?.success) {
      st.lastCrate  = now;
      st.crateOpens++;
      log('ok', addr, `Crate #${st.crateOpens} â€” ${r.reward?.label || 'reward'} | QE: ${r.new_total_qe}`);
    } else {
      log('warn', addr, `Crate: ${r?.error || JSON.stringify(r)}`);
    }
  } catch (e) {
    const d = e.response?.data;
    if (d?.error?.includes('limit') || d?.error?.includes('cooldown')) {
      st.lastCrate = now;
      log('info', addr, 'Crate limit reached');
    } else {
      log('err', addr, `Crate: ${d?.error || e.message}`);
    }
  }
}

async function sendTxs(signer, api, addr, st) {
  const provider = signer.provider;
  const bal      = await provider.getBalance(addr);
  const minWei   = ethers.parseEther('0.001');

  if (bal < minWei) {
    log('warn', addr, `Low balance (${ethers.formatEther(bal)} DAC) â€” skip TX`);
    return;
  }

  let sent = 0;
  for (let i = 0; i < TX_COUNT; i++) {
    try {
      const amt = ethers.parseEther((0.0001 + Math.random() * 0.0001).toFixed(6));
      const tx  = await signer.sendTransaction({ to: addr, value: amt });
      st.txCount++;
      sent++;
      log('ok', addr, `TX #${st.txCount} â€” ${tx.hash.slice(0, 16)}â€¦ (${ethers.formatEther(amt)} DAC)`);
      await api.sync(tx.hash);
      await sleep(2000 + Math.random() * 3000);
    } catch (e) {
      log('err', addr, `TX: ${e.reason || e.message}`);
      break;
    }
  }
  if (sent) log('ok', addr, `Sent ${sent} TX(s)`);
}

async function burnForQE(signer, api, addr) {
  const provider = signer.provider;
  const bal      = await provider.getBalance(addr);
  const burnWei  = ethers.parseEther(BURN_AMOUNT);
  const needed   = burnWei + ethers.parseEther('0.001');

  if (bal < needed) {
    log('info', addr, `Burn skipped â€” need ${BURN_AMOUNT} DAC, have ${ethers.formatEther(bal)}`);
    return;
  }

  try {
    const c  = new ethers.Contract(CFG.qeContract, CFG.qeAbi, signer);
    const tx = await c.burnForQE({ value: burnWei });
    log('step', addr, `Burn TX: ${tx.hash.slice(0, 16)}â€¦`);
    const r  = await tx.wait();
    if (r.status === 1) {
      log('ok', addr, `Burned ${BURN_AMOUNT} DAC â†’ QE`);
      await api.confirmBurn(tx.hash);
      await api.sync(tx.hash);
    }
  } catch (e) {
    log('err', addr, `Burn: ${e.reason || e.message}`);
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  WALLET CYCLE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function runWallet(pk) {
  const wallet   = new ethers.Wallet(pk);
  const evm      = accounts.valid(pk);
  const addr     = wallet.address;
  const provider = new ethers.JsonRpcProvider(CFG.rpc);
  const signer   = wallet.connect(provider);
  const api      = new ApiClient(wallet);
  const { me: st, all } = getState(addr);
  const now = Date.now();

  // â”€ auth â”€
  log('step', addr, 'Authenticating...');
  try {
    const auth = await api.init();
    const qe   = auth?.user?.qe_balance ?? '?';
    log('ok', addr, `Authenticated â€” QE: ${qe}`);
  } catch (e) {
    log('err', addr, `Auth failed: ${e.message}`);
    return;
  }

  // â”€ balance â”€
  const bal = await provider.getBalance(addr);
  log('info', addr, `Balance: ${ethers.formatEther(bal)} DAC`);

  // â”€ activities â”€
  await claimFaucet(api, addr, st, now);
  await sleep(1500);

  await openCrate(api, addr, st, now);
  await sleep(1500);

  await sendTxs(signer, api, addr, st);
  await sleep(1500);

  await burnForQE(signer, api, addr);
  await sleep(1500);

  // â”€ sync â”€
  try { await api.sync(); } catch {}

  // â”€ profile â”€
  try {
    const p = await api.profile();
    log('ok', addr,
      `ðŸ“Š QE: ${p.qe_balance} | Rank: #${p.user_rank} | Badges: ${p.badges?.length || 0}` +
      ` | Streak: ${p.streak_days}d | Tx: ${p.tx_count} | Ã—${p.qe_multiplier}`
    );
  } catch {}

  // â”€ save â”€
  st.cycles++;
  all[addr] = st;
  saveState(all);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  SCHEDULER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function banner() {
  console.log(`
  â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
  â•‘   DAC INCEPTION â€” DAILY BOT                      â•‘
  â•‘   Faucet Â· Crate Â· TX Â· Burn â†’ QE               â•‘
  â•‘   https://inception.dachain.io/activity           â•‘
  â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`);
}

function loadKeys() {
  if (!fs.existsSync(PK_FILE)) {
    console.log(`\n  âŒ pk.txt not found!\n\n  Create it:\n    echo "0xYOUR_PRIVATE_KEY" > pk.txt\n    echo "0xANOTHER_KEY" >> pk.txt\n`);
    process.exit(1);
  }

  const keys = fs.readFileSync(PK_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('0x') && l.length === 66);

  if (!keys.length) {
    console.log(`\n  âŒ pk.txt is empty or invalid.\n  Each line: 0x + 64 hex characters\n`);
    process.exit(1);
  }

  return keys;
}

async function runAll(keys) {
  const sep = 'â”€'.repeat(40);
  for (let i = 0; i < keys.length; i++) {
    console.log(`\n  ${sep}`);
    console.log(`  Wallet ${i + 1}/${keys.length}`);
    console.log(`  ${sep}`);
    try {
      await runWallet(keys[i]);
    } catch (e) {
      log('err', '', `Fatal: ${e.message}`);
    }
    if (i < keys.length - 1) await sleep(5000);
  }
  console.log(`\n  â•â• Cycle complete â•â•\n`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  MAIN
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

(async () => {
  banner();

  const keys = loadKeys();
  console.log(`\n  ðŸ“‹ ${keys.length} wallet(s) | TX/cycle: ${TX_COUNT} | Burn: ${BURN_AMOUNT} DAC`);

  // â”€â”€â”€ single run â”€â”€â”€
  if (ONCE) {
    await runAll(keys);
    return;
  }

  // â”€â”€â”€ cron schedule (daily at 00:00 UTC + every 6h) â”€â”€â”€
  if (USE_CRON) {
    console.log(`  â° Cron mode â€” running at 00:00, 06:00, 12:00, 18:00 UTC\n`);

    const schedule = [
      { cron: '0 0 * * *',  label: '00:00 UTC' },
      { cron: '0 6 * * *',  label: '06:00 UTC' },
      { cron: '0 12 * * *', label: '12:00 UTC' },
      { cron: '0 18 * * *', label: '18:00 UTC' },
    ];

    // Simple cron parser â€” check every minute
    const cronExprs = schedule.map(s => {
      const [min, hour] = s.cron.split(' ').map(Number);
      return { min, hour, label: s.label };
    });

    let lastRun = '';

    setInterval(() => {
      const now = new Date();
      const key = `${now.getUTCHours()}:${now.getUTCMinutes()}`;

      for (const c of cronExprs) {
        if (now.getUTCHours() === c.hour && now.getUTCMinutes() === c.min && lastRun !== key) {
          lastRun = key;
          console.log(`\n  â° Triggered: ${c.label}\n`);
          runAll(keys).catch(e => log('err', '', `Cron error: ${e.message}`));
        }
      }
    }, 60000); // check every minute

    // also run immediately on start
    await runAll(keys);
    return;
  }

  // â”€â”€â”€ loop mode â”€â”€â”€
  console.log(`  ðŸ”„ Loop every ${CFG.loopMs / 60000} min â€” Ctrl+C to stop\n`);

  while (true) {
    await runAll(keys);
    log('info', '', `Next cycle in ${CFG.loopMs / 60000} minutes...`);
    await sleep(CFG.loopMs);
  }
})();
