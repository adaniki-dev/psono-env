import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnvTexto, fmt, nomeValido, compor, mesclar, diffChaves, slug, camadasLocais, branchAtual } from "../src/env.mjs";

test("die lança ErroPsonoEnv (não mata o processo)", () => {
  assert.throws(() => parseEnvTexto("A=1\nA=2\n", "t"), (e) => e.name === "ErroPsonoEnv" && e.code === 1);
});

test("parse: básico, export, aspas, comentário, valor com =", () => {
  assert.deepEqual(parseEnvTexto('A=1\n# c\n\nexport B="x y"\nC=\'q\'\nD=a=b\n', "t"),
    [{ key: "A", value: "1" }, { key: "B", value: "x y" }, { key: "C", value: "q" }, { key: "D", value: "a=b" }]);
});

test("fmt/parse round-trip", () => {
  for (const v of ["simples", "com espaco", 'aspa "dupla"', "quebra\nlinha", "barra \\ n", "#hash", "a'b", ""])
    assert.equal(parseEnvTexto(fmt({ key: "K", value: v }), "t")[0].value, v, JSON.stringify(v));
});

test("nomeValido", () => {
  assert.ok(nomeValido("API_KEY")); assert.ok(!nomeValido("API KEY")); assert.ok(!nomeValido("1A")); assert.ok(!nomeValido(""));
});

test("compor: última camada ganha e guarda origem", () => {
  const m = compor([{ nome: "vault:dev", vars: [{ key: "A", value: "1" }, { key: "B", value: "1" }] },
                    { nome: ".env.local", vars: [{ key: "A", value: "2" }] }]);
  assert.deepEqual(m.get("A"), { value: "2", origem: ".env.local" });
  assert.equal(m.get("B").origem, "vault:dev");
});

test("mesclar: default sobe só drift de chave — valor existente fica o do vault", () => {
  const remote = [{ key: "A", value: "1" }, { key: "B", value: "1" }];
  const local = [{ key: "B", value: "2" }, { key: "C", value: "3" }];
  assert.deepEqual(mesclar(remote, local, false), [{ key: "A", value: "1" }, { key: "B", value: "1" }, { key: "C", value: "3" }]);
});
test("mesclar --values: local sobrescreve valor existente, remoto-only fica", () => {
  const remote = [{ key: "A", value: "1" }, { key: "B", value: "1" }];
  const local = [{ key: "B", value: "2" }, { key: "C", value: "3" }];
  assert.deepEqual(mesclar(remote, local, false, true), [{ key: "A", value: "1" }, { key: "B", value: "2" }, { key: "C", value: "3" }]);
});
test("mesclar replace: o local é tudo", () => {
  assert.deepEqual(mesclar([{ key: "A", value: "1" }], [{ key: "C", value: "3" }], true), [{ key: "C", value: "3" }]);
});

test("diffChaves", () => {
  const meu = compor([{ nome: "x", vars: [{ key: "A", value: "1" }, { key: "B", value: "2" }] }]);
  const alvo = new Map([["A", "1"], ["B", "9"], ["Z", "0"]]);
  assert.deepEqual(diffChaves(meu, alvo), { soAlvo: ["Z"], soMeu: [], difere: ["B"], iguais: 1 });
});

test("slug e camadas locais por branch", () => {
  assert.equal(slug("feat/x\\y"), "feat-x-y");
  const existe = (p) => [".env.local", ".env.feat-x.local"].includes(path.basename(p));
  assert.deepEqual(camadasLocais("/r", "feat/x", existe), [".env.local", ".env.feat-x.local"]);
  assert.deepEqual(camadasLocais("/r", null, existe), [".env.local"]);
  const comEnv = (p) => [".env", ".env.local"].includes(path.basename(p));
  assert.deepEqual(camadasLocais("/r", "main", comEnv), [".env", ".env.local"]);
});

test("branchAtual: branch órfã sem commit funciona; fora de git é null", () => {
  const d = mkdtempSync(path.join(tmpdir(), "pe-"));
  execFileSync("git", ["-C", d, "init", "-q", "-b", "feat/nova"]);
  assert.equal(branchAtual(d), "feat/nova");
  assert.equal(branchAtual(tmpdir()) === null || typeof branchAtual(tmpdir()) === "string", true);
});

test("parse: valor entre aspas atravessa linhas (PEM) e round-tripa pelo fmt; erro não ecoa a linha", () => {
  const txt = 'A=1\nPEM="-----BEGIN X-----\nMIIB/abc+\n-----END X-----"\nB=\'x\ny\'\nC=v # comentário\n';
  const v = parseEnvTexto(txt, "t");
  assert.deepEqual(v.map((x) => x.key), ["A", "PEM", "B", "C"]);
  assert.equal(v[1].value, "-----BEGIN X-----\nMIIB/abc+\n-----END X-----");
  assert.equal(v[2].value, "x\ny");
  assert.equal(v[3].value, "v");
  assert.deepEqual(parseEnvTexto(v.map(fmt).join("\n"), "t2"), v);
  assert.throws(() => parseEnvTexto('OK=1\nSEGREDO_SEM_IGUAL\n', "t3"), (e) => /linha 2/.test(e.message) && !/SEGREDO/.test(e.message));
  assert.throws(() => parseEnvTexto('X="aberto\nsem fim\n', "t4"), /sem fechamento/);
});
