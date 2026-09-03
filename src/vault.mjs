// Cliente mínimo da API do Psono + navegação por caminho.
// Login por API key SEM restrição (sessão), datastore, shares aninhados, secrets.
// A árvore é o JSON cru, exatamente como a UI escreve — nada de modelo intermediário.
import nacl from "tweetnacl";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { die } from "./env.mjs";

export const ENV_TYPE = "environment_variables";
export const VARS_FIELD = "environment_variables_variables";

const hex = (u8) => Buffer.from(u8).toString("hex");
const unhex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const utf8 = (s) => new Uint8Array(Buffer.from(s, "utf8"));
const str = (u8) => Buffer.from(u8).toString("utf8");

export function enc(msg, keyHex) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { text: hex(nacl.secretbox(utf8(msg), nonce, unhex(keyHex))), nonce: hex(nonce) };
}
export function dec(textHex, nonceHex, keyHex) {
  const out = nacl.secretbox.open(unhex(textHex), unhex(nonceHex), unhex(keyHex));
  if (!out) die("falha ao decriptar (chave errada?)");
  return str(out);
}

export class Vault {
  constructor(cfg) {
    this.url = cfg.server_url.replace(/\/+$/, "");
    this.keyId = cfg.api_key_id;
    this.priv = cfg.api_key_private_key;
    this.sec = cfg.api_key_secret_key;
    this.token = null; this.skey = null; this.userSkey = null; this.username = null;
    this._ds = null; this._shares = new Map();
  }

  async _req(method, ep, body) {
    const headers = { "content-type": "application/json" };
    if (this.token) headers.authorization = "Token " + this.token;
    let data;
    if (body !== undefined) {
      data = JSON.stringify(body);
      if (this.skey) data = JSON.stringify(enc(data, this.skey));
    }
    let r;
    try { r = await fetch(this.url + ep, { method, headers, body: data }); }
    catch (e) { die(`${method} ${ep}: ${e.cause?.message || e.message}`); }
    const txt = await r.text();
    if (!r.ok) die(`${method} ${ep}: HTTP ${r.status} ${txt.slice(0, 300)}`);
    const j = JSON.parse(txt);
    if (this.skey && j && typeof j === "object" && "text" in j && "nonce" in j)
      return JSON.parse(dec(j.text, j.nonce, this.skey));
    return j;
  }

  async login() {
    const sess = nacl.box.keyPair();
    const info = JSON.stringify({ api_key_id: this.keyId, session_public_key: hex(sess.publicKey),
                                  device_description: "psono-env " + hostname() });
    const sign = nacl.sign.keyPair.fromSeed(unhex(this.priv));
    const signature = hex(nacl.sign.detached(utf8(info), sign.secretKey));
    const j = await this._req("POST", "/api-key/login/", { info, signature });
    if (!j.login_info) die("login falhou: " + JSON.stringify(j).slice(0, 300));
    const open = nacl.box.open(unhex(j.login_info), unhex(j.login_info_nonce),
                               unhex(j.server_session_public_key), sess.secretKey);
    if (!open) die("login: não consegui abrir a resposta do servidor");
    const li = JSON.parse(str(open));
    if (li.api_key_restrict_to_secrets)
      die('a API key está com "Secret Restriction" LIGADA — psono-env precisa navegar o vault. ' +
          "Desmarca na UI (Other → API Keys) e roda de novo.");
    this.token = li.token; this.skey = li.session_secret_key;
    this.username = li.user?.username;
    this.userSkey = dec(li.user.secret_key, li.user.secret_key_nonce, this.sec);
    return this;
  }

  async datastore() {
    if (!this._ds) {
      const lst = (await this._req("GET", "/datastore/")).datastores.filter((d) => d.type === "password");
      if (!lst.length) die("usuário sem datastore de senhas");
      const id = (lst.find((d) => d.is_default) || lst[0]).id;
      const r = await this._req("GET", `/datastore/${id}/`);
      const key = dec(r.secret_key, r.secret_key_nonce, this.userSkey);
      this._ds = { kind: "datastore", id, key, tree: JSON.parse(dec(r.data, r.data_nonce, key)) };
    }
    return this._ds;
  }

  async share(shareId, shareKey) {
    if (!this._shares.has(shareId)) {
      const r = await this._req("GET", `/share/${shareId}/`);
      if (!r.data) die(`sem acesso ao share ${shareId}: ${JSON.stringify(r).slice(0, 200)}`);
      this._shares.set(shareId, { kind: "share", id: shareId, key: shareKey,
        tree: JSON.parse(dec(r.data, r.data_nonce, shareKey)), rights: r.rights || {} });
    }
    return this._shares.get(shareId);
  }

  /** Descarta as árvores em cache — antes de escrever uma árvore inteira, reler é obrigatório. */
  esquecer() { this._ds = null; this._shares = new Map(); }

  async lerSecret(item) {
    const r = await this._req("GET", `/secret/${item.secret_id}/`);
    return JSON.parse(dec(r.data, r.data_nonce, item.secret_key));
  }

  async escreverSecret(item, data) {
    const e = enc(JSON.stringify(data), item.secret_key);
    await this._req("POST", "/secret/", { secret_id: item.secret_id, data: e.text, data_nonce: e.nonce,
      callback_url: "", callback_user: "", callback_pass: "" });
  }

