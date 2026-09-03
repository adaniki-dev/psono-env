// psono-env — env em camadas: a pasta do Psono com o NOME DO REPO é a referência, a branch é o override.
//
// CONVENÇÃO (zero config por repo):
//   /<repo>/base            o env de referência de desenvolvimento (a pasta tem o nome da raiz do git)
//   /<repo>/<branch>        chaves NOVAS que uma branch precisa — nasce sozinho no `git push` (sync)
//   /<repo>/_shared         opcional, camada comum
//
// CASCATA (o de baixo ganha):
//   1. /<repo>/_shared          se existir
//   2. /<repo>/base
//   3. /<repo>/<branch>         se existir
//   4. .env, .env.local         esta máquina
//   5. .env.<branch>.local      esta máquina, só nesta branch
//
// OVERRIDE (só se precisar): "psono-env" no package.json, ou .psono-env.json na raiz:
//   { "base": "/Wascer/Backend", "baseSecret": "Staging", "shared": null, "trunk": ["main"], "protect": [] }
//
// CREDENCIAL (por máquina, nunca no repo): ~/.psono-env.toml  (ou variáveis PSONO_SERVER_URL,
// PSONO_API_KEY_ID, PSONO_API_KEY_PRIVATE_KEY, PSONO_API_KEY_SECRET_KEY)
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, platform, release } from "node:os";
import path from "node:path";
import { Vault, VARS_FIELD, ENV_TYPE, resolverCaminho, listar, lerEnv } from "./vault.mjs";
import { die, ErroPsonoEnv, aviso, parseEnvFile, fmt, nomeValido, avisarNomesInvalidos, gitRoot, branchAtual, slug,
         camadasLocais, compor, mesclar, diffChaves } from "./env.mjs";

export const AJUDA = `psono-env — /<repo>/base no Psono é a referência, /<repo>/<branch> é o override da branch.

  psono-env ls [/pasta]                  lista o vault (pastas e secrets de env)
  psono-env resolve                      quais chaves valem e de qual camada vieram
  psono-env run [--clean] -- <cmd...>    roda com o env composto (nada toca disco)
  psono-env sync [--strict]              sobe as chaves NOVAS da máquina pra /<repo>/<branch> (husky pre-push)
                                         na trunk (main/master/develop) sobe direto pra base
  psono-env promote [branch] [--rm]      funde as chaves de /<repo>/<branch> na base (--rm manda a branch pro lixo)
  psono-env diff [alvo]                  compara com outro secret (ex: prod) — só NOMES; exit 2 se faltar
  psono-env pull [nome|/caminho]         despeja um secret como .env no stdout (default: base)
  psono-env push <nome|/caminho> <arquivo.env>   sobe DRIFT DE CHAVES: chave nova entra, valor existente fica
      --values   também sobrescreve valores das chaves que já existem
      --replace  espelho exato: o que falta no arquivo MORRE no vault (implica --values)
      --yes      aplica (sem isso é dry-run)     --rm  queima o arquivo depois

Husky: .husky/pre-push -> "npx psono-env sync". Credencial: ~/.psono-env.toml.`;

// ---------------------------------------------------------------- config

function parseTomlSimples(txt) {
  const out = {};
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, "");
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (v === "true" || v === "false") v = v === "true";
    out[m[1]] = v;
  }
  return out;
}

export function acharConfigPath() {
  const cands = [];
  if (process.env.PSONO_ENV_CONFIG) cands.push(process.env.PSONO_ENV_CONFIG);
  cands.push(path.join(homedir(), ".psono-env.toml"));
  if (platform() === "linux" && /microsoft/i.test(release()) && existsSync("/mnt/c/Users"))
    for (const u of readdirSync("/mnt/c/Users")) cands.push(`/mnt/c/Users/${u}/.psono-env.toml`);
  return { path: cands.find((c) => existsSync(c)) || null, cands };
}

