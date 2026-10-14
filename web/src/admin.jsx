import { useState } from 'react';
import './admin.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api';

export default function Admin() {
  const [key, setKey] = useState('');
  const [authed, setAuthed] = useState(false);
  const [electionId, setElectionId] = useState('');
  const [name, setName] = useState('Pleito de demonstração');
  const [offices, setOffices] = useState('Vereador, Prefeito');
  const [cpf, setCpf] = useState('');
  const [voterName, setVoterName] = useState('');
  const [candidate, setCandidate] = useState({ office: 'Vereador', number: '', name: '', party: '', photoUrl: '' });
  const [releaseCpf, setReleaseCpf] = useState('');
  const [token, setToken] = useState('');
  const [bulletin, setBulletin] = useState(null);
  const [status, setStatus] = useState('Informe a chave do mesário para começar.');
  const [working, setWorking] = useState(false);

  async function request(path, method = 'GET', body) {
    const response = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `Erro HTTP ${response.status}`);
    return data;
  }
  async function run(action) {
    setWorking(true); setStatus('Processando…');
    try { await action(); }
    catch (error) { setStatus(error.message); }
    finally { setWorking(false); }
  }
  function login() { run(async () => { await request('/admin/session'); setAuthed(true); setStatus('Acesso demonstrativo ativo.'); }); }

  return <main className="app-shell admin-shell">
    <header className="topbar"><div><span className="brand-mark">V</span><span>PAINEL <b>DO MESÁRIO</b></span></div><a className="back-link" href="/">Abrir urna →</a></header>
    {!authed ? <section className="admin-login"><div className="admin-kicker">ACESSO RESTRITO • SIMULAÇÃO</div><h1>Entrar no painel</h1><p>A chave compartilhada autoriza as rotas administrativas desta demonstração.</p><label>Chave do mesário<input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" /></label><button className="admin-primary" onClick={login} disabled={working || !key}>Acessar</button><div className="admin-status">{status}</div></section> : <>
      <div className="admin-welcome"><div><small>GESTÃO DA VOTAÇÃO</small><h1>Configuração e apuração</h1></div><button className="admin-secondary" onClick={() => { setAuthed(false); setKey(''); }}>Sair</button></div>
      <div className="admin-grid">
        <section className="admin-card"><small>01 / PLEITO</small><h2>Criar eleição</h2><label>Nome<input value={name} onChange={(e) => setName(e.target.value)} /></label><label>Cargos na ordem de votação<input value={offices} onChange={(e) => setOffices(e.target.value)} /></label><button className="admin-primary" disabled={working} onClick={() => run(async () => { const result = await request('/admin/elections', 'POST', { name, offices: offices.split(',').map((x) => x.trim()).filter(Boolean) }); setElectionId(result.id); setBulletin(null); setStatus(`Eleição criada: ${result.id}`); })}>Criar pleito</button>
          <label>ID da eleição<input value={electionId} onChange={(e) => setElectionId(e.target.value)} placeholder="Gerado ao criar" /></label><div className="button-row"><button className="admin-secondary" disabled={working || !electionId} onClick={() => run(async () => { await request(`/admin/elections/${electionId}`, 'PATCH', { status: 'open' }); setStatus('Votação aberta.'); })}>Abrir votação</button><button className="admin-danger" disabled={working || !electionId} onClick={() => run(async () => { const result = await request(`/admin/elections/${electionId}`, 'PATCH', { status: 'closed' }); setBulletin(result); setStatus('Votação encerrada e boletim gerado.'); })}>Encerrar e apurar</button></div>
        </section>
        <section className="admin-card"><small>02 / ELEITORADO</small><h2>Cadastrar eleitor</h2><label>Nome<input value={voterName} onChange={(e) => setVoterName(e.target.value)} /></label><label>CPF<input value={cpf} onChange={(e) => setCpf(e.target.value)} inputMode="numeric" /></label><button className="admin-primary" disabled={working || !electionId} onClick={() => run(async () => { await request('/admin/voters', 'POST', { electionId, name: voterName, cpf }); setCpf(''); setVoterName(''); setStatus('Eleitor associado ao pleito.'); })}>Cadastrar eleitor</button><div className="admin-divider"/><h2>Liberar voto</h2><label>CPF do eleitor<input value={releaseCpf} onChange={(e) => setReleaseCpf(e.target.value)} inputMode="numeric" /></label><button className="admin-secondary" disabled={working || !electionId} onClick={() => run(async () => { const result = await request('/mesario/release', 'POST', { electionId, cpf: releaseCpf }); setToken(result.token); setStatus('Token temporário criado. Copie para a urna.'); })}>Liberar urna</button>{token && <div className="token-result"><small>TOKEN DE USO ÚNICO • 10 MINUTOS</small><code>{token}</code></div>}</section>
        <section className="admin-card"><small>03 / CANDIDATURAS</small><h2>Cadastrar candidato</h2><label>Cargo<input value={candidate.office} onChange={(e) => setCandidate({ ...candidate, office: e.target.value })} /></label><label>Número<input value={candidate.number} onChange={(e) => setCandidate({ ...candidate, number: e.target.value })} inputMode="numeric" /></label><label>Nome<input value={candidate.name} onChange={(e) => setCandidate({ ...candidate, name: e.target.value })} /></label><label>Partido<input value={candidate.party} onChange={(e) => setCandidate({ ...candidate, party: e.target.value })} /></label><label>URL da foto (opcional)<input value={candidate.photoUrl} onChange={(e) => setCandidate({ ...candidate, photoUrl: e.target.value })} /></label><button className="admin-primary" disabled={working || !electionId} onClick={() => run(async () => { const { photoUrl, ...fields } = candidate; await request('/admin/candidates', 'POST', { ...fields, ...(photoUrl ? { photoUrl } : {}), electionId }); setStatus('Candidato cadastrado.'); })}>Cadastrar candidatura</button></section>
      </div>
      {bulletin && <section className="admin-card bulletin"><div className="bulletin-title"><div><small>BOLETIM DE URNA • JSON ASSINADO</small><h2>{bulletin.election}</h2></div><button className="admin-secondary" onClick={() => { const blob = new Blob([JSON.stringify(bulletin, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `boletim-${electionId}.json`; link.click(); URL.revokeObjectURL(url); }}>Baixar JSON</button></div>
        <div className="summary-grid"><div><small>CÉDULAS</small><b>{bulletin.totals.cast}</b></div><div><small>VOTOS VÁLIDOS</small><b>{bulletin.totals.candidate}</b></div><div><small>EM BRANCO</small><b>{bulletin.totals.blank}</b></div><div><small>NULOS</small><b>{bulletin.totals.null}</b></div><div><small>ABSTENÇÕES</small><b>{bulletin.totals.abstentions}</b></div></div>
        {Object.entries(bulletin.byOffice).map(([title, totals]) => <div className="results-office" key={title}><h3>{title}</h3><table><thead><tr><th>Candidato / opção</th><th>Votos</th></tr></thead><tbody>{Object.entries(totals.candidate).map(([number, count]) => { const info = bulletin.candidateLabels?.[`${title}:${number}`]; return <tr key={number}><td>{number} · {info?.name ?? 'Candidato'} ({info?.party ?? '—'})</td><td>{count}</td></tr>; })}<tr><td>Em branco</td><td>{totals.blank}</td></tr><tr><td>Nulos</td><td>{totals.null}</td></tr></tbody></table></div>)}
        <div className="integrity-line"><span>Resumo HMAC-SHA-256 do boletim</span><code>{bulletin.integrity}</code></div></section>}
      <div className="admin-status global-status">{status}</div>
    </>}
    <footer className="page-foot"><span>Somente demonstração educacional • Não utilizar em eleições reais</span></footer>
  </main>;
}
