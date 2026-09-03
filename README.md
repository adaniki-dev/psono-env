# psono-env

Env em camadas pra time: a pasta do Psono com o **nome do repo** guarda o env de referência
(`base`), e cada branch que precisa de chave nova ganha o próprio secret **sozinha no `git push`**.
Zero config por repo. Roda como devDependency.

```
1. /<repo>/_shared        camada comum, se existir
2. /<repo>/base           o env de referência de desenvolvimento
3. /<repo>/<branch>       chaves novas desta branch, se existir
4. .env, .env.local       esta máquina
5. .env.<branch>.local    esta máquina, só nesta branch
```
O de baixo ganha. Não tem main nem staging aqui: é ferramenta de desenvolvedor.

## Convenção no Psono

Uma pasta na raiz do datastore (ou compartilhada) com o **mesmo nome da pasta raiz do repo git**
(`wascer-backend`, `admin-wascer`...), e dentro dela um secret *Environment Variables* chamado
`base`. Os secrets de branch (`feat-pagamento`) nascem sozinhos. Opcional: `_shared`.

## Instalar no projeto

```sh
npm i -D github:adaniki-dev/psono-env husky
npx husky init
echo "npx psono-env sync" > .husky/pre-push
```
```json
{ "scripts": { "dev": "psono-env run -- next dev" } }
```
`.gitignore`: `.env`, `.env.local`, `.env.*.local`.

## O ciclo

1. `psono-env run -- next dev` roda com `base` do vault por baixo e o teu `.env.local` por cima.
   Valor pessoal nunca sai da máquina. Prefere arquivo? `psono-env pull --into .env` acrescenta o
   que falta e não mexe no que já tem.
2. Tu cria uma feature que precisa de `PIX_KEY`, põe no `.env.local`, dá `git push`. O hook roda
   `psono-env sync`: a chave é nova em relação ao vault, então sobe pra `/<repo>/feat-pagamento`
   (cria o secret se não existe). Só chave nova sobe; valor que já existe no vault nunca é tocado.
3. Outro dev entra na branch: a cascata já puxa `/<repo>/feat-pagamento` por cima da base.
4. Branch integrada: `psono-env promote feat/pagamento --rm` funde as chaves na `base` e manda o
   secret da branch pro lixo do Psono. Na trunk (`main`, `master`, `develop`) o `sync` sobe direto
   pra `base`, então um push na main também promove.

`sync` é **fail-open**: sem credencial ou sem rede ele avisa e deixa o push passar
(`--strict` pra travar).

## Credencial (por máquina, nunca no repo)

API key no Psono (Other → API Keys): **Secret Restriction desmarcado**, "Allow insecure usage"
desmarcado, read e write marcados. Não precisa linkar secret. Copia as três chaves pra
`~/.psono-env.toml`:

```toml
server_url = "https://psono.exemplo/server"
api_key_id = "..."
api_key_private_key = "..."
api_key_secret_key = "..."
```
Também aceita variáveis `PSONO_SERVER_URL`, `PSONO_API_KEY_ID`, `PSONO_API_KEY_PRIVATE_KEY`,
`PSONO_API_KEY_SECRET_KEY` (CI). No WSL o arquivo em `C:\Users\<user>\` também é achado.

Key sem restrição enxerga tudo que o usuário enxerga. Pra limitar, usa um usuário Psono
dedicado que só recebe as pastas de env por share.

## Comandos

```sh
psono-env ls                        # o vault (pastas e secrets de env)
psono-env resolve                   # quem ganhou cada chave
psono-env run -- next dev           # env composto, nada toca disco
psono-env sync                      # sobe chaves novas pra /<repo>/<branch> (o hook chama isso)
psono-env promote [branch] [--rm]   # funde as chaves da branch na base
psono-env diff prod                 # vs outro secret, só nomes; exit 2 se faltar chave (gate de CI)
psono-env pull --into .env          # acrescenta ao .env as chaves do vault que faltam (não toca nas tuas)
psono-env pull > .env               # base como arquivo, se precisar
psono-env push base .env            # dry-run: drift de chaves (chave nova sobe; valor existente fica)
psono-env push base .env --values   # também sobrescreve valores existentes
psono-env push base .env --replace  # espelho exato: o que falta no arquivo morre no vault
```
Caminho absoluto também vale: `psono-env pull /Kronos/staging/backend`.

## Override (só se a convenção não servir)

No `package.json`:
```json
{ "psono-env": { "base": "/Wascer/Backend", "baseSecret": "Staging", "shared": null, "trunk": ["main"], "protect": ["prod"] } }
```
ou o mesmo objeto num `.psono-env.json` na raiz (ganha do package.json).

## Dev

```sh
npm test        # node --test
```
Cliente próprio da API do Psono (`src/vault.mjs`, tweetnacl): login por API key em sessão,
datastore, shares aninhados, criar/editar secret, lixo. `psonoci` só opera por uuid; `psonoapi`
(Python) anda em pasta mas quebra em item compartilhado solto. Este usa a árvore crua, como a
UI escreve.