export function carregarConfig(env = process.env) {
  const doEnv = { server_url: env.PSONO_SERVER_URL, api_key_id: env.PSONO_API_KEY_ID,
                  api_key_private_key: env.PSONO_API_KEY_PRIVATE_KEY, api_key_secret_key: env.PSONO_API_KEY_SECRET_KEY };
  const { path: p, cands } = acharConfigPath();
  const doArq = p ? parseTomlSimples(readFileSync(p, "utf8")) : {};
  const cfg = { ...doArq, ...Object.fromEntries(Object.entries(doEnv).filter(([, v]) => v)) };
  for (const k of ["server_url", "api_key_id", "api_key_private_key", "api_key_secret_key"])
    if (!cfg[k]) die(`falta ${k} (${p ? p : "nenhum config achado: " + cands.join(", ")}; ou variável ${"PSONO_" + k.toUpperCase()})`);
  return cfg;
}

// ---------------------------------------------------------------- projeto (convenção + override)

export function lerOverride(raiz) {
  const j = path.join(raiz, ".psono-env.json");
  if (existsSync(j)) return JSON.parse(readFileSync(j, "utf8"));
  const pk = path.join(raiz, "package.json");
  if (existsSync(pk)) return JSON.parse(readFileSync(pk, "utf8"))["psono-env"] || {};
  return {};
}

export function projeto(cwd = process.cwd()) {
  const raiz = gitRoot(cwd) || cwd;
  const ov = lerOverride(raiz);
  const base = "/" + String(ov.base || path.basename(raiz)).replace(/^\/+|\/+$/g, "");
  return {
    raiz, base,
    baseSecret: ov.baseSecret || "base",
    shared: "shared" in ov ? ov.shared : "_shared",
    trunk: Array.isArray(ov.trunk) ? ov.trunk : ["main", "master", "develop"],
    protect: Array.isArray(ov.protect) ? ov.protect : ["prod"],
    caminho(nome) { return `${base}/${nome}`; },
    caminhoBranch(br) { return `${base}/${slug(br)}`; },
    ehTrunk(br) { return !!br && this.trunk.includes(br); },
    protegido(nome) { return this.protect.includes(nome); },
  };
}

export async function camadas(vault, proj, { existe = existsSync, ler = parseEnvFile, baseOpcional = false } = {}) {
  const br = branchAtual(proj.raiz);
  const vaultL = [];
  if (proj.shared) {
    const vs = await lerEnv(vault, proj.caminho(proj.shared), false);
    if (vs) vaultL.push({ nome: "vault:" + proj.shared, vars: vs });
  }
  const base = await lerEnv(vault, proj.caminho(proj.baseSecret), !baseOpcional);
  if (base) vaultL.push({ nome: "vault:" + proj.baseSecret, vars: base });
  if (br && !proj.ehTrunk(br)) {
    const vs = await lerEnv(vault, proj.caminhoBranch(br), false);
    if (vs) vaultL.push({ nome: "vault:" + slug(br), vars: vs });
  }
  const locais = camadasLocais(proj.raiz, br, existe).map((f) => ({ nome: f, vars: ler(path.join(proj.raiz, f)) }));
  return { branch: br, vault: vaultL, locais, camadas: [...vaultL, ...locais], temBase: !!base };
}

/** Chaves que existem nas camadas locais e em nenhuma do vault — o drift que o sync sobe. */
export function chavesNovas(vaultL, locais) {
  const no = new Set(vaultL.flatMap((c) => c.vars.map((v) => v.key)));
  const out = new Map();
  for (const c of locais) for (const v of c.vars) if (!no.has(v.key)) out.set(v.key, v.value);
  return [...out].map(([key, value]) => ({ key, value }));
}

/** spawnSync com shell:true só cola os args com espaço — aspas de `sh -c '...'` se perderiam. */
export function linhaDeComando(args, win = process.platform === "win32") {
  return args.map((a) => {
    if (win) return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
    return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
  }).join(" ");
}

const show = (l, arr) => { if (arr.length) console.log(`  ${l} (${arr.length}): ${arr.join(", ")}`); };

function queimar(f) {
  // Sobrescreve antes de apagar. NÃO é shred garantido (SSD/COW/NTFS residente); derrota undelete trivial.
  try { writeFileSync(f, randomBytes(statSync(f).size)); } catch { /* apaga assim mesmo */ }
  unlinkSync(f);
}

const login = async () => new Vault(carregarConfig()).login();

// ---------------------------------------------------------------- comandos

async function cmdLs(args, flags) {
  await listar(await login(), args[0] || "/", !flags.has("--all"));
}

