import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createAdminSession, hmac, passwordMatches, randomToken, secureEqual, sha256, validCpf, verifyAdminSession, requireKeys } from './security.js';
import { supabase } from './supabase.js';

requireKeys();
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((value) => value.trim()) }));
app.use(express.json({ limit: '32kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' } });
const api = express.Router();
const cpfDigest = (cpf) => hmac(process.env.CPF_HMAC_KEY, String(cpf).replace(/\D/g, ''));
const candidateId = (electionId, office, number) => sha256(JSON.stringify([electionId, office, number]));
const idParam = z.string().uuid();

function adminAuth(req, res, next) {
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!verifyAdminSession(supplied, process.env.ADMIN_SESSION_KEY)) return res.status(401).json({ error: 'Sessão administrativa inválida ou expirada.' });
  next();
}
async function audit(event, detail = {}) {
  const { error } = await supabase.from('audit_logs').insert({ event, detail });
  if (error) console.error('audit_write_failed', error.message);
}
function databaseError(error) {
  const message = error?.message ?? '';
  const map = {
    ELECTION_NOT_DRAFT: [409, 'A eleição não está em rascunho.'],
    ELECTION_NOT_OPEN: [409, 'A eleição não está aberta.'],
    INVALID_STATUS_TRANSITION: [409, 'Transição de status inválida.'],
    ELECTION_NOT_FOUND: [404, 'Eleição não encontrada.'],
    VOTER_ALREADY_REGISTERED: [409, 'Eleitor já cadastrado neste pleito.'],
    VOTER_NOT_REGISTERED: [404, 'Eleitor não cadastrado neste pleito.'],
    VOTER_ALREADY_VOTED: [409, 'Eleitor já votou neste pleito.'],
    CANDIDATE_NUMBER_EXISTS: [409, 'Número já cadastrado para este cargo.'],
    OFFICE_NOT_IN_ELECTION: [400, 'O cargo não consta na configuração do pleito.'],
    TOKEN_INVALID: [409, 'Token inválido, expirado ou já utilizado.'],
    OFFICE_ALREADY_VOTED: [409, 'Cargo inválido ou já votado.'],
    CANDIDATE_NOT_FOUND: [400, 'Número não cadastrado para este cargo.'],
    INVALID_BALLOT: [400, 'Cédula inválida.'],
  };
  for (const [code, result] of Object.entries(map)) if (message.includes(code)) return { status: result[0], message: result[1] };
  if (error?.code === '23505') return { status: 409, message: 'Já existe um registro com esses dados.' };
  if (error?.code === '23503') return { status: 404, message: 'Pleito ou eleitor não encontrado.' };
  return { status: 500, message: 'Falha ao acessar o banco de dados.' };
}
function sendDatabaseError(res, error) {
  const mapped = databaseError(error);
  if (mapped.status === 500) console.error('supabase_request_failed', error?.message);
  return res.status(mapped.status).json({ error: mapped.message });
}
async function electionById(id) {
  if (!idParam.safeParse(id).success) return { data: null, error: { status: 400, message: 'ID de eleição inválido.' } };
  const result = await supabase.from('elections').select('*').eq('id', id).maybeSingle();
  if (result.error) return { data: null, error: databaseError(result.error) };
  return { data: result.data, error: result.data ? null : { status: 404, message: 'Eleição não encontrada.' } };
}

api.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'simulacao-educacional', database: 'supabase' }));
api.post('/auth/login', loginLimiter, async (req, res) => {
  const parsed = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) }).safeParse(req.body);
  const usernameMatches = parsed.success && secureEqual(parsed.data.username, process.env.ADMIN_USERNAME);
  const passwordMatchesAdmin = passwordMatches(parsed.success ? parsed.data.password : '', process.env.ADMIN_PASSWORD_HASH);
  if (!usernameMatches || !passwordMatchesAdmin) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  await audit('admin_login');
  res.json({ token: createAdminSession(process.env.ADMIN_USERNAME, process.env.ADMIN_SESSION_KEY), expiresInSeconds: 3600 });
});
api.get('/auth/session', adminAuth, (_req, res) => res.json({ status: 'authenticated', role: 'admin' }));

