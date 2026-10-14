import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, FieldValue } from './firestore.js';
import { canonicalJson, createAdminSession, hmac, passwordMatches, randomToken, secureEqual, sha256, validCpf, verifyAdminSession, requireKeys } from './security.js';

requireKeys();
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '32kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' } });

const api = express.Router();
const elections = db.collection('elections');
const voters = db.collection('voters');
const participation = db.collection('participation');
const candidates = db.collection('candidates');
const releases = db.collection('voter_releases');
const ballots = db.collection('ballots');
const logs = db.collection('audit_logs');
const cpfKey = () => process.env.CPF_HMAC_KEY;
const integrityKey = () => process.env.INTEGRITY_HMAC_KEY;
const cpfId = (cpf) => hmac(cpfKey(), String(cpf).replace(/\D/g, ''));
const candidateId = (electionId, office, number) => sha256(JSON.stringify([electionId, office, number]));

function adminAuth(req, res, next) {
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!verifyAdminSession(supplied, process.env.ADMIN_SESSION_KEY)) return res.status(401).json({ error: 'Sessão administrativa inválida ou expirada.' });
  next();
}
const audit = (event, detail = {}) => logs.add({ event, detail, at: FieldValue.serverTimestamp() });
const idParam = z.string().min(1).max(100);

api.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'simulacao-educacional' }));
api.post('/auth/login', loginLimiter, async (req, res) => {
  const parsed = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) }).safeParse(req.body);
  const usernameMatches = parsed.success && secureEqual(parsed.data.username, process.env.ADMIN_USERNAME);
  const passwordMatchesAdmin = passwordMatches(parsed.success ? parsed.data.password : '', process.env.ADMIN_PASSWORD_HASH);
  if (!usernameMatches || !passwordMatchesAdmin) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  await audit('admin_login');
  res.json({ token: createAdminSession(process.env.ADMIN_USERNAME, process.env.ADMIN_SESSION_KEY), expiresInSeconds: 3600 });
});
api.get('/auth/session', adminAuth, (_req, res) => res.json({ status: 'authenticated', role: 'admin' }));

// Todas as operações de cadastro e liberação são exclusivas da conta de administrador.
api.post('/admin/elections', adminAuth, async (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(120), offices: z.array(z.string().min(1).max(60)).min(1).max(12).default(['Vereador']), status: z.literal('draft').default('draft') }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos.' });
  const ref = await elections.add({ ...parsed.data, chainHead: '0'.repeat(64), voteCount: 0, createdAt: FieldValue.serverTimestamp() });
  await audit('election_created', { electionId: ref.id });
  res.status(201).json({ id: ref.id });
});