async function cmdResolve() {
  const proj = projeto();
  const { branch, camadas: cs } = await camadas(await login(), proj);
  const comp = compor(cs);
  avisarNomesInvalidos(comp.keys());
  console.log(`repo: ${proj.raiz}   vault: ${proj.base}   branch: ${branch || "(fora de git)"}${proj.ehTrunk(branch) ? " (trunk)" : ""}`);
  console.log("camadas (a de baixo ganha):");
  for (const c of cs) console.log(`  ${c.nome.padEnd(34)} ${c.vars.length} chaves`);
  console.log(`\nresolvido: ${comp.size} chaves`);
  const por = new Map();
  for (const [k, v] of comp) (por.get(v.origem) ?? por.set(v.origem, []).get(v.origem)).push(k);
  for (const [o, ks] of por) show(`de ${o}`, ks.sort());
}

async function cmdRun(depois, flags) {
  if (!depois.length) die("run precisa de: psono-env run -- <comando...>");
  const proj = projeto();
  const { branch, camadas: cs } = await camadas(await login(), proj);
  const comp = compor(cs);
  avisarNomesInvalidos(comp.keys());
  const base = flags.has("--clean")
    ? Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]
        .filter((k) => k in process.env).map((k) => [k, process.env[k]]))
    : { ...process.env };
  for (const [k, v] of comp) if (nomeValido(k)) base[k] = v.value;
  aviso(`${comp.size} chaves de ${cs.length} camada(s), branch ${branch || "-"}`);
  const r = spawnSync(linhaDeComando(depois), { stdio: "inherit", env: base, shell: true });
  process.exit(r.status ?? 1);
}

async function cmdDiff(args) {
  const proj = projeto();
  const vault = await login();
  const { branch, camadas: cs } = await camadas(vault, proj);
  const meu = compor(cs);
  const alvoNome = args[0] || "prod";
  const alvo = new Map((await lerEnv(vault, proj.caminho(alvoNome))).map((v) => [v.key, v.value]));
  const d = diffChaves(meu, alvo);
  console.log(`resolvido (branch ${branch || "-"}, ${meu.size} chaves)  vs  ${alvoNome} (${alvo.size} chaves)`);
  show(`FALTA no teu (só em ${alvoNome})`, d.soAlvo);
  show(`sobra no teu (não existe em ${alvoNome})`, d.soMeu);
  show("valor difere", d.difere);
  console.log(`  idênticas: ${d.iguais}`);
  if (d.soAlvo.length) {
    console.log(`\nATENÇÃO: ${d.soAlvo.length} chave(s) de ${alvoNome} não existem no teu env.`);
    process.exit(2);
  }
}

async function cmdPull(args) {
  const proj = projeto();
  const alvo = args[0] || proj.baseSecret;
  const caminho = alvo.startsWith("/") ? alvo : proj.caminho(alvo);
  const vs = await lerEnv(await login(), caminho);
  avisarNomesInvalidos(vs.map((v) => v.key));
  for (const v of vs) console.log(fmt(v));
}

