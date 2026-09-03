// Parte pura: arquivos .env, cascata, merge. Sem rede, sem disco além do que recebe.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export class ErroPsonoEnv extends Error { constructor(m, code = 1) { super(m); this.name = "ErroPsonoEnv"; this.code = code; } }
/** Aborta o comando. Vira `erro: ...` + exit code no main; em sync é capturável (fail-open). */
export const die = (m, code = 1) => { throw new ErroPsonoEnv(m, code); };
export const aviso = (m) => console.error("[psono-env] " + m);

export function parseEnvTexto(txt, origem) {
  const out = [], seen = new Set();
  const linhas = txt.split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    const line = linhas[i].trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    // nunca ecoar a linha: pode ser valor (pedaço de um PEM, senha), e mensagem de erro vai pra log
    if (eq < 1) die(`${origem}: linha ${i + 1} não parece KEY=VALUE`);
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    const q = value[0];
    if (q === '"' || q === "'") {
      // valor entre aspas pode atravessar linhas (PEM, JSON): junta até a aspa de fechamento
      const ini = i;
      while (!(value.length > 1 && value.endsWith(q))) {
        if (++i >= linhas.length) die(`${origem}: linha ${ini + 1}: aspas ${q} sem fechamento`);
        value += "\n" + linhas[i].trimEnd();
      }
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\(n|"|\\)/g, (_, c) => (c === "n" ? "\n" : c));
    } else {
      const h = value.search(/\s#/);
      if (h >= 0) value = value.slice(0, h).trim();
    }
    if (seen.has(key)) die(`${origem}: chave duplicada: ${key}`);
    seen.add(key);
    out.push({ key, value });
  }
  return out;
}

export const parseEnvFile = (f) => parseEnvTexto(readFileSync(f, "utf8"), f);

export function fmt({ key, value }) {
  if (!/[\s"'#\\]/.test(value)) return `${key}=${value}`;
  return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export const nomeValido = (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

export function avisarNomesInvalidos(chaves) {
  const ruins = [...chaves].filter((k) => !nomeValido(k));
  if (ruins.length)
    aviso(`AVISO: ${ruins.length} chave(s) não servem como variável de ambiente e serão ignoradas ` +
      `pelo shell: ${ruins.map((k) => JSON.stringify(k)).join(", ")}`);
}

export function gitRoot(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

export function branchAtual(dir) {
  try {
    // symbolic-ref funciona em branch sem commit; falha em detached HEAD, que é o certo.
    return execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

export const slug = (b) => b.replace(/[/\\]/g, "-");

/** Camadas locais (.env.local, .env.<branch>.local) que existem na raiz. */
export function camadasLocais(raiz, branch, existe) {
  const cand = [".env", ".env.local"];
  if (branch) cand.push(`.env.${slug(branch)}.local`);
  return cand.filter((f) => existe(path.join(raiz, f)));
}

/** key -> { value, origem }; a última camada ganha. */
export function compor(camadas) {
  const m = new Map();
  for (const c of camadas) for (const v of c.vars) m.set(v.key, { value: v.value, origem: c.nome });
  return m;
}

/**
 * MERGE (default): base é o remoto (ordem preservada); chave NOVA entra no fim com o valor local;
 *   chave que já existe fica com o valor do VAULT — o vault é esquema compartilhado, valor é de cada um.
 * values=true: o local também sobrescreve valores existentes.
 * REPLACE: o local é a verdade inteira (apaga o que só existe no vault).
 */
export function mesclar(remote, local, replace, values = false) {
  if (replace) return [...local];
  const L = new Map(local.map((v) => [v.key, v.value]));
  const R = new Set(remote.map((v) => v.key));
  return [...remote.map((v) => ({ key: v.key, value: values && L.has(v.key) ? L.get(v.key) : v.value })),
          ...local.filter((v) => !R.has(v.key))];
}

export function diffChaves(meu, alvo) {
  const soAlvo = [...alvo.keys()].filter((k) => !meu.has(k)).sort();
  const soMeu = [...meu.keys()].filter((k) => !alvo.has(k)).sort();
  const difere = [...meu.keys()].filter((k) => alvo.has(k) && alvo.get(k) !== meu.get(k).value).sort();
  const iguais = [...meu.keys()].filter((k) => alvo.has(k) && alvo.get(k) === meu.get(k).value).length;
  return { soAlvo, soMeu, difere, iguais };
}
