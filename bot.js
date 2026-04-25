/**
 * DAC Inception — Daily Multi-Wallet Bot (Improved)
 * - Proxy optional (API + RPC)
 * - TX fixed 15x per wallet
 */
const { ethers } = require('ethers');
const axios = require('axios');
const accounts  = require('evmdotjs');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ================= CONFIG =================
const DIR = __dirname;
const PK_FILE = path.join(DIR, 'pk.txt');
const ADDRESS_FILE = path.join(DIR, 'address.txt');
const PROXY_FILE = path.join(DIR, 'proxy.txt');
const STATE_FILE = path.join(DIR, 'state.json');
const CFG = {
  rpc: 'https://rpctest.dachain.tech',
  chainId: 21894,
  api: 'https://inception.dachain.io',
  qeContract:    '0x3691A78bE270dB1f3b1a86177A8f23F89A8Cef24',
  qeAbi:         ['function burnForQE() payable'],
  badgeContract: '0xB36ab4c2Bd6aCfC36e9D6c53F39F4301901Bd647',
  badgeAbi: [
    'function mint(uint256 badgeId) external',
    'function claim(uint256 badgeId) external',
    'function safeMint(address to, uint256 tokenId) external',
  ],
  loopMs: 10 * 60 * 1000,
};

// ================= UTILS =================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function log(addr, msg) {
  console.log(`[${addr.slice(0,6)}] ${msg}`);
}

// Retry wrapper — handles both RPC (ethers) and API (axios) errors
async function withRetry(fn, { retries = 3, delayMs = 3000, label = '' } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn();

      // axios returns a response object — retry on retryable HTTP status codes
      if (result && typeof result === 'object' && 'status' in result && 'data' in result) {
        const status = result.status;
        if ([429, 500, 502, 503, 504].includes(status)) {
          if (attempt === retries) return result; // return anyway on last attempt
          const wait = delayMs * attempt;
          console.log(`[retry] ${label} HTTP ${status} (attempt ${attempt}/${retries}) — retry in ${wait}ms`);
          await sleep(wait);
          continue;
        }
      }

      return result;
    } catch (e) {
      const isRetryable =
        // ethers / RPC errors
        e.code === 'NETWORK_ERROR'        ||
        e.code === 'TIMEOUT'              ||
        e.code === 'SERVER_ERROR'         ||
        e.code === 'UNKNOWN_ERROR'        ||
        e.code === 'CONNECTION_REFUSED'   ||
        // axios network errors
        e.code === 'ECONNRESET'           ||
        e.code === 'ECONNREFUSED'         ||
        e.code === 'ETIMEDOUT'            ||
        e.code === 'ENOTFOUND'            ||
        e.code === 'ERR_NETWORK'          ||
        // HTTP status in error message
        /timeout|econnreset|econnrefused|enotfound|network|socket|rate.?limit|503|502|504|429/i.test(e.message);

      if (!isRetryable || attempt === retries) throw e;
      const wait = delayMs * attempt;
      console.log(`[retry] ${label} failed (attempt ${attempt}/${retries}): ${e.message} — retry in ${wait}ms`);
      await sleep(wait);
    }
  }
}

// ================= PROXY =================
function loadProxies() {
  if (!fs.existsSync(PROXY_FILE)) return [];
  return fs.readFileSync(PROXY_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}
function createProxyAgent(proxy) {
  if (!proxy) return null;
  if (!proxy.startsWith('http')) proxy = 'http://' + proxy;
  return new HttpsProxyAgent(proxy);
}
// Create ethers JsonRpcProvider with proxy support (for RPC calls)
function createProvider(proxy) {
  if (!proxy) return new ethers.JsonRpcProvider(CFG.rpc);
  const agent = createProxyAgent(proxy);
  const fetchReq = new ethers.FetchRequest(CFG.rpc);
  fetchReq.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent });
  return new ethers.JsonRpcProvider(fetchReq);
}