async function cmdPush(args, flags) {
  if (args.length < 2) die("uso: psono-env push <env|/caminho> <arquivo.env> [--yes] [--replace] [--rm]");
  const [env, arq] = args;
  const proj = projeto();
  let caminho;
  if (env.startsWith("/")) caminho = env;
  else {
    if (proj.protegido(env)) die(`"${env}" está PROTEGIDO. Esse secret não se escreve por aqui — mexe na UI de propósito.`);
    caminho = proj.caminho(env);
  }
  const replace = flags.has("--replace"), yes = flags.has("--yes"), rm = flags.has("--rm");
  const values = flags.has("--values") || replace;
  const local = parseEnvFile(arq);
  const vault = await login();
  let r = await resolverCaminho(vault, caminho);
  if (r.pastaAlvo) die(`${caminho} é uma pasta`);
  let item = r.item;
  const criar = !item;
  let remoteData = {}, remote = [];
  if (criar) {
    if (r.faltou.length > 1)
      die(`a pasta de ${caminho} não existe (faltou: ${r.faltou.slice(0, -1).join("/")}). Cria na UI: uma pasta com o nome do repo.`);
    if (r.store.kind === "share" && r.store.rights.write === false) die(`sem direito de escrita no share que contém ${caminho}`);
  } else {
    if (item.type !== ENV_TYPE) die(`${caminho} é do tipo "${item.type}", não environment_variables`);
    remoteData = await vault.lerSecret(item);
    remote = remoteData[VARS_FIELD] || [];
  }
  const R = new Map(remote.map((v) => [v.key, v.value]));
  const L = new Map(local.map((v) => [v.key, v.value]));
  const added = local.filter((v) => !R.has(v.key)).map((v) => v.key);
  const changed = local.filter((v) => R.has(v.key) && R.get(v.key) !== v.value).map((v) => v.key);
  const soRemoto = remote.filter((v) => !L.has(v.key)).map((v) => v.key);
  const final = mesclar(remote, local, replace, values);

  console.log(`${criar ? "CRIAR" : replace ? "REPLACE" : values ? "merge + valores" : "merge de chaves"}  ${caminho}  ${remote.length} -> ${final.length} chaves`);
  show("+ novas", added);
  show(values ? "~ valores alterados" : "~ valor difere (fica o do vault; --values pra subir)", changed);
  show(replace ? "- APAGADAS" : "= só no vault (ficam)", soRemoto);
  const mudaValor = values && changed.length;

  if (!(criar || added.length || mudaValor || (replace && soRemoto.length))) {
    console.log("  nada muda.");
    if (yes && rm) { queimar(arq); console.log(`  ${arq} apagado.`); }
    return;
  }
  if (!yes) {
    console.log(replace ? "\ndry-run. a linha - APAGADAS some do vault de verdade. --yes pra aplicar." : "\ndry-run. --yes pra aplicar.");
    return;
  }
  if (criar) {
    // relê o vault na hora de escrever: a árvore do share é sobrescrita inteira,
    // então trabalhar com cópia velha apagaria o que alguém criou nesse meio tempo.
    vault.esquecer();
    r = await resolverCaminho(vault, caminho);
    if (r.item) die("o secret apareceu no vault enquanto eu preparava o push — roda de novo (vira merge)");
    item = await vault.criarSecretEnv(r.store, r.pasta, caminho.split("/").filter(Boolean).at(-1), final);
  } else {
    remoteData[VARS_FIELD] = final;
    await vault.escreverSecret(item, remoteData);
  }
  const check = new Map(((await vault.lerSecret(item))[VARS_FIELD] || []).map((v) => [v.key, v.value]));
  const errados = final.filter((v) => check.get(v.key) !== v.value).map((v) => v.key);
  if (errados.length) die(`escreveu mas não bateu na releitura: ${errados.join(", ")}`);
  if (replace && check.size !== final.length) die(`sobrou chave no vault: ${check.size} vs ${final.length}`);
  console.log(`aplicado e reconferido: ${check.size} chaves no vault${criar ? " (secret criado)" : ""}.`);
  if (rm) { queimar(arq); console.log(`${arq} apagado.`); }
}

/** Sobe chaves novas pra um secret (cria se faltar), só chave — valor existente fica. Devolve as chaves subidas. */
async function subirChaves(vault, caminho, novas) {
  vault.esquecer();
  const r = await resolverCaminho(vault, caminho);
  if (r.pastaAlvo) die(`${caminho} é uma pasta`);
  if (r.item) {
    const data = await vault.lerSecret(r.item);
    const remote = data[VARS_FIELD] || [];
    const R = new Set(remote.map((v) => v.key));
    const add = novas.filter((v) => !R.has(v.key));
    if (!add.length) return [];
    data[VARS_FIELD] = [...remote, ...add];
    await vault.escreverSecret(r.item, data);
    return add.map((v) => v.key);
  }
  if (r.faltou.length > 2)
    die(`a pasta ${caminho.split("/").slice(0, -1).join("/")} não existe no vault (faltou: ${r.faltou.slice(0, -1).join("/")}). Cria na UI.`);
  let pasta = r.pasta;
  if (r.faltou.length === 2) {
    // só a pasta do repo falta (ex: /wascer-front): cria aqui mesmo, onde o resto do caminho já existe
    pasta = await vault.criarPasta(r.store, r.pasta, r.faltou[0]);
    aviso(`pasta ${caminho.split("/").slice(0, -1).join("/")} criada no vault`);
  }
  await vault.criarSecretEnv(r.store, pasta, caminho.split("/").filter(Boolean).at(-1), novas);
  return novas.map((v) => v.key);
}