  async criarSecretEnv(store, pasta, nome, variables) {
    const key = hex(nacl.randomBytes(nacl.secretbox.keyLength));
    const data = { environment_variables_title: nome, [VARS_FIELD]: variables,
                   custom_fields: [], attachments: [], tags: [] };
    const e = enc(JSON.stringify(data), key);
    const linkId = randomUUID();
    const body = { data: e.text, data_nonce: e.nonce, link_id: linkId,
                   callback_url: "", callback_user: "", callback_pass: "" };
    body[store.kind === "share" ? "parent_share_id" : "parent_datastore_id"] = store.id;
    const { secret_id } = await this._req("PUT", "/secret/", body);
    const item = { id: linkId, type: ENV_TYPE, name: nome, tags: [], secret_id, secret_key: key };
    (pasta.items ??= []).push(item);
    await this.escreverStore(store);
    return item;
  }

  /** Cria uma subpasta (só na árvore; pasta não tem secret) e grava a árvore. Devolve o nó novo. */
  async criarPasta(store, pasta, nome) {
    const nova = { id: randomUUID(), name: nome, folders: [], items: [] };
    (pasta.folders ??= []).push(nova);
    await this.escreverStore(store);
    return nova;
  }

  /** Marca o item como deletado na árvore (lixo do Psono — recuperável pela UI) e grava a árvore. */
  async lixo(store, item) {
    item.deleted = true;
    await this.escreverStore(store);
  }

  async escreverStore(store) {
    const e = enc(JSON.stringify(store.tree), store.key);
    if (store.kind === "share")
      await this._req("PUT", "/share/", { share_id: store.id, data: e.text, data_nonce: e.nonce });
    else
      await this._req("POST", "/datastore/", { datastore_id: store.id, data: e.text, data_nonce: e.nonce });
  }
}

// ---------------------------------------------------------------- navegação por caminho

const vivos = (lst) => (lst || []).filter((x) => !x.deleted);

/** Se a pasta é um share ainda não expandido, troca de store e devolve a raiz do share. */
export async function entrar(vault, store, pasta) {
  if (pasta.share_id && !("folders" in pasta) && !("items" in pasta)) {
    const st = await vault.share(pasta.share_id, pasta.share_secret_key);
    return [st, st.tree];
  }
  return [store, pasta];
}

/**
 * { store, pasta, item|null, pastaAlvo|null, faltou: [] }
 *  - aponta pra secret: item; pasta = onde ele mora
 *  - aponta pra pasta:  pastaAlvo
 *  - não existe:        faltou = partes não achadas (a partir da primeira)
 */
export async function resolverCaminho(vault, caminho) {
  const partes = caminho.split("/").filter(Boolean);
  let store = await vault.datastore();
  let no = store.tree;
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i], ultimo = i === partes.length - 1;
    const pasta = vivos(no.folders).find((f) => f.name === parte);
    if (pasta) {
      [store, no] = await entrar(vault, store, pasta);
      if (ultimo) return { store, pasta: no, item: null, pastaAlvo: no, faltou: [] };
      continue;
    }
    if (ultimo) {
      const item = vivos(no.items).find((it) => it.name === parte);
      if (item) return { store, pasta: no, item, pastaAlvo: null, faltou: [] };
    }
    return { store, pasta: no, item: null, pastaAlvo: null, faltou: partes.slice(i) };
  }
  return { store, pasta: no, item: null, pastaAlvo: no, faltou: [] };
}

export async function listar(vault, caminho = "/", soEnv = true, out = console.log) {
  const r = await resolverCaminho(vault, caminho);
  if (r.faltou.length) die(`caminho não existe a partir de: ${r.faltou.join("/")}`);
  if (r.item) { out(`- ${r.item.name}  (${r.item.type})`); return; }
  const walk = async (store, no, ind) => {
    for (const f of vivos(no.folders)) {
      const [st, sub] = await entrar(vault, store, f);
      out(" ".repeat(ind) + "📁 " + (f.name ?? "?") + (f.share_id ? "  [share]" : ""));
      await walk(st, sub, ind + 2);
    }
    for (const it of vivos(no.items)) {
      const t = it.type || (it.share_id ? "share" : "?");
      if (soEnv && t !== ENV_TYPE) continue;
      out(" ".repeat(ind) + `- ${it.name ?? "?"}  (${t})`);
    }
  };
  out(caminho.startsWith("/") ? caminho : "/" + caminho);
  await walk(r.store, r.pastaAlvo, 2);
}

/** Variáveis de um secret env pelo caminho. obrigatorio=false devolve null se não existe. */
export async function lerEnv(vault, caminho, obrigatorio = true) {
  const r = await resolverCaminho(vault, caminho);
  if (!r.item) {
    if (!obrigatorio) return null;
    if (r.pastaAlvo) die(`${caminho} é uma pasta, não um secret`);
    die(`secret não existe no vault: ${caminho} (faltou: ${r.faltou.join("/")}). Vê com \`psono-env ls\`.`);
  }
  if (r.item.type !== ENV_TYPE) die(`${caminho} é do tipo "${r.item.type}", não environment_variables`);
  return (await vault.lerSecret(r.item))[VARS_FIELD] || [];
}
