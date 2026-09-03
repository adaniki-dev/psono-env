import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { projeto, parseArgv, lerOverride, linhaDeComando, camadas, chavesNovas } from "../src/cli.mjs";
import { VARS_FIELD } from "../src/vault.mjs";

const repo = (nome) => {
  const d = path.join(mkdtempSync(path.join(tmpdir(), "pe-")), nome);
  execFileSync("git", ["init", "-q", d]);
  return d;
};

test("convenção: base = /<nome da pasta raiz do git>, mesmo de subpasta", () => {
  const d = repo("wascer-backend");
  const sub = path.join(d, "src", "x"); execFileSync("mkdir", ["-p", sub]);
  const p = projeto(sub);
  assert.equal(p.base, "/wascer-backend"); assert.equal(p.raiz, d);
  assert.equal(p.caminho("dev"), "/wascer-backend/dev"); assert.equal(p.caminho("prod"), "/wascer-backend/prod");
  assert.ok(p.protegido("prod")); assert.ok(!p.protegido("dev")); assert.equal(p.shared, "_shared");
  assert.equal(p.baseSecret, "base"); assert.equal(p.caminhoBranch("feat/x"), "/wascer-backend/feat-x");
  assert.ok(p.ehTrunk("main")); assert.ok(p.ehTrunk("develop")); assert.ok(!p.ehTrunk("feat/x")); assert.ok(!p.ehTrunk(null));
});

test("override via package.json", () => {
  const d = repo("x");
  writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x", "psono-env": { base: "Wascer/Backend/", baseSecret: "Staging", shared: null, trunk: ["trunk"], protect: [] } }));
  const p = projeto(d);
  assert.equal(p.base, "/Wascer/Backend"); assert.equal(p.caminho(p.baseSecret), "/Wascer/Backend/Staging");
  assert.equal(p.shared, null); assert.ok(!p.protegido("prod")); assert.ok(p.ehTrunk("trunk")); assert.ok(!p.ehTrunk("main"));
});

test(".psono-env.json ganha do package.json", () => {
  const d = repo("y");
  writeFileSync(path.join(d, "package.json"), JSON.stringify({ "psono-env": { base: "/A" } }));
  writeFileSync(path.join(d, ".psono-env.json"), JSON.stringify({ base: "/B" }));
  assert.equal(projeto(d).base, "/B");
  assert.deepEqual(lerOverride(mkdtempSync(path.join(tmpdir(), "pe-"))), {});
});

test("parseArgv", () => {
  const r = parseArgv(["run", "--clean", "--", "pnpm", "dev"]);
  assert.deepEqual(r.pos, ["run"]); assert.ok(r.flags.get("--clean")); assert.ok(!r.flags.has("--env"));
  assert.deepEqual(r.depois, ["pnpm", "dev"]);
});

test("linhaDeComando preserva aspas e espaços", () => {
  assert.equal(linhaDeComando(["sh", "-c", 'echo "A=$A"'], false), `sh -c 'echo "A=$A"'`);
  assert.equal(linhaDeComando(["it's", "x"], false), `'it'\\''s' x`);
  assert.equal(linhaDeComando(["next", "dev", "-p", "3000"], false), "next dev -p 3000");
  assert.equal(linhaDeComando(["cmd", "/c", "echo a b"], true), 'cmd /c "echo a b"');
});

// vault fake só com o que camadas() usa: lerEnv por caminho
const vaultCom = (mapa) => ({
  async datastore() {
    const items = Object.entries(mapa).map(([nome, vars]) => ({ id: nome, type: "environment_variables", name: nome, secret_id: nome, secret_key: "k" }));
    return { kind: "datastore", id: "ds", key: "k", tree: { folders: [{ id: "f", name: "repo", items }] } };
  },
  async lerSecret(item) { return { [VARS_FIELD]: mapa[item.secret_id] }; },
});

