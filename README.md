# Urna Simulada — projeto educacional

Aplicação demonstrativa para estudar interfaces, APIs e controles de integridade. **Não é uma urna oficial nem segura para eleições reais.** A implementação não oferece sigilo eleitoral comprovável, resistência a administrador malicioso, operação offline controlada, auditoria independente ou certificação.

## Arquitetura

- `web/`: React + Vite; interface de urna responsiva e modo `?demo=1` sem persistência.
- `api/`: Node.js + Express; validação com Zod, cabeçalhos Helmet, limitação básica de requisições e Firebase Admin.
- Firestore: persistência em transações; credenciais administrativas somente no servidor via Application Default Credentials.
- `audit_logs`: trilha administrativa minimizada; nunca incluir CPF ou token nesses eventos.

## Executar localmente

1. Instale Node.js 20 ou superior e execute `npm install` na raiz.
2. Copie `.env.example` para `.env` e defina três segredos aleatórios distintos com pelo menos 32 caracteres.
3. Configure Application Default Credentials do Firebase Admin (ou `GOOGLE_APPLICATION_CREDENTIALS` apontando para uma chave local não versionada). Habilite o Firestore no projeto.
4. Publique `firestore.rules` no projeto com `firebase deploy --only firestore:rules` (o SDK Admin usa IAM e ignora essas regras; elas bloqueiam acesso direto do navegador).
5. Rode `npm run dev`. A interface estará em `http://localhost:5173`; a API, em `http://localhost:4000/api`.
5. Para testar a interface isolada, abra `http://localhost:5173/?demo=1`. Esse modo usa candidatos fictícios e não envia votos.

O `api` usa o `FIREBASE_PROJECT_ID` fornecido no `.env.example`. A configuração `apiKey` do Firebase Web não é uma credencial administrativa e não deve ser usada como autenticação. Nunca coloque service account, segredos HMAC ou chave do mesário no navegador/repositório.

## Fluxo e rotas

Todas as rotas administrativas e de mesário abaixo recebem `Authorization: Bearer <MESARIO_API_KEY>`.

O painel é acessado em `http://localhost:5173/?admin=1`; ele permite criar eleição, eleitores, candidatos, abrir/encerrar votação, liberar token e ver/baixar o BU. A entrada da chave é uma tela demonstrativa, não uma autenticação de produção. A urna fica em `http://localhost:5173/`; para modo desconectado, use `?demo=1`.

1. `POST /api/admin/elections` `{ "name": "Demonstração", "offices": ["Deputado", "Governador"] }` cria pleito em rascunho com a ordem dos cargos. Se `offices` for omitido, usa `Vereador`.
2. `POST /api/admin/voters` `{ "electionId": "...", "cpf": "...", "name": "Eleitor de teste" }` registra/associa eleitor ao pleito; CPF de teste precisa passar nos dígitos verificadores.
3. `POST /api/admin/candidates` `{ "electionId": "...", "office": "Vereador", "number": "12345", "name": "Ana Exemplo", "party": "EDU", "photoUrl": "https://..." }` cadastra candidatura.
4. `PATCH /api/admin/elections/:id` `{ "status": "open" }` abre a votação.
5. `POST /api/mesario/release` `{ "electionId": "...", "cpf": "..." }` retorna token de uso único para a urna.
6. A urna consulta `GET /api/elections/:id` e `GET /api/elections/:id/candidates`. `POST /api/vote` `{ "electionId": "...", "token": "...", "office": "Deputado", "choice": "candidate", "candidateNumber": "12345" }`. `choice` aceita `candidate`, `blank` ou `null`. O mesmo token pode registrar cada cargo uma vez; a interface avança na ordem configurada e finaliza após o último.
7. `PATCH /api/admin/elections/:id` `{ "status": "closed" }` encerra pleito e retorna o BU; também disponível em `GET /api/elections/:id/bulletin`.

**Atenção:** o segredo compartilhado do mesário é apenas um atalho local de demonstração. Não o use em produção. O encerramento bloqueia novos votos e gera o boletim.

## Modelo Firestore

| Coleção | Documento/campos | Observação |
|---|---|---|
| `elections` | nome, status, `voteCount`, `chainHead`, datas | Cabeça do encadeamento e estado do pleito |
| `voters` | ID = HMAC(CPF), nome, data de cadastro | CPF em claro não é persistido; HMAC reduz exposição direta |
| `participation` | ID = HMAC(pleito + CPF), `electionId`, chave pseudônima do eleitor, `votedOffices`, `voted` | Controle de comparecimento por pleito e por cargo |
| `candidates` | pleito, cargo, número, nome, partido, foto | Dados públicos da candidatura |
| `voter_releases` | ID = SHA-256(token), pleito, chave pseudônima de participação, cargos usados, expiração | Token de autorização; não é armazenado em claro |
| `ballots` | pleito, cargo, escolha, número opcional, nonce, sequência, digest, assinatura | Não tem campo de CPF/eleitor/token |
| `audit_logs` | evento, detalhes minimizados, data | Não registrar escolhas, CPF ou token |

## Segurança demonstrada e limites

- **CPF:** validação de formato e dígitos verificadores; a identificação documental é um HMAC com segredo do servidor em vez do CPF bruto. O nome continua dado pessoal e deve ser minimizado/retido pelo menor tempo necessário.
- **Prevenção de repetição:** a gravação usa transação Firestore que verifica pleito aberto, token não usado e eleitor não votou; registra cédula e marca eleitor/token como usados na mesma transação. Concorrência é reavaliada pelo Firestore. Token não é aceito após o primeiro uso.
- **Separação lógica:** cédula não carrega identificador eleitoral. Entretanto, a transação conjunta, os horários, sequência e metadados podem permitir correlação. Firestore e operadores privilegiados podem observar relações temporais; portanto isso **não prova anonimato**.
- **Integridade:** cada voto inclui hash do voto e hash anterior, com HMAC-SHA-256 usando chave do servidor; a cabeça fica no pleito. O BU tem HMAC para detectar alteração por quem não possui a chave. SHA/HMAC não substitui assinatura assimétrica nem auditoria independente. Uma conta privilegiada ou chave comprometida ainda pode adulterar dados.
- **Abstenções:** estimadas como participações cadastradas para o pleito menos eleitores que concluíram todos os cargos. O total de votos do BU agrega cédulas de todos os cargos; os subtotais são apresentados em `byOffice`.
- **Hardening necessário:** autenticação individual de mesários e autorização por função, MFA, regras IAM/firestore mínimo privilégio, rotação/gestão de segredos, trilha append-only externa, backup testado, revisão de privacidade, proteção contra CSRF quando houver cookies, monitoramento, procedimento de auditoria e testes de carga/concorrência.

Este protótipo é intencionalmente limitado a ensino e testes controlados. Não reutilize seus componentes como sistema eleitoral real.