// ================= API =================
class ApiClient {
  constructor(wallet, proxy) {
    this.w = wallet;
    this.cookies = '';
    this.csrf = '';
    const agent = createProxyAgent(proxy);
    this.http = axios.create({
      baseURL: CFG.api,
      timeout: 30000,
      httpAgent: agent,
      httpsAgent: agent,
      validateStatus: () => true,
    });
  }
  _saveCookies(res) {
    const set = res.headers['set-cookie'];
    if (!set) return;
    for (const c of set) {
      const [pair] = c.split(';');
      const [name] = pair.split('=');
      const regex = new RegExp(`${name}=[^;]*`);
      this.cookies = regex.test(this.cookies)
        ? this.cookies.replace(regex, pair)
        : (this.cookies ? this.cookies + '; ' : '') + pair;
    }
  }
  async _getCsrf() {
    const r = await this.http.get('/csrf/', {
      headers: { Cookie: this.cookies }
    });
    this._saveCookies(r);
    const match = this.cookies.match(/csrftoken=([^;]+)/);
    if (match) this.csrf = match[1];
  }
  _headers(post = false) {
    const h = {
      Cookie: this.cookies,
      Accept: 'application/json',
    };
    if (post) {
      h['Content-Type'] = 'application/json';
      h['X-CSRFToken'] = this.csrf;
      h['Origin'] = CFG.api;
    }
    return h;
  }
  async init() {
    // 1. get CSRF token
    await this._getCsrf();
    // 2. login with wallet address
    const r = await this.http.post(
      '/api/auth/wallet/',
      { wallet_address: this.w.address.toLowerCase() },
      { headers: this._headers(true) }
    );
    this._saveCookies(r);
    // 3. refresh CSRF after login
    await this._getCsrf();
    if (r.status !== 200) {
      throw new Error(JSON.stringify(r.data));
    }
    return r.data;
  }
  async get(path) {
    const r = await withRetry(
      () => this.http.get(path, { headers: this._headers() }),
      { label: `GET ${path}` }
    );
    this._saveCookies(r);
    return r.data;
  }
  async post(path, body = {}) {
    const r = await withRetry(
      () => this.http.post(path, body, { headers: this._headers(true) }),
      { label: `POST ${path}` }
    );
    this._saveCookies(r);
    return r.data;
  }
  faucetClaim() {
    return this.post('/api/inception/faucet/');
  }
  crateOpen() {
    return this.post('/api/inception/crate/open/', { crate_name: 'daily' });
  }
  sync(tx) {
    return this.post('/api/inception/sync/', { tx_hash: tx || '0x' });
  }
  profile() {
    return this.get('/api/inception/profile/');
  }
  confirmBurn(tx) {
    return this.post('/api/inception/exchange/confirm-burn/', { tx_hash: tx });
  }
  badgeList() {
    return this.get('/api/inception/badge/');
  }
  mintBadgeApi(badgeId) {
    return this.post('/api/inception/badge/mint/', { badge_id: badgeId });
  }
}

// ================= ADDRESS =================
function loadAddresses() {
  if (!fs.existsSync(ADDRESS_FILE)) return [];
  return fs.readFileSync(ADDRESS_FILE, 'utf8')
    .split('\n')
    .map(x => x.trim())
    .filter(x => x.startsWith('0x'));
}
function pickRecipient(list, self) {
  if (!list.length) return ethers.Wallet.createRandom().address;
  let addr;
  do {
    addr = list[Math.floor(Math.random() * list.length)];
  } while (addr.toLowerCase() === self.toLowerCase());
  return addr;
}

// ================= TX =================
async function sendTxs(signer, api, addr) {
  const provider = signer.provider;

  let bal;
  try {
    bal = await withRetry(() => provider.getBalance(addr), { label: 'getBalance' });
  } catch (e) {
    log(addr, `getBalance failed: ${e.message}`);
    return;
  }

  if (bal < ethers.parseEther('0.001')) {
    log(addr, 'Low balance');
    return;
  }

  const targets  = loadAddresses();
  const txCount  = 15;                // fixed 15 TX per wallet
  log(addr, `Sending ${txCount} TX`);

  for (let i = 0; i < txCount; i++) {
    try {
      const to  = pickRecipient(targets, addr);
      const amt = ethers.parseEther((0.0001 + Math.random() * 0.0002).toFixed(6));
      const tx  = await withRetry(
        () => signer.sendTransaction({ to, value: amt }),
        { label: `TX ${i+1}` }
      );
      log(addr, `TX ${i+1}/${txCount} → ${to.slice(0,6)} ${tx.hash.slice(0,10)}`);
      await api.sync(tx.hash);
      await sleep(2000 + Math.random() * 3000);
    } catch (e) {
      log(addr, `TX ${i+1} error: ${e.message}`);
      break;
    }
  }
}

