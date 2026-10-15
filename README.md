# Urna simulada — Supabase

Aplicação de demonstração educacional. Não é uma urna oficial, não fornece sigilo eleitoral comprovável e não deve ser usada em eleições reais.

## Arquitetura

- `web/`: React + Vite para a urna e o painel em `/?admin=1`.
- `api/`: Node.js + Express, validação Zod, Helmet, limitação de tentativas e autenticação administrativa.
- `supabase/migrations/`: esquema PostgreSQL, RPCs transacionais e RLS. A API usa `@supabase/supabase-js` com uma chave secreta apenas no servidor.

O GitHub Pages hospeda apenas o front-end estático. Para cadastros e votação persistentes, a API Express precisa estar em um serviço de backend com HTTPS. Configure a variável de repositório `VITE_API_URL` com a URL pública da API para o workflow do Pages.

## Configuração do Supabase

1. No painel do projeto `kpevvdhvnzkontwcvwyd`, abra **SQL Editor** e execute o conteúdo de `supabase/migrations/20261015000000_urna_schema.sql`.
2. Em **Project Settings → API Keys**, crie/rotacione a chave `sb_secret_...` que fica somente no backend. A chave compartilhada em conversa deve ser rotacionada. Nunca a coloque no navegador, em `VITE_*`, no GitHub Pages ou no Git.
3. Copie `.env.example` para `.env` e configure `SUPABASE_PROJECT_ID`, `SUPABASE_SECRET_KEY`, `ADMIN_USERNAME`, o hash da senha e três segredos aleatórios diferentes, cada um com pelo menos 32 caracteres.
4. Gere o hash administrativo com `npm run admin:hash -w api` e informe a senha quando solicitado. Guarde apenas o valor `salt:hash` em `ADMIN_PASSWORD_HASH`.
5. Mantenha RLS habilitado e sem permissões para `anon`/`authenticated`. O SQL concede acesso às tabelas e RPCs apenas a `service_role`; não crie políticas públicas para essas tabelas.

## Executar localmente

No PowerShell, na raiz do projeto:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

A aplicação fica em `http://localhost:5173`, o painel em `http://localhost:5173/?admin=1` e a API em `http://localhost:4000/api`. Configure `WEB_ORIGIN=http://localhost:5173` no `.env` para liberar o acesso local. No ambiente de hospedagem, defina as variáveis do `.env.example` no gerenciador de segredos do provedor e ajuste `WEB_ORIGIN` para a origem exata do front-end.

## Operações disponíveis

O painel permite criar, listar, abrir, encerrar e remover eleições em rascunho; cadastrar, listar, editar e remover eleitores e candidatos; liberar a urna por CPF; e gerar/baixar o boletim JSON. Edição e remoção de eleitores/candidatos só são permitidas enquanto o pleito está em rascunho. Fotos são referenciadas por URL HTTPS.

Rotas administrativas exigem `Authorization: Bearer <sessão>`:

- `POST /api/auth/login`, `GET /api/auth/session`
- `/api/admin/elections` — GET, POST; `/:id` — PATCH, DELETE
- `/api/admin/voters` — GET, POST; `/:id` — PATCH, DELETE
- `/api/admin/candidates` — GET, POST; `/:id` — PATCH, DELETE
- `POST /api/admin/release`
- `GET /api/elections/:id/bulletin` (sessão administrativa)

A urna usa `GET /api/elections/:id`, `GET /api/elections/:id/candidates` e `POST /api/vote`. Cada liberação recebe token aleatório temporário. A transação SQL confere o vínculo do token com a eleição, validade, cargo e voto anterior antes de inserir a cédula.

## Modelo de dados

| Tabela | Conteúdo |
|---|---|
| `elections` | Pleito, cargos, estado, contador e cabeça da cadeia |
| `voters` | Nome e HMAC do CPF (não o CPF em claro) |
| `participation` | Vínculo eleitor/pleito e status de comparecimento |
| `candidates` | Cargo, número, nome, partido e URL da foto |
| `voter_releases` | Hash do token, vínculo, cargos usados e expiração |
| `ballots` | Escolha, sequência, hash anterior, digest e HMAC; sem CPF/ID/token do eleitor |
| `audit_logs` | Eventos administrativos minimizados |
| `bulletins` | JSON e HMAC do boletim encerrado |

## Segurança e limites

- O CPF é validado e transformado em HMAC com segredo do servidor antes de consultar/gravar. Não é criptografia reversível nem anonimização: nomes, tempos e acessos administrativos continuam sensíveis.
- O registro da cédula e a atualização de participação/token/cabeça da cadeia acontecem numa função PostgreSQL transacional. Chaves únicas e bloqueios de linha ajudam a impedir repetição concorrente.
- Cédulas não contêm identificadores diretos do eleitor. A sequência temporal e o acesso privilegiado ao banco ainda podem permitir correlação; esta separação não prova sigilo eleitoral.
- Cada voto encadeia SHA-256 ao digest anterior e recebe HMAC com segredo do servidor. O boletim recalcula a cadeia e assina o resumo. Isso detecta alterações sem a chave, mas não impede um operador com chave/acesso privilegiado de adulterar dados. Não é blockchain pública nem assinatura digital assimétrica.
- A chave secreta Supabase ignora RLS; por isso fica apenas no backend. Mantenha variáveis de ambiente fora do Git, use HTTPS e rotacione qualquer segredo exposto.
- O login de usuário/senha e sessão HMAC é simplificado para demonstração. Para produção seriam necessários provedor de identidade/MFA, gestão e revogação robusta de sessões, monitoramento e auditoria independente.

## Deploy

Hospede `api/` num serviço compatível com Node.js, configure as variáveis de `.env.example` e a porta `PORT`. Configure `WEB_ORIGIN` para a origem do Pages. Em GitHub, crie a variável **Settings → Secrets and variables → Actions → Variables → New repository variable** com nome `VITE_API_URL` e valor base da API, incluindo `https://` e sem `/api`; execute novamente o workflow **Deploy GitHub Pages**.

O front-end público do Pages não recebe a chave secreta do Supabase. O endereço do painel será `https://mpcsolutionstec.github.io/urna-eletronica/?admin=1` após a publicação do workflow.
