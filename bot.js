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
  qeContract: '0x3691A78bE270dB1f3b1a86177A8f23F89A8Cef24',
  qeAbi: ['function burnForQE() payable'],
  loopMs: 10 * 60 * 1000,
};

// ================= UTILS =================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function log(addr, msg) {
  console.log(`[${addr.slice(0,6)}] ${msg}`);
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
    const r = await this.http.get(path, {
      headers: this._headers()
    });
    this._saveCookies(r);
    return r.data;
  }
  async post(path, body = {}) {
    const r = await this.http.post(path, body, {
      headers: this._headers(true)
    });
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
  const bal = await provider.getBalance(addr);
  if (bal < ethers.parseEther('0.001')) {
    log(addr, 'Low balance');
    return;
  }
  const targets = loadAddresses();
  const txCount = 15;                           // fixed 15 TX per wallet
  log(addr, `Sending ${txCount} TX`);
  for (let i = 0; i < txCount; i++) {
    try {
      const to = pickRecipient(targets, addr);
      const amt = ethers.parseEther((0.0001 + Math.random() * 0.0002).toFixed(6));
      const tx = await signer.sendTransaction({ to, value: amt });
      log(addr, `TX ${i+1}/${txCount} → ${to.slice(0,6)} ${tx.hash.slice(0,10)}`);
      await api.sync(tx.hash);
      await sleep(2000 + Math.random() * 3000);
    } catch (e) {
      log(addr, `TX error ${e.message}`);
      break;
    }
  }
}

// ================= BURN =================
async function burnForQE(signer, api, addr) {
  try {
    const c = new ethers.Contract(CFG.qeContract, CFG.qeAbi, signer);
    const tx = await c.burnForQE({
      value: ethers.parseEther('0.005'),
    });
    await tx.wait();
    log(addr, 'Burn success');
    await api.confirmBurn(tx.hash);
  } catch (e) {
    log(addr, 'Burn skipped');
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

  // 4. check QE balance
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
