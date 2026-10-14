import { useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, getDocs, onSnapshot, query, runTransaction, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { auth, db } from './firebase.js';
import './admin.css';

const digits = (value) => value.replace(/\D/g, '');
async function hash(value) {
  const data = new TextEncoder().encode(value);
  const bytes = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join('');
}
function validCpf(raw) {
  const value = digits(raw);
  if (value.length !== 11 || /^(\d)\1+$/.test(value)) return false;
  const check = (length) => {
    const sum = value.slice(0, length).split('').reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return (remainder === 10 ? 0 : remainder) === Number(value[length]);
  };
  return check(9) && check(10);
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function Admin() {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [elections, setElections] = useState([]);
  const [electionId, setElectionId] = useState('');
  const [name, setName] = useState('Pleito de demonstração');
  const [offices, setOffices] = useState('Vereador, Prefeito');
  const [cpf, setCpf] = useState('');
  const [voterName, setVoterName] = useState('');
  const [candidate, setCandidate] = useState({ office: 'Vereador', number: '', name: '', party: '', photoUrl: '' });
  const [releaseCpf, setReleaseCpf] = useState('');
  const [token, setToken] = useState('');
  const [bulletin, setBulletin] = useState(null);
  const [status, setStatus] = useState('Entre com a conta administrativa do Firebase Authentication.');
  const [working, setWorking] = useState(false);

  useEffect(() => onAuthStateChanged(auth, setUser), []);
  useEffect(() => {
    if (!user) { setElections([]); return undefined; }
    return onSnapshot(collection(db, 'elections'), (snapshot) => setElections(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      (error) => setStatus(`Firestore: ${error.message}`));
  }, [user]);

  async function run(action) {
    setWorking(true); setStatus('Processando…');
    try { await action(); }
    catch (error) { setStatus(error.code === 'permission-denied' ? 'Acesso negado pelas regras do Firestore. Confirme que o UID autenticado é o UID administrativo autorizado.' : error.message); }
    finally { setWorking(false); }
  }
  const selectedElection = elections.find((item) => item.id === electionId);
  async function createElection() {
    const normalizedOffices = offices.split(',').map((item) => item.trim()).filter(Boolean);
    if (!name.trim() || !normalizedOffices.length) throw new Error('Informe o nome e ao menos um cargo.');
    const ref = await addDoc(collection(db, 'elections'), { name: name.trim(), offices: normalizedOffices, status: 'draft', chainHead: '0'.repeat(64), voteCount: 0, createdAt: serverTimestamp() });
    setElectionId(ref.id); setBulletin(null); setStatus(`Pleito criado no Firestore: ${ref.id}`);
  }
  async function changeElectionStatus(statusValue) {
    const ref = doc(db, 'elections', electionId);
    await runTransaction(db, async (transaction) => {
      const current = await transaction.get(ref);
      if (!current.exists()) throw new Error('Pleito não encontrado.');
      if (current.data().status === 'closed') throw new Error('Pleito encerrado não pode ser reaberto.');
      transaction.update(ref, { status: statusValue, ...(statusValue === 'closed' ? { closedAt: serverTimestamp() } : {}) });
    });
    if (statusValue === 'closed') await generateBulletin();
    else setStatus('Votação aberta no Firestore.');
  }
  async function registerVoter() {
    if (!validCpf(cpf)) throw new Error('CPF inválido.');
    if (!voterName.trim()) throw new Error('Informe o nome do eleitor.');
    if (selectedElection?.status !== 'draft') throw new Error('Eleitores só podem ser cadastrados enquanto o pleito está em rascunho.');
    const cpfHash = await hash(digits(cpf));
    const voterRef = doc(db, 'voters', cpfHash);
    const participationRef = doc(db, 'participation', await hash(`${electionId}:${digits(cpf)}`));
    await runTransaction(db, async (transaction) => {
      const electionRef = doc(db, 'elections', electionId);
      const [election, participation] = await Promise.all([transaction.get(electionRef), transaction.get(participationRef)]);
      if (!election.exists() || election.data().status !== 'draft') throw new Error('Pleito não encontrado ou já aberto.');
      if (participation.exists()) throw new Error('Este CPF já está cadastrado no pleito.');
      transaction.set(voterRef, { name: voterName.trim(), cpfHash, createdAt: serverTimestamp() }, { merge: true });
      transaction.set(participationRef, { electionId, voterKey: cpfHash, voted: false, votedOffices: [], createdAt: serverTimestamp() });
    });
    setCpf(''); setVoterName(''); setStatus('Eleitor cadastrado; CPF não foi gravado em texto puro.');
  }
  async function registerCandidate() {
    const number = digits(candidate.number);
    if (!candidate.office.trim() || !/^[0-9]{2,5}$/.test(number) || !candidate.name.trim() || !candidate.party.trim()) throw new Error('Confira cargo, número (2 a 5 dígitos), nome e partido.');
    if (selectedElection?.status !== 'draft') throw new Error('Candidatos só podem ser cadastrados enquanto o pleito está em rascunho.');
    if (candidate.photoUrl && !/^https:\/\//i.test(candidate.photoUrl)) throw new Error('A URL da foto deve começar com https://.');
    const candidateId = await hash(JSON.stringify([electionId, candidate.office.trim(), number]));
    const ref = doc(db, 'candidates', candidateId);
    await runTransaction(db, async (transaction) => {
      const election = await transaction.get(doc(db, 'elections', electionId));
      const existing = await transaction.get(ref);
      if (!election.exists() || election.data().status !== 'draft') throw new Error('Cadastre candidatos antes de abrir o pleito.');
      if (!election.data().offices.includes(candidate.office.trim())) throw new Error('O cargo não consta na configuração do pleito.');
      if (existing.exists()) throw new Error('Número já cadastrado para este cargo.');
      transaction.set(ref, { electionId, office: candidate.office.trim(), number, name: candidate.name.trim(), party: candidate.party.trim(), ...(candidate.photoUrl ? { photoUrl: candidate.photoUrl.trim() } : {}), createdAt: serverTimestamp() });
    });
    setStatus('Candidatura cadastrada no Firestore.');
  }
  async function releaseVoter() {
    if (!validCpf(releaseCpf)) throw new Error('CPF inválido.');
    if (selectedElection?.status !== 'open') throw new Error('Abra o pleito antes de liberar a urna.');
    const cpfHash = await hash(digits(releaseCpf));
    const participationId = await hash(`${electionId}:${digits(releaseCpf)}`);
    const participationRef = doc(db, 'participation', participationId);
    const rawToken = randomToken();
    const tokenRef = doc(db, 'voter_releases', await hash(rawToken));
    await runTransaction(db, async (transaction) => {
      const [election, participation, existingToken] = await Promise.all([transaction.get(doc(db, 'elections', electionId)), transaction.get(participationRef), transaction.get(tokenRef)]);
      if (!election.exists() || election.data().status !== 'open') throw new Error('Pleito não está aberto.');
      if (!participation.exists() || participation.data().voterKey !== cpfHash) throw new Error('Eleitor não cadastrado neste pleito.');
      if (participation.data().voted) throw new Error('Eleitor já votou.');
      if (existingToken.exists()) throw new Error('Falha ao gerar token único. Tente novamente.');
      transaction.set(tokenRef, { electionId, participationKey: participationId, usedOffices: [], used: false, expiresAt: new Date(Date.now() + 10 * 60_000), createdAt: serverTimestamp() });
    });
    setToken(rawToken); setStatus('Liberação criada no Firestore. O consumo desse token pela tela da urna ainda requer migração da urna para Firestore.');
  }
  async function generateBulletin() {
    const [ballots, candidatesSnap, participationSnap, electionSnap] = await Promise.all([
      getDocs(query(collection(db, 'ballots'), where('electionId', '==', electionId))),
      getDocs(query(collection(db, 'candidates'), where('electionId', '==', electionId))),
      getDocs(query(collection(db, 'participation'), where('electionId', '==', electionId))),
      getDoc(doc(db, 'elections', electionId)),
    ]);
    const votes = ballots.docs.map((item) => item.data()).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    const byOffice = {};
    for (const office of electionSnap.data()?.offices ?? []) byOffice[office] = { candidate: {}, blank: 0, null: 0 };
    for (const vote of votes) {
      const totals = byOffice[vote.office] ?? (byOffice[vote.office] = { candidate: {}, blank: 0, null: 0 });
      if (vote.choice === 'candidate') totals.candidate[vote.candidateNumber] = (totals.candidate[vote.candidateNumber] ?? 0) + 1;
      else totals[vote.choice] = (totals[vote.choice] ?? 0) + 1;
    }
    const registered = participationSnap.size;
    const voted = participationSnap.docs.filter((item) => item.data().voted).length;
    const byCandidate = Object.fromEntries(candidatesSnap.docs.map((item) => [`${item.data().office}:${item.data().number}`, { name: item.data().name, party: item.data().party }]));
    const totals = { candidate: votes.filter((item) => item.choice === 'candidate').length, blank: votes.filter((item) => item.choice === 'blank').length, null: votes.filter((item) => item.choice === 'null').length, cast: votes.length, abstentions: Math.max(0, registered - voted) };
    const body = { electionId, election: electionSnap.data()?.name, generatedAt: new Date().toISOString(), totals, byOffice, candidateLabels: byCandidate, chainHead: electionSnap.data()?.chainHead ?? null };
    const report = { ...body, integrity: await hash(JSON.stringify(body)) };
    await setDoc(doc(db, 'bulletins', electionId), report);
    setBulletin(report); setStatus('Boletim de demonstração gerado e salvo no Firestore. O hash não é assinatura digital.');
  }
  async function login() { await run(async () => { await signInWithEmailAndPassword(auth, email.trim(), password); setPassword(''); setStatus('Autenticado. O Firestore verificará o UID pelas regras.'); }); }

  return <main className="app-shell admin-shell">
    <header className="topbar"><div><span className="brand-mark">V</span><span>PAINEL <b>ADMINISTRATIVO</b></span></div><a className="back-link" href={import.meta.env.BASE_URL}>Abrir urna ↗</a></header>
    {!user ? <section className="admin-login"><div className="admin-kicker">ACESSO RESTRITO AO ADMINISTRADOR</div><h1>Entrar no painel</h1><p>Use o e-mail e a senha da conta cadastrada no Firebase Authentication. As regras do Firestore autorizam somente o UID do administrador.</p><label>E-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label><label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" onKeyDown={(event) => { if (event.key === 'Enter') login(); }} /></label><button className="admin-primary" onClick={login} disabled={working || !email || !password}>Acessar</button><div className="admin-status">{status}</div></section> : <>
      <div className="admin-welcome"><div><small>UID AUTENTICADO: {user.uid}</small><h1>Cadastros e liberação da urna</h1></div><button className="admin-secondary" onClick={() => run(() => signOut(auth))}>Sair</button></div>
      <div className="admin-grid">
        <section className="admin-card"><small>01 / PLEITO</small><h2>Criar eleição</h2><label>Nome<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Cargos na ordem de votação<input value={offices} onChange={(event) => setOffices(event.target.value)} /></label><button className="admin-primary" disabled={working} onClick={() => run(createElection)}>Criar pleito</button><label>Pleito<input list="election-list" value={electionId} onChange={(event) => setElectionId(event.target.value)} placeholder="Escolha ou cole o ID" /><datalist id="election-list">{elections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</datalist></label>{selectedElection && <p className="admin-status">{selectedElection.name} — {selectedElection.status}</p>}<div className="button-row"><button className="admin-secondary" disabled={working || !electionId || selectedElection?.status !== 'draft'} onClick={() => run(() => changeElectionStatus('open'))}>Abrir votação</button><button className="admin-danger" disabled={working || !electionId || selectedElection?.status !== 'open'} onClick={() => run(() => changeElectionStatus('closed'))}>Encerrar e apurar</button></div></section>
        <section className="admin-card"><small>02 / ELEITORADO</small><h2>Cadastrar eleitor</h2><label>Nome<input value={voterName} onChange={(event) => setVoterName(event.target.value)} /></label><label>CPF<input value={cpf} onChange={(event) => setCpf(event.target.value)} inputMode="numeric" autoComplete="off" /></label><p className="privacy-note">O CPF é transformado em SHA-256 antes de gravar. Por ser um identificador previsível, isso é pseudonimização, não anonimização; mantenha esta coleção restrita ao UID admin.</p><button className="admin-primary" disabled={working || !electionId} onClick={() => run(registerVoter)}>Cadastrar eleitor</button><div className="admin-divider"/><h2>Liberar voto</h2><label>CPF do eleitor<input value={releaseCpf} onChange={(event) => setReleaseCpf(event.target.value)} inputMode="numeric" autoComplete="off" /></label><button className="admin-secondary" disabled={working || !electionId || selectedElection?.status !== 'open'} onClick={() => run(releaseVoter)}>Liberar urna</button>{token && <div className="token-result"><small>TOKEN TEMPORÁRIO · 10 MINUTOS</small><code>{token}</code></div>}</section>
        <section className="admin-card"><small>03 / CANDIDATURAS</small><h2>Cadastrar candidato</h2><label>Cargo<input value={candidate.office} onChange={(event) => setCandidate({ ...candidate, office: event.target.value })} /></label><label>Número<input value={candidate.number} onChange={(event) => setCandidate({ ...candidate, number: event.target.value })} inputMode="numeric" /></label><label>Nome<input value={candidate.name} onChange={(event) => setCandidate({ ...candidate, name: event.target.value })} /></label><label>Partido<input value={candidate.party} onChange={(event) => setCandidate({ ...candidate, party: event.target.value })} /></label><label>URL HTTPS da foto<input value={candidate.photoUrl} onChange={(event) => setCandidate({ ...candidate, photoUrl: event.target.value })} placeholder="https://…" /></label>{candidate.photoUrl && <img className="candidate-preview" src={candidate.photoUrl} alt="Prévia da foto do candidato" />}<button className="admin-primary" disabled={working || !electionId} onClick={() => run(registerCandidate)}>Cadastrar candidatura</button></section>
      </div>
      {bulletin && <section className="admin-card bulletin"><div className="bulletin-title"><div><small>BOLETIM DE URNA · JSON DE DEMONSTRAÇÃO</small><h2>{bulletin.election}</h2></div><button className="admin-secondary" onClick={() => { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(bulletin, null, 2)], { type: 'application/json' })); link.download = `boletim-${electionId}.json`; link.click(); URL.revokeObjectURL(link.href); }}>Baixar JSON</button></div><div className="summary-grid">{[['CÉDULAS', bulletin.totals.cast], ['VOTOS VÁLIDOS', bulletin.totals.candidate], ['EM BRANCO', bulletin.totals.blank], ['NULOS', bulletin.totals.null], ['ABSTENÇÕES', bulletin.totals.abstentions]].map(([label, count]) => <div key={label}><small>{label}</small><b>{count}</b></div>)}</div>{Object.entries(bulletin.byOffice).map(([title, totals]) => <div className="results-office" key={title}><h3>{title}</h3><table><thead><tr><th>Candidato / opção</th><th>Votos</th></tr></thead><tbody>{Object.entries(totals.candidate).map(([number, count]) => { const info = bulletin.candidateLabels[`${title}:${number}`]; return <tr key={number}><td>{number} — {info?.name ?? 'Candidato'} ({info?.party ?? '-'})</td><td>{count}</td></tr>; })}<tr><td>Em branco</td><td>{totals.blank}</td></tr><tr><td>Nulos</td><td>{totals.null}</td></tr></tbody></table></div>)}<div className="integrity-line"><span>SHA-256 do conteúdo (não autenticado)</span><code>{bulletin.integrity}</code></div></section>}
      <div className="admin-status global-status">{status}</div>
    </>}
    <footer className="page-foot"><span>Somente demonstração educacional · Não utilizar em eleições reais</span></footer>
  </main>;
}
