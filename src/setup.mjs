// setup interativo: pergunta no terminal, valida, grava o toml da home com 0600.
// Nada de credencial em argv (vaza em `ps` e no histórico do shell); só pergunta ou env PSONO_*.
import { writeFileSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline";

// UM readline pra sessão inteira, com fila própria de linhas: com stdin em pipe o readline
// emite todas as linhas do chunk de uma vez, e `question` só consome a primeira — as outras
// sumiriam. Aqui toda linha vai pra fila e cada pergunta tira uma. Fechar com fecharPrompt().
let _rl = null, _st = null;
function abrir(input, output) {
  if (_rl) return;
  _rl = createInterface({ input, output, terminal: !!input.isTTY });
  _st = { fila: [], esperando: null, fechado: false, mudo: false, output, orig: _rl._writeToOutput.bind(_rl) };
  _rl._writeToOutput = (s) => { if (!_st.mudo) _st.orig(s); };
  const entrega = (l) => { const f = _st.esperando; if (f) { _st.esperando = null; f(l); } else _st.fila.push(l); };
  _rl.on("line", entrega);
  _rl.on("close", () => { _st.fechado = true; if (_st.esperando) entrega(""); });
}

export function perguntar(texto, { secreto = false, input = process.stdin, output = process.stdout } = {}) {
  abrir(input, output);
  const st = _st;
  return new Promise((resolve) => {
    const fim = (v) => { if (st.mudo) { st.mudo = false; output.write("\n"); } resolve(v.trim()); };
    output.write(texto);
    st.mudo = secreto && !!input.isTTY;   // só o eco some; o prompt já foi escrito
    if (st.fila.length) return fim(st.fila.shift());
    if (st.fechado) return fim("");         // stdin acabou: campo vazio, quem chamou decide
    st.esperando = fim;
  });
}

export function fecharPrompt() { if (_rl && !_st.fechado) _rl.close(); }

export const CAMPOS = ["server_url", "api_key_id", "api_key_private_key", "api_key_secret_key"];

export function tomlCredencial(cfg) {
  const linhas = ["# psono-env — API key pessoal do Psono (Settings > API Keys, sem 'Secret Restriction'). Nunca commitar."];
  for (const k of CAMPOS) linhas.push(`${k} = ${JSON.stringify(cfg[k])}`);
  return linhas.join("\n") + "\n";
}

// grava com 0600 (no Windows o chmod é no-op; o arquivo já nasce só do usuário)
export function gravarPrivado(p, texto) {
  writeFileSync(p, texto, { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}