async function cmdSync(flags) {
  const proj = projeto();
  const br = branchAtual(proj.raiz);
  if (!br) { aviso("sync: fora de uma branch (detached HEAD?) — nada a fazer"); return; }
  try {
    const vault = await login();
    const { vault: vaultL, locais, temBase } = await camadas(vault, proj, { baseOpcional: true });
    const novas = chavesNovas(vaultL, locais);
    if (!novas.length) { aviso(`sync: ${proj.base} sem drift de chave (branch ${br})`); return; }
    if (!temBase) aviso(`sync: ${proj.caminho(proj.baseSecret)} não existe — bootstrap: criando a base com as chaves desta máquina`);
    const alvo = (proj.ehTrunk(br) || !temBase) ? proj.caminho(proj.baseSecret) : proj.caminhoBranch(br);
    const subiu = await subirChaves(vault, alvo, novas);
    aviso(`sync: ${subiu.length} chave(s) nova(s) -> ${alvo}: ${subiu.join(", ")}`);
  } catch (e) {
    if (flags.has("--strict")) throw e;
    // fail-open: vault fora do ar ou máquina sem credencial não pode travar o push de ninguém
    aviso(`sync: ${e.message} — seguindo sem sync (--strict pra travar o push)`);
  }
}

async function cmdPromote(args, flags) {
  const proj = projeto();
  const br = args[0] || branchAtual(proj.raiz);
  if (!br) die("promote: informa a branch (ou roda dentro de uma)");
  if (proj.ehTrunk(br)) die(`${br} é trunk — não tem secret de branch pra promover`);
  const vault = await login();
  const origem = proj.caminhoBranch(br);
  const r = await resolverCaminho(vault, origem);
  if (!r.item) die(`não existe ${origem} no vault (a branch nunca subiu chave nova?)`);
  const vars = (await vault.lerSecret(r.item))[VARS_FIELD] || [];
  const subiu = await subirChaves(vault, proj.caminho(proj.baseSecret), vars);
  console.log(`promote ${origem} -> ${proj.caminho(proj.baseSecret)}: ${subiu.length} chave(s) nova(s)${subiu.length ? ": " + subiu.join(", ") : ""}`);
  if (flags.has("--rm")) {
    vault.esquecer();
    const r2 = await resolverCaminho(vault, origem);
    await vault.lixo(r2.store, r2.item);
    console.log(`${origem} mandado pro lixo do Psono.`);
  }
}

// ---------------------------------------------------------------- main

const COM_VALOR = new Set([]);

export function parseArgv(argv) {
  const sep = argv.indexOf("--");
  const head = sep < 0 ? argv : argv.slice(0, sep);
  const depois = sep < 0 ? [] : argv.slice(sep + 1);
  const flags = new Map(), pos = [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (COM_VALOR.has(a)) { if (i + 1 >= head.length) die(`${a} precisa de valor`); flags.set(a, head[++i]); }
    else if (a.startsWith("--")) flags.set(a, true);
    else pos.push(a);
  }
  return { pos, flags, depois };
}

export async function main(argv) {
  const { pos, flags, depois } = parseArgv(argv);
  if (flags.has("--version")) { console.log("psono-env 2.0.0"); return; }
  if (!pos.length || flags.has("--help") || pos[0] === "help") { console.log(AJUDA); return; }
  const [cmd, ...args] = pos;
  const tabela = {
    ls: () => cmdLs(args, flags),
    resolve: () => cmdResolve(),
    run: () => cmdRun(depois, flags),
    sync: () => cmdSync(flags),
    promote: () => cmdPromote(args, flags),
    diff: () => cmdDiff(args),
    pull: () => cmdPull(args),
    push: () => cmdPush(args, flags),
  };
  try {
    if (!tabela[cmd]) die(`comando desconhecido: ${cmd}  (psono-env --help)`);
    await tabela[cmd]();
  } catch (e) {
    if (e instanceof ErroPsonoEnv) { console.error("erro: " + e.message); process.exit(e.code); }
    throw e;
  }
}
