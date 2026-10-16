import { useEffect, useMemo, useState } from 'react';
import './admin.css';

const API_ORIGIN = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '').replace(/\/api$/, '');
const API = API_ORIGIN ? `${API_ORIGIN}/api` : '';
const digits = (value) => value.replace(/\D/g, '');
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

export default function Admin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(() => sessionStorage.getItem('urna-admin-token') || '');
  const [elections, setElections] = useState([]);
  const [electionId, setElectionId] = useState('');
  const [voters, setVoters] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [name, setName] = useState('Pleito de demonstração');
  const [offices, setOffices] = useState('Vereador, Prefeito');
  const [cpf, setCpf] = useState('');
  const [voterName, setVoterName] = useState('');
  const [candidate, setCandidate] = useState({ office: 'Vereador', number: '', name: '', party: '', photoUrl: '' });
  const [releaseCpf, setReleaseCpf] = useState('');
  const [releaseLink, setReleaseLink] = useState('');
  const [releaseName, setReleaseName] = useState('');
  const [bulletin, setBulletin] = useState(null);
  const [status, setStatus] = useState(API ? 'Entre com a conta administrativa.' : 'Configure VITE_API_URL com a URL pública da API.');
  const [working, setWorking] = useState(false);
  const selectedElection = useMemo(() => elections.find((item) => item.id === electionId), [elections, electionId]);

  async function request(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Falha HTTP ${response.status}`);
    return body;
  }
  async function refreshElections() {
    const rows = await request('/admin/elections');
    setElections(rows);
    if (!electionId && rows[0]) setElectionId(rows[0].id);
    if (electionId && !rows.some((row) => row.id === electionId)) setElectionId(rows[0]?.id || '');
  }
  async function refreshRecords(id = electionId) {
    if (!id) { setVoters([]); setCandidates([]); return; }
    const [people, nominees] = await Promise.all([
      request(`/admin/voters?electionId=${encodeURIComponent(id)}`),
      request(`/admin/candidates?electionId=${encodeURIComponent(id)}`),
    ]);
    setVoters(people); setCandidates(nominees);
  }
  async function run(action) {
    setWorking(true); setStatus('Processando…');
    try { await action(); }
    catch (error) { setStatus(error.message); }
    finally { setWorking(false); }
  }
  useEffect(() => {
    if (!token) return;
    request('/auth/session').then(refreshElections).catch(() => { sessionStorage.removeItem('urna-admin-token'); setToken(''); setStatus('Sessão expirada. Entre novamente.'); });
  // Initial session validation only; refreshRecords is driven by election selection below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { if (token && electionId) refreshRecords().catch((error) => setStatus(error.message)); }, [token, electionId]);

  async function login() {
    const result = await request('/auth/login', { method: 'POST', body: JSON.stringify({ username: username.trim(), password }) });
    sessionStorage.setItem('urna-admin-token', result.token); setToken(result.token); setPassword(''); setStatus('Autenticado no backend Supabase.');
  }
  async function logout() { sessionStorage.removeItem('urna-admin-token'); setToken(''); setElections([]); setVoters([]); setCandidates([]); setStatus('Sessão encerrada.'); }
  async function createElection() {
    const normalized = offices.split(',').map((item) => item.trim()).filter(Boolean);
    if (!name.trim() || !normalized.length) throw new Error('Informe nome e ao menos um cargo.');
    const result = await request('/admin/elections', { method: 'POST', body: JSON.stringify({ name: name.trim(), offices: normalized }) });
    await refreshElections(); setElectionId(result.id); setBulletin(null); setReleaseLink(''); setStatus(`Pleito criado: ${result.id}`);
  }
  async function setElectionStatus(value) {
    const result = await request(`/admin/elections/${electionId}`, { method: 'PATCH', body: JSON.stringify({ status: value }) });
    if (value === 'closed') setBulletin(result);
    await refreshElections(); setStatus(value === 'open' ? 'Votação aberta.' : 'Votação encerrada e boletim gerado.');
  }
  async function removeElection() {
    if (!confirm('Remover este pleito em rascunho e seus cadastros?')) return;
    await request(`/admin/elections/${electionId}`, { method: 'DELETE' }); setElectionId(''); await refreshElections(); setStatus('Pleito removido.');
  }
  async function addVoter() {
    if (!validCpf(cpf)) throw new Error('CPF inválido.');
    await request('/admin/voters', { method: 'POST', body: JSON.stringify({ electionId, cpf: digits(cpf), name: voterName.trim() }) });
    setCpf(''); setVoterName(''); await refreshRecords(); setStatus('Eleitor cadastrado; CPF guardado no banco somente como HMAC.');
  }
  async function editVoter(row) {
    const updated = prompt('Nome do eleitor:', row.name);
    if (!updated?.trim()) return;
    await request(`/admin/voters/${row.id}`, { method: 'PATCH', body: JSON.stringify({ name: updated.trim() }) }); await refreshRecords(); setStatus('Eleitor atualizado.');
  }
  async function deleteVoter(row) {
    if (!confirm(`Remover o cadastro de ${row.name}?`)) return;
    await request(`/admin/voters/${row.id}`, { method: 'DELETE' }); await refreshRecords(); setStatus('Eleitor removido.');
  }
  async function addCandidate() {
    if (candidate.photoUrl && !candidate.photoUrl.startsWith('https://')) throw new Error('A URL da foto deve usar HTTPS.');
    await request('/admin/candidates', { method: 'POST', body: JSON.stringify({ electionId, ...candidate, number: digits(candidate.number), photoUrl: candidate.photoUrl.trim() || undefined }) });
    setCandidate({ ...candidate, number: '', name: '', party: '', photoUrl: '' }); await refreshRecords(); setStatus('Candidato cadastrado.');
  }
  async function editCandidate(row) {
    const updatedName = prompt('Nome:', row.name); if (!updatedName?.trim()) return;
    const party = prompt('Partido:', row.party); if (party === null || !party.trim()) return;
    const photoUrl = prompt('URL HTTPS da foto (deixe vazio para remover):', row.photoUrl || ''); if (photoUrl === null) return;
    await request(`/admin/candidates/${row.id}`, { method: 'PATCH', body: JSON.stringify({ name: updatedName.trim(), party: party.trim(), photoUrl }) }); await refreshRecords(); setStatus('Candidato atualizado.');
  }
  async function deleteCandidate(row) {
    if (!confirm(`Remover ${row.name} (${row.number})?`)) return;
    await request(`/admin/candidates/${row.id}`, { method: 'DELETE' }); await refreshRecords(); setStatus('Candidato removido.');
  }
  async function release() {
    if (!validCpf(releaseCpf)) throw new Error('CPF invalido.');
    setReleaseLink('');
    setReleaseName('');
    const result = await request('/admin/release', { method: 'POST', body: JSON.stringify({ electionId, cpf: digits(releaseCpf) }) });
    const voteUrl = new URL(`${import.meta.env.BASE_URL || '/'}index.html`, location.origin);
    voteUrl.searchParams.set('election', electionId);
    const name = typeof result.voterName === 'string' ? result.voterName.trim() : '';
    const linkData = new URLSearchParams({ vote: result.token });
    if (name) linkData.set('name', name);
    voteUrl.hash = linkData.toString();
    setReleaseLink(voteUrl.toString());
    setReleaseName(name);
    setReleaseCpf('');
    setStatus(name ? `Link individual de ${name} gerado; expira em ${result.expiresInMinutes} minutos.` : 'Link gerado, mas a API ainda não retornou o nome do eleitor. Atualize o backend no Render.');
  }
  async function copyReleaseLink() {
    try {
      await navigator.clipboard.writeText(releaseLink);
      setStatus('Link copiado. Envie somente para a pessoa que vai votar.');
    } catch {
      setStatus('Copie o link exibido abaixo e envie para a pessoa que vai votar.');
    }
  }
  async function shareReleaseLink() {
    if (!navigator.share) return copyReleaseLink();
    try {
      await navigator.share({ title: releaseName ? `Acesso para ${releaseName} votar na simulação` : 'Acesso para votação simulada', url: releaseLink });
      setStatus('Link compartilhado. Ele autoriza um voto e expira em 10 minutos.');
    } catch (error) {
      if (error.name !== 'AbortError') await copyReleaseLink();
    }
  }
  async function loadBulletin() { setBulletin(await request(`/elections/${electionId}/bulletin`)); setStatus('Boletim verificado e carregado.'); }
  function downloadBulletin() {
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(bulletin, null, 2)], { type: 'application/json' })); link.download = `boletim-${electionId}.json`; link.click(); URL.revokeObjectURL(link.href);
  }

  return <main className="app-shell admin-shell">
    <header className="topbar"><div><span className="brand-mark">V</span><span>PAINEL <b>ADMINISTRATIVO</b></span></div><a className="back-link" href={import.meta.env.BASE_URL} target="_blank" rel="noreferrer">Abrir urna ↗</a></header>
    {!token ? <section className="admin-login"><div className="admin-kicker">ACESSO RESTRITO AO ADMINISTRADOR</div><h1>Entrar no painel</h1><p>Use as credenciais administrativas configuradas no servidor da API.</p><label>Usuário<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label><label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" onKeyDown={(event) => { if (event.key === 'Enter') run(login); }} /></label><button className="admin-primary" onClick={() => run(login)} disabled={working || !API || !username || !password}>Acessar</button><div className="admin-status">{status}</div></section> : <>
      <div className="admin-welcome"><div><small>BACKEND: SUPABASE · API AUTENTICADA</small><h1>Cadastros e liberação da urna</h1></div><button className="admin-secondary" onClick={() => run(logout)}>Sair</button></div>
      <div className="admin-grid">
        <section className="admin-card"><small>01 / PLEITO</small><h2>Eleição</h2><label>Nome<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Cargos, separados por vírgula<input value={offices} onChange={(event) => setOffices(event.target.value)} /></label><button className="admin-primary" disabled={working} onClick={() => run(createElection)}>Criar pleito</button><label>Pleito selecionado<select value={electionId} onChange={(event) => { setElectionId(event.target.value); setBulletin(null); setReleaseLink(''); }}><option value="">Selecione</option>{elections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>{selectedElection && <p className="admin-status">{selectedElection.name} — {selectedElection.status}</p>}<div className="button-row"><button className="admin-secondary" disabled={working || selectedElection?.status !== 'draft'} onClick={() => run(() => setElectionStatus('open'))}>Abrir votação</button><button className="admin-danger" disabled={working || selectedElection?.status !== 'open'} onClick={() => run(() => setElectionStatus('closed'))}>Encerrar e apurar</button></div><button className="admin-danger" disabled={working || selectedElection?.status !== 'draft'} onClick={() => run(removeElection)}>Excluir rascunho</button></section>
        <section className="admin-card"><small>02 / ELEITORADO</small><h2>Cadastrar eleitor</h2><label>Nome<input value={voterName} onChange={(event) => setVoterName(event.target.value)} /></label><label>CPF<input value={cpf} onChange={(event) => setCpf(event.target.value)} inputMode="numeric" autoComplete="off" /></label><p className="privacy-note">O backend grava um HMAC do CPF, sem armazenar o número em texto puro. A chave HMAC fica somente no servidor.</p><button className="admin-primary" disabled={working || !electionId || selectedElection?.status !== 'draft'} onClick={() => run(addVoter)}>Cadastrar eleitor</button><div className="admin-divider"/><h2>Enviar acesso para votar</h2><label>CPF do eleitor cadastrado<input value={releaseCpf} onChange={(event) => setReleaseCpf(event.target.value)} inputMode="numeric" autoComplete="off" /></label><button className="admin-secondary" disabled={working || !electionId || selectedElection?.status !== 'open'} onClick={() => run(release)}>Gerar link para o celular</button>{releaseLink && <div className="token-result"><small>{releaseName ? 'LINK DE ' + releaseName : 'LINK INDIVIDUAL'} · EXPIRA EM 10 MINUTOS</small><input aria-label="Link individual de votacao" readOnly value={releaseLink} onFocus={(event) => event.target.select()} /><button className="admin-secondary" onClick={() => run(shareReleaseLink)}>Compartilhar link</button><button className="admin-secondary" onClick={() => run(copyReleaseLink)}>Copiar link para enviar ao eleitor</button><p className="privacy-note">Envie o link somente para o eleitor correspondente. Ele permite registrar um voto e expira em 10 minutos.</p></div>}</section>
        <section className="admin-card"><small>03 / CANDIDATURAS</small><h2>Cadastrar candidato</h2><label>Cargo<input value={candidate.office} onChange={(event) => setCandidate({ ...candidate, office: event.target.value })} /></label><label>Número<input value={candidate.number} onChange={(event) => setCandidate({ ...candidate, number: event.target.value })} inputMode="numeric" /></label><label>Nome<input value={candidate.name} onChange={(event) => setCandidate({ ...candidate, name: event.target.value })} /></label><label>Partido<input value={candidate.party} onChange={(event) => setCandidate({ ...candidate, party: event.target.value })} /></label><label>URL HTTPS da foto<input value={candidate.photoUrl} onChange={(event) => setCandidate({ ...candidate, photoUrl: event.target.value })} placeholder="https://…" /></label>{candidate.photoUrl && <img className="candidate-preview" src={candidate.photoUrl} alt="Prévia da foto do candidato" />}<button className="admin-primary" disabled={working || !electionId || selectedElection?.status !== 'draft'} onClick={() => run(addCandidate)}>Cadastrar candidatura</button></section>
      </div>
      {electionId && <div className="admin-grid"><section className="admin-card"><small>04 / ELEITORES CADASTRADOS · {voters.length}</small><h2>Eleitores</h2>{voters.map((row) => <div className="admin-record" key={row.id}><span>{row.name}<small>{row.voted ? 'Votou' : 'Ainda não votou'}</small></span><div><button className="admin-secondary" disabled={selectedElection?.status !== 'draft'} onClick={() => run(() => editVoter(row))}>Editar</button> <button className="admin-danger" disabled={selectedElection?.status !== 'draft'} onClick={() => run(() => deleteVoter(row))}>Excluir</button></div></div>)}</section><section className="admin-card"><small>05 / CANDIDATOS CADASTRADOS · {candidates.length}</small><h2>Candidatos</h2>{candidates.map((row) => <div className="admin-record" key={row.id}><span>{row.number} · {row.name}<small>{row.office} · {row.party}</small></span><div><button className="admin-secondary" disabled={selectedElection?.status !== 'draft'} onClick={() => run(() => editCandidate(row))}>Editar</button> <button className="admin-danger" disabled={selectedElection?.status !== 'draft'} onClick={() => run(() => deleteCandidate(row))}>Excluir</button></div></div>)}</section></div>}
      {selectedElection?.status === 'closed' && <section className="admin-card bulletin"><div className="bulletin-title"><div><small>APURAÇÃO · BOLETIM DE URNA</small><h2>{selectedElection.name}</h2></div><div className="button-row"><button className="admin-secondary" onClick={() => run(loadBulletin)}>Carregar boletim</button>{bulletin && <button className="admin-secondary" onClick={downloadBulletin}>Baixar JSON</button>}</div></div>{bulletin && <><div className="summary-grid">{[['CÉDULAS', bulletin.totals.cast], ['VOTOS VÁLIDOS', bulletin.totals.candidate], ['EM BRANCO', bulletin.totals.blank], ['NULOS', bulletin.totals.null], ['ABSTENÇÕES', bulletin.totals.abstentions]].map(([label, count]) => <div key={label}><small>{label}</small><b>{count}</b></div>)}</div>{Object.entries(bulletin.byOffice).map(([office, totals]) => <div className="results-office" key={office}><h3>{office}</h3><table><thead><tr><th>Candidato / opção</th><th>Votos</th></tr></thead><tbody>{Object.entries(totals.candidate).map(([number, count]) => { const info = bulletin.candidateLabels[`${office}:${number}`]; return <tr key={number}><td>{number} — {info?.name ?? 'Candidato'} ({info?.party ?? '-'})</td><td>{count}</td></tr>; })}<tr><td>Em branco</td><td>{totals.blank}</td></tr><tr><td>Nulos</td><td>{totals.null}</td></tr></tbody></table></div>)}<div className="integrity-line"><span>HMAC de integridade do boletim</span><code>{bulletin.integrity}</code></div></>}</section>}
      <div className="admin-status global-status">{status}</div>
    </>}
    <footer className="page-foot"><span>Somente demonstração educacional · Não utilizar em eleições reais</span></footer>
  </main>;
}