api.post('/admin/voters', adminAuth, async (req, res) => {
  const parsed = z.object({ electionId: idParam, cpf: z.string(), name: z.string().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success || !validCpf(parsed.data?.cpf)) return res.status(400).json({ error: 'CPF ou dados inválidos.' });
  const ref = voters.doc(cpfId(parsed.data.cpf));
  const electionRef = elections.doc(parsed.data.electionId);
  const participationRef = participation.doc(hmac(cpfKey(), `${parsed.data.electionId}:${String(parsed.data.cpf).replace(/\D/g, '')}`));
  await db.runTransaction(async (tx) => {
    const election = await tx.get(electionRef);
    if (!election.exists || election.data().status !== 'draft') throw Object.assign(new Error('Eleição não encontrada ou já aberta.'), { status: 409 });
    const voter = await tx.get(ref);
    if (!voter.exists) tx.create(ref, { name: parsed.data.name, createdAt: FieldValue.serverTimestamp() });
    tx.create(participationRef, { electionId: parsed.data.electionId, voterKey: ref.id, voted: false, createdAt: FieldValue.serverTimestamp() });
  });
  await audit('voter_registered');
  res.status(201).json({ status: 'cadastrado' });
});

api.post('/admin/candidates', adminAuth, async (req, res) => {
  const parsed = z.object({ electionId: idParam, office: z.string().min(1).max(60), number: z.string().regex(/^\d{2,5}$/), name: z.string().min(1).max(120), party: z.string().min(1).max(40), photoUrl: z.string().url().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados do candidato inválidos.' });
  const ref = candidates.doc(candidateId(parsed.data.electionId, parsed.data.office, parsed.data.number));
  try {
    await db.runTransaction(async (tx) => {
      const election = await tx.get(elections.doc(parsed.data.electionId));
      if (!election.exists || election.data().status !== 'draft') throw Object.assign(new Error('Cadastre candidatos antes de abrir o pleito.'), { status: 409 });
      const existing = await tx.get(ref);
      if (existing.exists) throw Object.assign(new Error('Número já cadastrado para este cargo.'), { status: 409 });
      tx.create(ref, { ...parsed.data, createdAt: FieldValue.serverTimestamp() });
    });
  } catch (err) { return res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Falha ao cadastrar candidato.' }); }
  res.status(201).json({ id: ref.id });
});

api.patch('/admin/elections/:id', adminAuth, async (req, res) => {
  const parsed = z.object({ status: z.enum(['open', 'closed']) }).safeParse(req.body);
  if (!parsed.success || !idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'Dados inválidos.' });
  const ref = elections.doc(req.params.id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error('Eleição não encontrada.'), { status: 404 });
    if (snap.data().status === 'closed') throw Object.assign(new Error('Eleição encerrada é imutável.'), { status: 409 });
    tx.update(ref, { status: parsed.data.status, ...(parsed.data.status === 'closed' ? { closedAt: FieldValue.serverTimestamp() } : {}) });
  });
  await audit(`election_${parsed.data.status}`, { electionId: ref.id });
  if (parsed.data.status === 'closed') return res.json(await buildBulletin(ref.id));
  res.json({ id: ref.id, status: 'open' });
});

api.get('/elections/:id/candidates', async (req, res) => {
  if (!idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID inválido.' });
  const snap = await candidates.where('electionId', '==', req.params.id).get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
});
api.get('/elections/:id', async (req, res) => {
  if (!idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID inválido.' });
  const snap = await elections.doc(req.params.id).get();
  if (!snap.exists) return res.status(404).json({ error: 'Eleição não encontrada.' });
  res.json({ id: snap.id, name: snap.data().name, status: snap.data().status, offices: snap.data().offices });
});

// Libera um eleitor e entrega um token de uso único. O CPF não é guardado no token nem nos logs.
api.post('/admin/release', adminAuth, async (req, res) => {
  const parsed = z.object({ electionId: idParam, cpf: z.string() }).safeParse(req.body);
  if (!parsed.success || !validCpf(parsed.data?.cpf)) return res.status(400).json({ error: 'CPF ou eleição inválidos.' });
  const { electionId, cpf } = parsed.data;
  const voterRef = voters.doc(cpfId(cpf));
  const participationRef = participation.doc(hmac(cpfKey(), `${electionId}:${String(cpf).replace(/\D/g, '')}`));
  const electionRef = elections.doc(electionId);
  const token = randomToken();
  const tokenRef = releases.doc(sha256(token));
  try {
    await db.runTransaction(async (tx) => {
      const [election, voter, voterProfile] = await Promise.all([tx.get(electionRef), tx.get(participationRef), tx.get(voterRef)]);
      if (!election.exists || election.data().status !== 'open') throw Object.assign(new Error('Eleição não está aberta.'), { status: 409 });
      if (!voterProfile.exists || !voter.exists) throw Object.assign(new Error('Eleitor não cadastrado para esta eleição.'), { status: 404 });
      if (voter.data().voted) throw Object.assign(new Error('Eleitor já votou nesta eleição.'), { status: 409 });
      tx.create(tokenRef, { electionId, participationKey: participationRef.id, usedOffices: [], used: false, expiresAt: new Date(Date.now() + 10 * 60_000), createdAt: FieldValue.serverTimestamp() });
    });
    await audit('voter_released', { electionId });
    res.status(201).json({ token, expiresInMinutes: 10 });
  } catch (err) { res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Falha ao liberar eleitor.' }); }
});

// O documento de voto não contém CPF, token, chave do eleitor ou ID de liberação.
api.post('/vote', async (req, res) => {
  const parsed = z.object({ electionId: idParam, token: z.string().min(20).max(200), office: z.string().min(1).max(60), choice: z.enum(['candidate', 'blank', 'null']), candidateNumber: z.string().regex(/^\d{2,5}$/).optional() }).safeParse(req.body);
  if (!parsed.success || (parsed.data.choice === 'candidate' && !parsed.data.candidateNumber) || (parsed.data.choice !== 'candidate' && parsed.data.candidateNumber)) return res.status(400).json({ error: 'Cédula inválida.' });
  const { electionId, token, office, choice, candidateNumber } = parsed.data;
  const electionRef = elections.doc(electionId);
  const tokenRef = releases.doc(sha256(token));
  const voteRef = ballots.doc();
  try {
    await db.runTransaction(async (tx) => {
      const tokenSnap = await tx.get(tokenRef);
      if (!tokenSnap.exists || tokenSnap.data().used || tokenSnap.data().electionId !== electionId || tokenSnap.data().expiresAt.toDate() < new Date()) throw Object.assign(new Error('Token inválido, expirado ou já utilizado.'), { status: 409 });
      const voterRef = participation.doc(tokenSnap.data().participationKey);
      const [electionSnap, voterSnap] = await Promise.all([tx.get(electionRef), tx.get(voterRef)]);
      if (!electionSnap.exists || electionSnap.data().status !== 'open') throw Object.assign(new Error('Eleição encerrada.'), { status: 409 });
      if (!voterSnap.exists || voterSnap.data().voted) throw Object.assign(new Error('Eleitor já votou.'), { status: 409 });
      if (!electionSnap.data().offices.includes(office) || tokenSnap.data().usedOffices.includes(office)) throw Object.assign(new Error('Cargo inválido ou já votado.'), { status: 409 });
      if ((voterSnap.data().votedOffices ?? []).includes(office)) throw Object.assign(new Error('Este cargo já foi votado.'), { status: 409 });
      if (choice === 'candidate') {
        const candidateSnap = await tx.get(candidates.doc(candidateId(electionId, office, candidateNumber)));
        if (!candidateSnap.exists) throw Object.assign(new Error('Número não cadastrado para este cargo.'), { status: 400 });
      }
      const previous = electionSnap.data().chainHead;
      const vote = { electionId, office, choice, ...(candidateNumber ? { candidateNumber } : {}), nonce: randomToken(), recordedAt: new Date().toISOString() };
      const digest = sha256(`${previous}:${canonicalJson(vote)}`);
      const signature = hmac(integrityKey(), digest);
      tx.create(voteRef, { ...vote, sequence: electionSnap.data().voteCount + 1, previousDigest: previous, digest, signature });
      const usedOffices = [...tokenSnap.data().usedOffices, office];
      const participationOffices = [...(voterSnap.data().votedOffices ?? []), office];
      const allOfficesComplete = electionSnap.data().offices.every((item) => participationOffices.includes(item));
      tx.update(voterRef, { votedOffices: FieldValue.arrayUnion(office), voted: allOfficesComplete, ...(allOfficesComplete ? { votedAt: FieldValue.serverTimestamp() } : {}) });
      tx.update(tokenRef, { usedOffices: FieldValue.arrayUnion(office), used: electionSnap.data().offices.every((item) => usedOffices.includes(item)), updatedAt: FieldValue.serverTimestamp() });
      tx.update(electionRef, { chainHead: digest, voteCount: FieldValue.increment(1) });
    });
    await audit('vote_recorded', { electionId });
    res.status(201).json({ status: 'recorded' });
  } catch (err) { res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Não foi possível registrar o voto.' }); }
});

async function buildBulletin(electionId) {
  const electionRef = elections.doc(electionId);
  const electionSnap = await electionRef.get();
  if (!electionSnap.exists || electionSnap.data().status !== 'closed') throw Object.assign(new Error('Eleição ainda não encerrada.'), { status: 409 });
  const [voteSnap, votersSnap, candidateSnap] = await Promise.all([
    ballots.where('electionId', '==', electionId).get(),
    participation.where('electionId', '==', electionId).get(),
    candidates.where('electionId', '==', electionId).get(),
  ]);
  const votes = voteSnap.docs.map((d) => d.data()).sort((a, b) => a.sequence - b.sequence);
  let previous = '0'.repeat(64);
  for (let index = 0; index < votes.length; index += 1) {
    const { sequence, previousDigest, digest, signature, ...vote } = votes[index];
    const expected = sha256(`${previous}:${canonicalJson(vote)}`);
    if (sequence !== index + 1 || previousDigest !== previous || digest !== expected || !secureEqual(signature, hmac(integrityKey(), expected))) {
      throw Object.assign(new Error('Falha na verificação de integridade da cadeia de votos.'), { status: 409 });
    }
    previous = digest;
  }
  if (previous !== electionSnap.data().chainHead || votes.length !== electionSnap.data().voteCount) {
    throw Object.assign(new Error('Cabeça ou contagem da cadeia não confere.'), { status: 409 });
  }
  const totals = { candidate: 0, blank: 0, null: 0 };
  const byOffice = {};
  for (const vote of votes) {
    totals[vote.choice] += 1;
    byOffice[vote.office] ??= { candidate: {}, blank: 0, null: 0 };
    if (vote.choice === 'candidate') byOffice[vote.office].candidate[vote.candidateNumber] = (byOffice[vote.office].candidate[vote.candidateNumber] ?? 0) + 1;
    else byOffice[vote.office][vote.choice] += 1;
  }
  const registered = votersSnap.size;
  const voted = votersSnap.docs.filter((d) => d.data().voted).length;
  const candidateLabels = Object.fromEntries(candidateSnap.docs.map((d) => [`${d.data().office}:${d.data().number}`, { name: d.data().name, party: d.data().party }]));
  const body = { electionId, election: electionSnap.data().name, generatedAt: new Date().toISOString(), totals: { ...totals, cast: votes.length, abstentions: Math.max(0, registered - voted) }, byOffice, candidateLabels, chainHead: electionSnap.data().chainHead };
  return { ...body, integrity: hmac(integrityKey(), JSON.stringify(body)) };
}

api.get('/elections/:id/bulletin', adminAuth, async (req, res) => {
  try { res.json(await buildBulletin(req.params.id)); }
  catch (err) { res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Falha ao gerar boletim.' }); }
});

app.use('/api', api);
app.use((err, _req, res, _next) => {
  console.error('request_failed', err?.message);
  res.status(err?.status ?? 500).json({ error: err?.status ? err.message : 'Erro interno.' });
});
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`API de simulação disponível na porta ${port}`));