test("cascata: _shared -> base -> branch -> .env -> .env.local -> .env.<branch>.local", async () => {
  const d = repo("repo");
  execFileSync("git", ["-C", d, "checkout", "-q", "-b", "feat/x"]);
  writeFileSync(path.join(d, ".env"), "A=env\nE=1\n");
  writeFileSync(path.join(d, ".env.local"), "A=local\n");
  writeFileSync(path.join(d, ".env.feat-x.local"), "A=branchlocal\n");
  const v = vaultCom({ _shared: [{ key: "S", value: "1" }], base: [{ key: "A", value: "base" }, { key: "B", value: "1" }],
                       "feat-x": [{ key: "A", value: "br" }, { key: "N", value: "1" }] });
  const r = await camadas(v, projeto(d));
  assert.equal(r.branch, "feat/x");
  assert.deepEqual(r.camadas.map((c) => c.nome), ["vault:_shared", "vault:base", "vault:feat-x", ".env", ".env.local", ".env.feat-x.local"]);
  assert.deepEqual(chavesNovas(r.vault, r.locais), [{ key: "E", value: "1" }]);
});

test("na trunk a camada de branch não entra, mesmo que exista secret com esse nome", async () => {
  const d = repo("repo");
  execFileSync("git", ["-C", d, "checkout", "-q", "-b", "main"]);
  const v = vaultCom({ base: [{ key: "A", value: "1" }], main: [{ key: "X", value: "1" }] });
  const r = await camadas(v, projeto(d));
  assert.deepEqual(r.camadas.map((c) => c.nome), ["vault:base"]);
});

test("chavesNovas: só o que não está em nenhuma camada do vault; a última local dá o valor", () => {
  const vault = [{ nome: "vault:base", vars: [{ key: "A", value: "1" }] }];
  const locais = [{ nome: ".env", vars: [{ key: "A", value: "x" }, { key: "N", value: "1" }] }, { nome: ".env.local", vars: [{ key: "N", value: "2" }] }];
  assert.deepEqual(chavesNovas(vault, locais), [{ key: "N", value: "2" }]);
});

test("camadas com baseOpcional: sem base não morre, temBase=false; sem a opção morre", async () => {
  const d = repo("repo");
  const v = vaultCom({});
  const r = await camadas(v, projeto(d), { baseOpcional: true });
  assert.equal(r.temBase, false); assert.deepEqual(r.camadas, []);
  await assert.rejects(camadas(v, projeto(d)), /secret não existe/);
});

import { Readable, Writable } from "node:stream";
import { readFileSync, statSync } from "node:fs";
import { perguntar, tomlCredencial, gravarPrivado } from "../src/setup.mjs";
import { parseTomlSimples } from "../src/cli.mjs";

test("setup: perguntar lê do stream; toml round-tripa os 4 campos; arquivo 0600", async () => {
  const out = new Writable({ write(_c, _e, cb) { cb(); } });
  assert.equal(await perguntar("x: ", { secreto: true, input: Readable.from(["  abc \n"]), output: out }), "abc");
  const cfg = { server_url: "https://p.x/server", api_key_id: "id-1", api_key_private_key: "a".repeat(64), api_key_secret_key: "b".repeat(64) };
  const p = path.join(mkdtempSync(path.join(tmpdir(), "pe-")), ".psono-env.toml");
  gravarPrivado(p, tomlCredencial(cfg));
  assert.deepEqual(parseTomlSimples(readFileSync(p, "utf8")), cfg);
  if (process.platform !== "win32") assert.equal(statSync(p).mode & 0o777, 0o600);
});

test("sem credencial: sync segue (fail-open) mas aponta o setup; ls morre apontando o setup", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pe-repo-"));
  execFileSync("git", ["init", "-q", "-b", "feat/x", dir]);
  const env = { ...process.env, PSONO_SERVER_URL: "", PSONO_API_KEY_ID: "", PSONO_API_KEY_PRIVATE_KEY: "", PSONO_API_KEY_SECRET_KEY: "",
                PSONO_ENV_CONFIG: path.join(dir, "nao.toml"), HOME: dir, USERPROFILE: dir };
  const bin = path.resolve("bin/psono-env.mjs");
  const r = execFileSync(process.execPath, [bin, "sync"], { cwd: dir, env, stdio: "pipe" });
  let code = 0, err = "";
  try { execFileSync(process.execPath, [bin, "ls"], { cwd: dir, env, stdio: "pipe" }); } catch (e) { code = e.status; err = String(e.stderr); }
  assert.notEqual(code, 0);
  assert.match(err, /psono-env setup/);
});
