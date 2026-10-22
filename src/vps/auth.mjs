// Commander authentication for the Orca-style Swarm Console.
// Accounts live ONLY on the VPS (users.json in the data dir, scrypt-hashed,
// sessions stored as SHA-256 hashes). Roles: viewer < operator(commander) < admin.
// Workers/nodes do NOT need accounts — they join with the cluster token as before.
// First run: either bootstrap from env (A_ADMIN_USER/A_ADMIN_PASSWORD, recommended
// on a public VPS) or create the first commander in the /swarm setup screen
// (optionally gated by A_SETUP_TOKEN). Once any account exists, setup is closed.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";

export const ROLES = ["viewer", "operator", "admin"];
export const roleRank = r => ROLES.indexOf(r);
const sha256 = s => createHash("sha256").update(s).digest("hex");
const SESSION_MS = 7 * 24 * 3600 * 1000;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { salt, hash, N: 16384 };
}
export function verifyPassword(password, pw) {
  if (!pw?.salt || !pw?.hash) return false;
  const h = scryptSync(String(password), pw.salt, 64, { N: pw.N || 16384, r: 8, p: 1 });
  const want = Buffer.from(pw.hash, "hex");
  return h.length === want.length && timingSafeEqual(h, want);
}
const validUsername = u => /^[\w.\-]{2,32}$/.test(String(u || ""));
const validPassword = p => String(p || "").length >= 8;

export class Auth {
  constructor(store, { env = process.env } = {}) {
    this.store = store; this.env = env;
    this.enabled = env.A_AUTH !== "off";
    this.data = { users: [], sessions: [] };
    this.attempts = new Map(); // ip+user -> {n, resetAt}
  }
  async init() {
    this.data = await this.store.readJSON("users.json", { users: [], sessions: [] });
    this.data.sessions = (this.data.sessions || []).filter(s => s.expires > Date.now());
    if (!this.data.users.length && this.env.A_ADMIN_USER && this.env.A_ADMIN_PASSWORD) {
      await this._create(this.env.A_ADMIN_USER, this.env.A_ADMIN_PASSWORD, "admin");
      await this.store.event("auth:bootstrap", { user: this.env.A_ADMIN_USER, via: "env" });
      console.log(`⬢ A auth: commander account '${this.env.A_ADMIN_USER}' bootstrapped from env (setup screen disabled)`);
    } else if (!this.data.users.length && this.enabled) {
      console.log("⬢ A auth: no commander accounts yet — open /swarm to create the first one" +
        (this.env.A_SETUP_TOKEN ? " (A_SETUP_TOKEN required)" : " — do this before exposing the VPS, or set A_ADMIN_USER/A_ADMIN_PASSWORD"));
    }
    return this;
  }
  async save() { await this.store.writeJSON("users.json", this.data); }
  needsSetup() { return this.enabled && this.data.users.length === 0; }
  publicUser(u) { return u ? { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt } : null; }
  listUsers() { return this.data.users.map(u => this.publicUser(u)); }

  async _create(username, password, role) {
    if (!validUsername(username)) throw new Error("username: 2-32 chars, letters/digits/._-");
    if (!validPassword(password)) throw new Error("password: minimum 8 characters");
    if (!ROLES.includes(role)) throw new Error("bad role");
    if (this.data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw new Error("username taken");
    const u = { id: "u_" + randomBytes(4).toString("hex"), username, role, pw: hashPassword(password), createdAt: new Date().toISOString() };
    this.data.users.push(u); await this.save(); return u;
  }
  async setup(username, password, setupToken) {
    if (!this.needsSetup()) throw new Error("setup closed — an account already exists");
    if (this.env.A_SETUP_TOKEN && setupToken !== this.env.A_SETUP_TOKEN) throw new Error("bad setup token");
    const u = await this._create(username, password, "admin");
    await this.store.event("auth:setup", { user: username });
    return this._session(u);
  }
  _rateKey(ip, user) { return `${ip}|${String(user).toLowerCase()}`; }
  _checkRate(ip, user) {
    const a = this.attempts.get(this._rateKey(ip, user));
    if (a && a.resetAt > Date.now() && a.n >= 5) throw new Error("too many attempts — try again in a few minutes");
  }
  _fail(ip, user) { const k = this._rateKey(ip, user); const a = this.attempts.get(k) || { n: 0, resetAt: Date.now() + 5 * 60 * 1000 };
    if (a.resetAt < Date.now()) { a.n = 0; a.resetAt = Date.now() + 5 * 60 * 1000; } a.n++; this.attempts.set(k, a); }
  async _session(u) {
    const token = randomBytes(32).toString("base64url");
    this.data.sessions.push({ hash: sha256(token), userId: u.id, createdAt: Date.now(), expires: Date.now() + SESSION_MS });
    await this.save(); return { token, user: this.publicUser(u) };
  }
  async login(username, password, ip = "?") {
    this._checkRate(ip, username);
    const u = this.data.users.find(x => x.username.toLowerCase() === String(username).toLowerCase());
    if (!u || !verifyPassword(password, u.pw)) { this._fail(ip, username);
      await this.store.event("auth:login:fail", { user: username, ip }); throw new Error("invalid username or password"); }
    this.attempts.delete(this._rateKey(ip, username));
    await this.store.event("auth:login", { user: u.username, role: u.role });
    return this._session(u);
  }
  async logout(token) { if (!token) return; this.data.sessions = this.data.sessions.filter(s => s.hash !== sha256(token)); await this.save(); }
  userFromToken(token) {
    if (!token) return null;
    const s = this.data.sessions.find(x => x.hash === sha256(token) && x.expires > Date.now());
    return s ? this.data.users.find(u => u.id === s.userId) || null : null;
  }
  async createUser(by, username, password, role = "operator") {
    if (roleRank(by?.role) < roleRank("admin")) throw new Error("admin required");
    const u = await this._create(username, password, role);
    await this.store.event("auth:user:create", { by: by.username, user: username, role }); return this.publicUser(u);
  }
  async deleteUser(by, username) {
    if (roleRank(by?.role) < roleRank("admin")) throw new Error("admin required");
    if (by.username.toLowerCase() === String(username).toLowerCase()) throw new Error("cannot delete yourself");
    const u = this.data.users.find(x => x.username.toLowerCase() === String(username).toLowerCase());
    if (!u) throw new Error("no such user");
    if (u.role === "admin" && this.data.users.filter(x => x.role === "admin").length <= 1) throw new Error("cannot delete the last admin");
    this.data.users = this.data.users.filter(x => x.id !== u.id);
    this.data.sessions = this.data.sessions.filter(s => s.userId !== u.id);
    await this.save(); await this.store.event("auth:user:delete", { by: by.username, user: username });
  }
  async setPassword(user, oldPw, newPw) {
    if (!verifyPassword(oldPw, user.pw)) throw new Error("current password wrong");
    if (!validPassword(newPw)) throw new Error("password: minimum 8 characters");
    user.pw = hashPassword(newPw); await this.save();
    await this.store.event("auth:password", { user: user.username });
  }
}

// Cookie + bearer extraction shared by HTTP and WS upgrade.
export function sessionTokenFromRequest(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const m = String(req.headers.cookie || "").match(/a_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
export function sessionCookie(token, req, maxAge = SESSION_MS / 1000) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https");
  return `a_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export const clearCookie = () => "a_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