// Elections CRUD
api.get('/admin/elections', adminAuth, async (_req, res) => {
  const { data, error } = await supabase.from('elections').select('*').order('created_at', { ascending: false });
  if (error) return sendDatabaseError(res, error);
  res.json(data);
});
api.post('/admin/elections', adminAuth, async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(120), offices: z.array(z.string().trim().min(1).max(60)).min(1).max(12) }).safeParse(req.body);
  if (!parsed.success || new Set(parsed.data?.offices ?? []).size !== (parsed.data?.offices ?? []).length) return res.status(400).json({ error: 'Informe nome e cargos válidos, sem repetir cargos.' });
  const { data, error } = await supabase.from('elections').insert({ ...parsed.data, status: 'draft' }).select('id').single();
  if (error) return sendDatabaseError(res, error);
  await audit('election_created', { electionId: data.id });
  res.status(201).json(data);
});
api.patch('/admin/elections/:id', adminAuth, async (req, res) => {
  if (!idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID de eleição inválido.' });
  const parsed = z.object({ status: z.enum(['open', 'closed']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Status inválido.' });
  const { error: transitionError } = await supabase.rpc('change_election_status', { p_election_id: req.params.id, p_status: parsed.data.status });
  if (transitionError) return sendDatabaseError(res, transitionError);
  const { data, error } = await supabase.from('elections').select('*').eq('id', req.params.id).single();
  if (error) return sendDatabaseError(res, error);
  await audit(`election_${parsed.data.status}`, { electionId: data.id });
  if (data.status === 'closed') {
    try { return res.json(await buildBulletin(data.id)); }
    catch (err) { return res.status(err.status ?? 500).json({ error: err.message ?? 'Falha ao gerar boletim.' }); }
  }
  res.json(data);
});
api.delete('/admin/elections/:id', adminAuth, async (req, res) => {
  const { data: election, error: readError } = await electionById(req.params.id);
  if (readError) return res.status(readError.status).json({ error: readError.message });
  if (election.status !== 'draft') return res.status(409).json({ error: 'Somente eleições em rascunho podem ser removidas.' });
  const { data: deleted, error } = await supabase.from('elections').delete().eq('id', election.id).eq('status', 'draft').select('id');
  if (error) return sendDatabaseError(res, error);
  if (!deleted.length) return res.status(409).json({ error: 'Somente eleições em rascunho podem ser removidas.' });
  await audit('election_deleted', { electionId: election.id });
  res.status(204).end();
});

// Public, read-only data consumed by the ballot screen.
api.get('/elections/:id', async (req, res) => {
  const { data, error } = await electionById(req.params.id);
  if (error) return res.status(error.status).json({ error: error.message });
  res.json({ id: data.id, name: data.name, status: data.status, offices: data.offices });
});
api.get('/elections/:id/candidates', async (req, res) => {
  if (!idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID inválido.' });
  const { data, error } = await supabase.from('candidates').select('id,election_id,office,number,name,party,photo_url').eq('election_id', req.params.id).order('number');
  if (error) return sendDatabaseError(res, error);
  res.json(data.map(({ election_id: electionId, photo_url: photoUrl, ...candidate }) => ({ ...candidate, electionId, photoUrl })));
});

// Voters CRUD. CPF is stored only as a keyed HMAC digest.
api.get('/admin/voters', adminAuth, async (req, res) => {
  if (!idParam.safeParse(req.query.electionId).success) return res.status(400).json({ error: 'Informe um ID de eleição válido.' });
  const { data: rows, error } = await supabase.from('participation').select('id,election_id,voter_id,voted,voted_offices,created_at,voted_at').eq('election_id', req.query.electionId).order('created_at');
  if (error) return sendDatabaseError(res, error);
  if (!rows.length) return res.json([]);
  const voterIds = [...new Set(rows.map((row) => row.voter_id))];
  const { data: people, error: voterError } = await supabase.from('voters').select('id,name').in('id', voterIds);
  if (voterError) return sendDatabaseError(res, voterError);
  const names = new Map(people.map((person) => [person.id, person.name]));
  res.json(rows.map((row) => ({ id: row.id, electionId: row.election_id, name: names.get(row.voter_id) ?? 'Eleitor', voted: row.voted, votedOffices: row.voted_offices, createdAt: row.created_at, votedAt: row.voted_at })));
});
api.post('/admin/voters', adminAuth, async (req, res) => {
  const parsed = z.object({ electionId: idParam, cpf: z.string(), name: z.string().trim().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success || !validCpf(parsed.data?.cpf)) return res.status(400).json({ error: 'CPF ou dados inválidos.' });
  const { data, error } = await supabase.rpc('register_voter', { p_election_id: parsed.data.electionId, p_cpf_hash: cpfDigest(parsed.data.cpf), p_name: parsed.data.name });
  if (error) return sendDatabaseError(res, error);
  await audit('voter_registered', { electionId: parsed.data.electionId });
  res.status(201).json({ id: data, status: 'cadastrado' });
});
api.patch('/admin/voters/:id', adminAuth, async (req, res) => {
  if (!idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID de eleitor inválido.' });
  const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nome inválido.' });
  const { data: participation, error: readError } = await supabase.from('participation').select('id,election_id,voter_id,voted').eq('id', req.params.id).maybeSingle();
  if (readError) return sendDatabaseError(res, readError);
  if (!participation) return res.status(404).json({ error: 'Eleitor não encontrado.' });
  const { data: election } = await supabase.from('elections').select('status').eq('id', participation.election_id).single();
  if (election?.status !== 'draft') return res.status(409).json({ error: 'Eleitores só podem ser alterados em pleitos em rascunho.' });
  const { error } = await supabase.from('voters').update({ name: parsed.data.name }).eq('id', participation.voter_id);
  if (error) return sendDatabaseError(res, error);
  res.json({ id: participation.id, name: parsed.data.name });
});
api.delete('/admin/voters/:id', adminAuth, async (req, res) => {
  if (!idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID de eleitor inválido.' });
  const { data: participation, error: readError } = await supabase.from('participation').select('id,election_id,voter_id').eq('id', req.params.id).maybeSingle();
  if (readError) return sendDatabaseError(res, readError);
  if (!participation) return res.status(404).json({ error: 'Eleitor não encontrado.' });
  const { data: election } = await supabase.from('elections').select('status').eq('id', participation.election_id).single();
  if (election?.status !== 'draft') return res.status(409).json({ error: 'Eleitores só podem ser removidos em pleitos em rascunho.' });
  const { error } = await supabase.from('participation').delete().eq('id', participation.id);
  if (error) return sendDatabaseError(res, error);
  const { count } = await supabase.from('participation').select('id', { count: 'exact', head: true }).eq('voter_id', participation.voter_id);
  if (!count) await supabase.from('voters').delete().eq('id', participation.voter_id);
  res.status(204).end();
});

// Candidates CRUD
api.get('/admin/candidates', adminAuth, async (req, res) => {
  if (!idParam.safeParse(req.query.electionId).success) return res.status(400).json({ error: 'Informe um ID de eleição válido.' });
  const { data, error } = await supabase.from('candidates').select('*').eq('election_id', req.query.electionId).order('office').order('number');
  if (error) return sendDatabaseError(res, error);
  res.json(data.map(({ election_id: electionId, photo_url: photoUrl, created_at: createdAt, ...candidate }) => ({ ...candidate, electionId, photoUrl, createdAt })));
});
api.post('/admin/candidates', adminAuth, async (req, res) => {
  const parsed = z.object({ electionId: idParam, office: z.string().trim().min(1).max(60), number: z.string().regex(/^\d{2,5}$/), name: z.string().trim().min(1).max(120), party: z.string().trim().min(1).max(40), photoUrl: z.string().url().or(z.literal('')).optional() }).safeParse(req.body);
  if (!parsed.success || (parsed.data.photoUrl && !parsed.data.photoUrl.startsWith('https://'))) return res.status(400).json({ error: 'Dados do candidato inválidos; a foto deve usar HTTPS.' });
  const { electionId, office, number, name, party } = parsed.data;
  const photoUrl = parsed.data.photoUrl || null;
  const { data, error } = await supabase.rpc('register_candidate', { p_election_id: electionId, p_office: office, p_number: number, p_name: name, p_party: party, p_photo_url: photoUrl });
  if (error) return sendDatabaseError(res, error);
  await audit('candidate_created', { electionId });
  res.status(201).json({ id: data, electionId, office, number, name, party, photoUrl: photoUrl ?? '' });
});
api.patch('/admin/candidates/:id', adminAuth, async (req, res) => {
  if (!idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID de candidatura inválido.' });
  const parsed = z.object({ name: z.string().trim().min(1).max(120), party: z.string().trim().min(1).max(40), photoUrl: z.string().url().or(z.literal('')).optional() }).safeParse(req.body);
  if (!parsed.success || (parsed.data.photoUrl && !parsed.data.photoUrl.startsWith('https://'))) return res.status(400).json({ error: 'Dados de candidato inválidos.' });
  const { data: candidate, error: readError } = await supabase.from('candidates').select('id,election_id').eq('id', req.params.id).maybeSingle();
  if (readError) return sendDatabaseError(res, readError);
  if (!candidate) return res.status(404).json({ error: 'Candidatura não encontrada.' });
  const { data: election } = await supabase.from('elections').select('status').eq('id', candidate.election_id).single();
  if (election?.status !== 'draft') return res.status(409).json({ error: 'Candidaturas só podem ser alteradas em pleitos em rascunho.' });
  const { data, error } = await supabase.from('candidates').update({ name: parsed.data.name, party: parsed.data.party, photo_url: parsed.data.photoUrl || null }).eq('id', candidate.id).select('*').single();
  if (error) return sendDatabaseError(res, error);
  res.json({ ...data, electionId: data.election_id, photoUrl: data.photo_url });
});
api.delete('/admin/candidates/:id', adminAuth, async (req, res) => {
  if (!idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID de candidatura inválido.' });
  const { data: candidate, error: readError } = await supabase.from('candidates').select('id,election_id').eq('id', req.params.id).maybeSingle();
  if (readError) return sendDatabaseError(res, readError);
  if (!candidate) return res.status(404).json({ error: 'Candidatura não encontrada.' });
  const { data: election } = await supabase.from('elections').select('status').eq('id', candidate.election_id).single();
  if (election?.status !== 'draft') return res.status(409).json({ error: 'Candidaturas só podem ser removidas em pleitos em rascunho.' });
  const { error } = await supabase.from('candidates').delete().eq('id', candidate.id);
  if (error) return sendDatabaseError(res, error);
  res.status(204).end();
});

api.post('/admin/release', adminAuth, async (req, res) => {
  const parsed = z.object({ electionId: idParam, cpf: z.string() }).safeParse(req.body);
  if (!parsed.success || !validCpf(parsed.data.cpf)) return res.status(400).json({ error: 'CPF ou eleição inválidos.' });
  const token = randomToken();
  const { error } = await supabase.rpc('release_voter', { p_election_id: parsed.data.electionId, p_cpf_hash: cpfDigest(parsed.data.cpf), p_token_hash: sha256(token), p_expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
  if (error) return sendDatabaseError(res, error);
  await audit('voter_released', { electionId: parsed.data.electionId });
  res.status(201).json({ token, expiresInMinutes: 10 });
});

api.post('/vote', async (req, res) => {
  const parsed = z.object({ electionId: idParam, token: z.string().min(20).max(200), office: z.string().min(1).max(60), choice: z.enum(['candidate', 'blank', 'null']), candidateNumber: z.string().regex(/^\d{2,5}$/).optional() }).safeParse(req.body);
  if (!parsed.success || (parsed.data.choice === 'candidate' && !parsed.data.candidateNumber) || (parsed.data.choice !== 'candidate' && parsed.data.candidateNumber)) return res.status(400).json({ error: 'Cédula inválida.' });
  const nonce = randomToken();
  const recordedAt = new Date().toISOString();
  const { error } = await supabase.rpc('record_vote', { p_election_id: parsed.data.electionId, p_token_hash: sha256(parsed.data.token), p_office: parsed.data.office, p_choice: parsed.data.choice, p_candidate_number: parsed.data.candidateNumber ?? null, p_nonce: nonce, p_recorded_at: recordedAt, p_integrity_key: process.env.INTEGRITY_HMAC_KEY });
  if (error) return sendDatabaseError(res, error);
  await audit('vote_recorded', { electionId: parsed.data.electionId });
  res.status(201).json({ status: 'recorded' });
});

async function buildBulletin(electionId) {
  const { data: election, error: electionError } = await supabase.from('elections').select('*').eq('id', electionId).maybeSingle();
  if (electionError) throw Object.assign(new Error('Falha ao consultar eleição.'), { status: 500 });
  if (!election || election.status !== 'closed') throw Object.assign(new Error('Eleição ainda não encerrada.'), { status: 409 });
  const [ballotResult, voterResult, candidateResult] = await Promise.all([
    supabase.from('ballots').select('sequence,previous_digest,digest,signature,payload_json').eq('election_id', electionId).order('sequence'),
    supabase.from('participation').select('id,voted').eq('election_id', electionId),
    supabase.from('candidates').select('office,number,name,party').eq('election_id', electionId),
  ]);
  for (const result of [ballotResult, voterResult, candidateResult]) if (result.error) throw Object.assign(new Error('Falha ao consultar dados para apuração.'), { status: 500 });
  let previous = '0'.repeat(64);
  const votes = [];
  for (let index = 0; index < ballotResult.data.length; index += 1) {
    const ballot = ballotResult.data[index];
    const expected = sha256(`${previous}:${ballot.payload_json}`);
    if (ballot.sequence !== index + 1 || ballot.previous_digest !== previous || ballot.digest !== expected || !secureEqual(ballot.signature, hmac(process.env.INTEGRITY_HMAC_KEY, expected))) {
      throw Object.assign(new Error('Falha na verificação de integridade da cadeia de votos.'), { status: 409 });
    }
    previous = ballot.digest;
    votes.push(JSON.parse(ballot.payload_json));
  }
  if (previous !== election.chain_head || votes.length !== Number(election.vote_count)) throw Object.assign(new Error('Cabeça ou contagem da cadeia não confere.'), { status: 409 });
  const totals = { candidate: 0, blank: 0, null: 0 };
  const byOffice = Object.fromEntries(election.offices.map((office) => [office, { candidate: {}, blank: 0, null: 0 }]));
  for (const vote of votes) {
    totals[vote.choice] += 1;
    const office = byOffice[vote.office] ?? (byOffice[vote.office] = { candidate: {}, blank: 0, null: 0 });
    if (vote.choice === 'candidate') office.candidate[vote.candidateNumber] = (office.candidate[vote.candidateNumber] ?? 0) + 1;
    else office[vote.choice] += 1;
  }
  const candidateLabels = Object.fromEntries(candidateResult.data.map((candidate) => [`${candidate.office}:${candidate.number}`, { name: candidate.name, party: candidate.party }]));
  const participation = voterResult.data;
  const body = { electionId, election: election.name, generatedAt: new Date().toISOString(), totals: { ...totals, cast: votes.length, abstentions: Math.max(0, participation.length - participation.filter((row) => row.voted).length) }, byOffice, candidateLabels, chainHead: election.chain_head };
  const integrity = hmac(process.env.INTEGRITY_HMAC_KEY, JSON.stringify(body));
  const { error } = await supabase.from('bulletins').upsert({ election_id: electionId, body, integrity });
  if (error) throw Object.assign(new Error('Falha ao salvar boletim.'), { status: 500 });
  return { ...body, integrity };
}

api.get('/elections/:id/bulletin', adminAuth, async (req, res) => {
  if (!idParam.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID de eleição inválido.' });
  try { res.json(await buildBulletin(req.params.id)); }
  catch (err) { res.status(err.status ?? 500).json({ error: err.message ?? 'Falha ao gerar boletim.' }); }
});

app.use('/api', api);
app.use((err, _req, res, _next) => {
  console.error('request_failed', err?.message);
  res.status(err?.status ?? 500).json({ error: err?.status ? err.message : 'Erro interno.' });
});
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`API de simulação conectada ao Supabase na porta ${port}`));
