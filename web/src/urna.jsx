import { useEffect, useMemo, useState } from 'react';

const API_ORIGIN = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/, '').replace(/\/api$/, '');
const API = `${API_ORIGIN}/api`;
const DEMO_CANDIDATES = [
  { office: 'Vereador', number: '12345', name: 'Ana Exemplo', party: 'EDU', photoUrl: '' },
  { office: 'Vereador', number: '54321', name: 'Bruno Demonstração', party: 'SIM', photoUrl: '' },
  { office: 'Prefeito', number: '12', name: 'Carla Simulada', party: 'EDU', photoUrl: '' },
];
const DEMO_OFFICES = ['Vereador', 'Prefeito'];
const demo = new URLSearchParams(location.search).get('demo') === '1' || import.meta.env.VITE_DEMO_MODE === 'true';
function readMobileRelease() {
  try {
    const electionId = new URLSearchParams(location.search).get('election') || '';
    if (!electionId) return null;
    const storageKey = `urna-vote-${electionId}`;
    const linkData = new URLSearchParams(location.hash.slice(1));
    const linkedToken = linkData.get('vote');
    if (linkedToken) {
      sessionStorage.setItem(storageKey, JSON.stringify({ token: linkedToken, voterName: linkData.get('name') || '', expiresAt: Date.now() + 10 * 60_000 }));
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
    const release = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (!release?.token || release.expiresAt <= Date.now()) {
      sessionStorage.removeItem(storageKey);
      return null;
    }
    return { electionId, token: release.token, storageKey, voterName: release.voterName || '' };
  } catch { return null; }
}

const confirmationAudio = new Audio(`${import.meta.env.BASE_URL}som/som-da-urna.mp4`);
confirmationAudio.preload = 'auto';

function playConfirmationSound() {
  try {
    confirmationAudio.pause();
    confirmationAudio.currentTime = 0;
    const playback = confirmationAudio.play();
    if (playback?.catch) playback.catch(() => {});
  } catch { /* Browser audio can be disabled. */ }
}

export default function Urna() {
  const [kioskRelease, setKioskRelease] = useState(() => demo ? null : readMobileRelease());
  const electionId = kioskRelease?.electionId ?? '';
  const token = kioskRelease?.token ?? '';
  const voterName = kioskRelease?.voterName ?? '';
  const released = demo || Boolean(kioskRelease);
  const [office, setOffice] = useState('Vereador');
  const [offices, setOffices] = useState(demo ? DEMO_OFFICES : []);
  const [entry, setEntry] = useState('');
  const [message, setMessage] = useState('Digite o número do candidato');
  const [finished, setFinished] = useState(false);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState(demo ? DEMO_CANDIDATES : []);
  const [ballotReady, setBallotReady] = useState(demo);
  useEffect(() => {
    if (demo || !electionId) {
      if (!demo) { setOffices([]); setCandidates([]); setBallotReady(false); }
      return;
    }
    let active = true;
    setOffices([]);
    setCandidates([]);
    setBallotReady(false);
    Promise.all([
      fetch(`${API}/elections/${encodeURIComponent(electionId)}`).then(async (response) => {
        if (!response.ok) throw new Error('Election could not be loaded.');
        return response.json();
      }),
      fetch(`${API}/elections/${encodeURIComponent(electionId)}/candidates`).then(async (response) => {
        if (!response.ok) throw new Error('Candidates could not be loaded.');
        return response.json();
      }),
    ]).then(([election, nominees]) => {
      if (!active) return;
      setOffices(election.offices ?? []);
      setOffice(election.offices?.[0] ?? '');
      setCandidates(nominees);
      setBallotReady(true);
    }).catch(() => {
      if (!active) return;
      setMessage('Could not load the ballot. Ask the attendant for help.');
      setBallotReady(false);
    });
    return () => { active = false; };
  }, [electionId]);
  const officeCandidates = candidates.filter((c) => c.office === office);
  const numberLength = officeCandidates.reduce((max, c) => Math.max(max, c.number.length), 0) || (office === 'Prefeito' ? 2 : 5);
  const selected = useMemo(() => candidates.find((c) => c.office === office && c.number === entry), [candidates, office, entry]);
  const knownPrefix = entry.length < 2 || officeCandidates.some((c) => c.number.startsWith(entry));
  const invalid = entry.length > 0 && !knownPrefix;

  function resetField() { setEntry(''); setMessage('Digite o número do candidato'); }
  async function confirm(choice = 'candidate') {
    if (choice === 'candidate' && (!selected || invalid)) { setMessage('Número incorreto. Tente novamente.'); return; }
    if (!demo && (!electionId || !token)) { setMessage('Aguardando liberacao do mesario.'); return; }
    if (!ballotReady) { setMessage('Carregando os dados da votacao. Aguarde.'); return; }
    setBusy(true);
    try {
      if (!demo) {
        const response = await fetch(`${API}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ electionId, token, office, choice, ...(choice === 'candidate' ? { candidateNumber: entry } : {}) }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Falha ao votar.');
      }
      playConfirmationSound();
      const nextOffice = offices[offices.indexOf(office) + 1];
      if (nextOffice) { setOffice(nextOffice); resetField(); setMessage(`Voto confirmado. Próximo cargo: ${nextOffice}.`); }
      else { setFinished(true); setMessage(choice === 'blank' ? 'Voto em branco confirmado' : choice === 'null' ? 'Voto nulo confirmado' : 'Voto confirmado'); }
      if (!nextOffice && !demo) {
        sessionStorage.removeItem(kioskRelease.storageKey);
        setKioskRelease(null);
      }
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  function key(value) { if (entry.length < numberLength) { setEntry((old) => old + value); setMessage(''); } }

  return <main className="app-shell">
    <header className="topbar"><div><span className="brand-mark">V</span><span>VOTAÇÃO <b>SIMULADA</b></span></div><span className="status"><i /> AMBIENTE EDUCACIONAL</span></header>
    <section className="setup" aria-label="Status da simulacao">
      <label>Cargo <select value={office} disabled><option value="" disabled>Selecione</option>{offices.map((item) => <option key={item}>{item}</option>)}</select></label>
      <span className="demo-note">{demo ? 'Modo demonstracao local - voto nao gravado' : released ? (ballotReady ? 'Link de votacao validado' : 'Carregando votacao...') : 'Abra o link individual enviado pelo mesario'}</span>
    </section>
    <section className="machine">
      <div className="display-panel">
        <div className="display-head"><div><small>ELEIÇÕES • SIMULAÇÃO</small>{voterName && <p className="voter-name">Eleitor: <b>{voterName}</b></p>}<h1>SEU VOTO<br/>PARA <strong>{released ? office.toUpperCase() : 'AGUARDANDO'}</strong></h1></div><div className="seal">BR<br/><b>VOTO</b></div></div>
        <div className="instruction">{released ? 'Digite o numero do seu candidato:' : 'Abra o link individual enviado pelo mesario.'}</div>
        <div className="ballot-area">
          {finished ? <div className="fim">FIM</div> : !released ? <p className="help-text">Solicite ao mesario o link individual para votar.</p> : <>
            <div className="number-row"><span>Número:</span><div className="digits">{Array.from({ length: numberLength }, (_, i) => <b key={i} className={entry[i] ? 'filled' : ''}>{entry[i] ?? ''}</b>)}</div></div>
            {entry.length > 0 && <div className="candidate-info">
              <div className="portrait">{selected?.photoUrl ? <img src={selected.photoUrl} alt={`Foto de ${selected.name}`} /> : <span>{selected ? selected.name.split(' ').map((x) => x[0]).slice(0, 2).join('') : '?'}</span>}</div>
              {selected ? <div className="candidate-copy"><b>Nome: {selected.name}</b><span>Partido: {selected.party}</span><span>Cargo: {selected.office}</span></div> : <div className="candidate-copy"><b>{invalid || entry.length >= 2 ? 'VOTO NULO' : 'Pesquisando candidato…'}</b><span>{message}</span></div>}
            </div>}
            <p className="help-text">{message || (selected ? 'Confira os dados e aperte CONFIRMA.' : 'Para corrigir seu voto, aperte CORRIGE.')}</p>
            <div className="ballot-hint">Aperte a tecla:<br/><b>VERDE</b> para CONFIRMAR este voto<br/><b>LARANJA</b> para REINICIAR este voto</div>
          </>}
        </div>
        <footer className="display-footer"><span>JUSTIÇA ELEITORAL</span><span>SIMULADOR 2026</span></footer>
      </div>
      <div className="keypad-panel"><div className="keypad-brand"><span>TECLADO</span><span>NUMÉRICO</span></div>
        <div className="keys">{['1','2','3','4','5','6','7','8','9'].map((n) => <button key={n} className="number-key" onClick={() => key(n)} disabled={finished || busy || !released || !ballotReady}>{n}</button>)}<button className="number-key zero" onClick={() => key('0')} disabled={finished || busy || !released || !ballotReady}>0</button></div>
        <div className="action-keys"><button className="white-key" onClick={() => confirm('blank')} disabled={finished || busy || !released || !ballotReady}>BRANCO</button><button className="orange-key" onClick={() => finished ? null : resetField()} disabled={busy || !released || !ballotReady}>CORRIGE</button><button className="green-key" onClick={() => confirm(invalid ? 'null' : 'candidate')} disabled={finished || busy || !released || !ballotReady}>CONFIRMA <span>↵</span></button></div>
        {finished && demo && <button className="again" onClick={() => { setFinished(false); setOffice(offices[0] ?? ''); resetField(); }}>REINICIAR DEMONSTRAÇÃO</button>}
      </div>
    </section>
    <footer className="page-foot"><span>Projeto didático • Não utilizar em eleições reais</span><span>Confirme os dados antes de registrar</span></footer>
  </main>;
}
