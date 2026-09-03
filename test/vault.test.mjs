import { test } from "node:test";
import assert from "node:assert/strict";
import { resolverCaminho, listar, lerEnv, VARS_FIELD } from "../src/vault.mjs";

class FakeVault {
  constructor() {
    this.shares = {
      "sh-wascer": { name: "Wascer", folders: [
        { id: "f1", name: "Backend", items: [
          { id: "i1", type: "environment_variables", name: "Staging", secret_id: "s1", secret_key: "k1" },
          { id: "i2", type: "note", name: "readme", secret_id: "s2", secret_key: "k2" }] },
        { id: "f2", name: "Kronos", share_id: "sh-kronos", share_secret_key: "sk" }],
        items: [{ id: "i3", type: "environment_variables", name: "resend", secret_id: "s3", secret_key: "k3" }] },
      "sh-kronos": { name: "Kronos", folders: [
        { id: "f3", name: "staging", items: [
          { id: "i4", type: "environment_variables", name: "_shared", secret_id: "s4", secret_key: "k4" },
          { id: "i5", type: "environment_variables", name: "backend", secret_id: "s5", secret_key: "k5" },
          { id: "i9", type: "environment_variables", name: "morto", secret_id: "s9", secret_key: "k9", deleted: true }] }] },
    };
    this.secrets = { s1: [{ key: "A", value: "vault-a" }], s4: [{ key: "SHARED", value: "1" }], s5: [{ key: "A", value: "b" }] };
  }
  async datastore() {
    return { kind: "datastore", id: "ds", key: "dk", tree: {
      folders: [{ id: "f0", name: "Wascer", share_id: "sh-wascer", share_secret_key: "sk" }, { id: "f9", name: "Solta", items: [] }],
      items: [{ id: "i8", name: "Tech gmail", share_id: "sh-item", share_secret_key: "x" }] } };
  }
  async share(id, key) { return { kind: "share", id, key, tree: this.shares[id], rights: { write: true } }; }
  async lerSecret(item) { return { [VARS_FIELD]: this.secrets[item.secret_id] }; }
}

const v = new FakeVault();

test("secret dentro de share", async () => {
  const r = await resolverCaminho(v, "/Wascer/Backend/Staging");
  assert.equal(r.item.secret_id, "s1"); assert.equal(r.store.id, "sh-wascer"); assert.deepEqual(r.faltou, []);
});
test("share dentro de share, sem barra inicial", async () => {
  const r = await resolverCaminho(v, "Wascer/Kronos/staging/backend");
  assert.equal(r.item.secret_id, "s5"); assert.equal(r.store.id, "sh-kronos");
});
test("pasta e raiz", async () => {
  assert.equal((await resolverCaminho(v, "/Wascer/Backend")).pastaAlvo.id, "f1");
  assert.equal((await resolverCaminho(v, "/")).store.kind, "datastore");
});
test("item na raiz do share", async () => {
  assert.equal((await resolverCaminho(v, "/Wascer/resend")).item.secret_id, "s3");
});
test("faltou só o último: pasta e store certos pra criar", async () => {
  const r = await resolverCaminho(v, "/Wascer/Backend/Novo");
  assert.equal(r.item, null); assert.deepEqual(r.faltou, ["Novo"]); assert.equal(r.pasta.id, "f1"); assert.equal(r.store.id, "sh-wascer");
});
test("faltou pasta no meio", async () => {
  assert.deepEqual((await resolverCaminho(v, "/Wascer/Nada/x")).faltou, ["Nada", "x"]);
});
test("deletado não aparece", async () => {
  assert.deepEqual((await resolverCaminho(v, "/Wascer/Kronos/staging/morto")).faltou, ["morto"]);
});
test("ls não quebra em item compartilhado solto na raiz", async () => {
  const out = []; await listar(v, "/", false, (l) => out.push(l));
  assert.ok(out.includes("  - Tech gmail  (share)")); assert.ok(out.includes("    📁 Kronos  [share]"));
});
test("lerEnv: opcional devolve null; tipo errado morre com ErroPsonoEnv", async () => {
  assert.equal(await lerEnv(v, "/Wascer/Backend/nope", false), null);
  await assert.rejects(lerEnv(v, "/Wascer/Backend/readme"), (e) => e.name === "ErroPsonoEnv" && /note/.test(e.message));
  await assert.rejects(lerEnv(v, "/Wascer/Backend"), /é uma pasta/);
});