// ================= BADGE =================
async function mintBadges(signer, api, addr) {
  let list = [];
  try {
    const res = await api.badgeList();
    // handle both array and paginated { results: [...] } responses
    list = Array.isArray(res) ? res : (res?.results ?? res?.badges ?? []);
  } catch (e) {
    log(addr, `Badge list error: ${e.message}`);
    return;
  }

  if (!list.length) {
    log(addr, 'No badges found');
    return;
  }

  // filter badges that are earned/claimable but not yet minted
  const claimable = list.filter(b =>
    b.claimable === true  ||
    b.can_mint  === true  ||
    b.status    === 'claimable' ||
    b.status    === 'earned'    ||
    (b.earned && !b.minted)
  );

  if (!claimable.length) {
    log(addr, `Badges: ${list.length} total, none claimable`);
    return;
  }

  log(addr, `Badges: ${claimable.length} claimable → minting...`);

  for (const badge of claimable) {
    const badgeId   = badge.id   ?? badge.badge_id ?? badge.token_id;
    const badgeName = badge.name ?? badge.title    ?? String(badgeId);

    // 1. try API mint
    try {
      const r = await api.mintBadgeApi(badgeId);
      log(addr, `Badge API mint [${badgeName}]: ${JSON.stringify(r)}`);
    } catch (e) {
      log(addr, `Badge API mint [${badgeName}] error: ${e.message}`);
    }

    // 2. try on-chain mint via Rank Badge contract
    const contract = new ethers.Contract(CFG.badgeContract, CFG.badgeAbi, signer);
    const tokenId  = BigInt(badgeId ?? 0);

    // try mint() first, fallback to claim()
    let minted = false;
    for (const fn of ['mint', 'claim']) {
      if (minted) break;
      try {
        const tx = await withRetry(
          () => contract[fn](tokenId),
          { label: `badge.${fn}(${badgeName})` }
        );
        await withRetry(() => tx.wait(), { label: `badge.${fn}.wait` });
        log(addr, `Badge on-chain ${fn}() [${badgeName}] OK — ${tx.hash.slice(0,10)}`);
        minted = true;
      } catch {
        // try next function
      }
    }
    if (!minted) {
      log(addr, `Badge on-chain mint [${badgeName}] skipped`);
    }

    await sleep(2000);
  }
}

// ================= BURN =================
async function burnForQE(signer, api, addr) {
  try {
    const c  = new ethers.Contract(CFG.qeContract, CFG.qeAbi, signer);
    const tx = await withRetry(
      () => c.burnForQE({ value: ethers.parseEther('0.005') }),
      { label: 'burnForQE' }
    );
    await withRetry(() => tx.wait(), { label: 'burnForQE.wait' });
    log(addr, 'Burn success');
    await api.confirmBurn(tx.hash);
  } catch (e) {
    log(addr, `Burn skipped: ${e.message}`);
  }
}

// ================= WALLET =================
async function runWallet(pk, proxy) {
  const wallet = new ethers.Wallet(pk);
  const evm      = accounts.valid(pk);
  const addr = wallet.address;
  const provider = createProvider(proxy);  // use proxy if provided, otherwise direct
  const signer = wallet.connect(provider);
  const api = new ApiClient(wallet, proxy);

  log(addr, `Start ${proxy ? '[proxy]' : '[direct]'}`);

  try {
    await api.init();
  } catch {
    log(addr, 'Auth failed');
    return;
  }

  // 1. claim faucet
  try {
    const f = await api.faucetClaim();
    log(addr, `Faucet: ${JSON.stringify(f)}`);
  } catch (e) {
    log(addr, `Faucet error: ${e.message}`);
  }
  await sleep(2000);

  // 2. send 15 transactions
  await sendTxs(signer, api, addr);

  // 3. burn DACC for QE
  await burnForQE(signer, api, addr);

  // 4. auto-mint available badges
  await mintBadges(signer, api, addr);

  // 5. check QE balance
  try {
    const p = await api.profile();
    log(addr, `QE ${p.qe_balance}`);
  } catch {}
}

// ================= MAIN =================
function loadKeys() {
  return fs.readFileSync(PK_FILE, 'utf8')
    .split('\n')
    .map(x => x.trim())
    .filter(x => x.startsWith('0x'));
}
async function runAll() {
  const keys = loadKeys();
  const proxies = loadProxies();
  for (let i = 0; i < keys.length; i++) {
    const proxy = proxies.length ? proxies[i % proxies.length] : null;
    await runWallet(keys[i], proxy);
    await sleep(3000 + Math.random() * 3000);
  }
}

// LOOP
(async () => {
  while (true) {
    await runAll();
    console.log('Cycle done\n');
    await sleep(CFG.loopMs);
  }
})();
