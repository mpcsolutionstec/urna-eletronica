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
let sharedAudioContext;

function prepareAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    sharedAudioContext ??= new AudioContextClass();
    void sharedAudioContext.resume();
    return sharedAudioContext;
  } catch { return null; }
}

export default function Urna() {
  const [electionId, setElectionId] = useState('');
  const [token, setToken] = useState('');
  const [office, setOffice] = useState('Vereador');
  const [offices, setOffices] = useState(demo ? DEMO_OFFICES : []);
  const [entry, setEntry] = useState('');
  const [message, setMessage] = useState('Digite o número do candidato');
  const [finished, setFinished] = useState(false);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState(demo ? DEMO_CANDIDATES : []);
  useEffect(() => {
    if (demo || !electionId) { if (!demo) setOffices([]); return; }
    let active = true;
    fetch(`${API}/elections/${encodeURIComponent(electionId)}`)
      .then(async (response) => { if (!response.ok) throw new Error('Eleição não encontrada.'); return response.json(); })
      .then((data) => { if (active) { setOffices(data.offices ?? []); setOffice(data.offices?.[0] ?? ''); } })
      .catch(() => { if (active) setOffices([]); });
    return () => { active = false; };
  }, [electionId]);
  useEffect(() => {
    if (demo || !electionId) { if (!demo) setCandidates([]); return; }
    let active = true;
    fetch(`${API}/elections/${encodeURIComponent(electionId)}/candidates`)
      .then(async (response) => { if (!response.ok) throw new Error('Não foi possível carregar os candidatos.'); return response.json(); })
      .then((data) => { if (active) setCandidates(data); })
      .catch(() => { if (active) setCandidates([]); });
    return () => { active = false; };
  }, [electionId]);
  const officeCandidates = candidates.filter((c) => c.office === office);
  const numberLength = officeCandidates.reduce((max, c) => Math.max(max, c.number.length), 0) || (office === 'Prefeito' ? 2 : 5);
  const selected = useMemo(() => candidates.find((c) => c.office === office && c.number === entry), [candidates, office, entry]);
  const knownPrefix = entry.length < 2 || officeCandidates.some((c) => c.number.startsWith(entry));
  const invalid = entry.length > 0 && !knownPrefix;

  function tone(ctx) {
    if (!ctx) return;
    try {
      // Cadência curta de bipes que recria o "pilili" para esta simulação.
      [[740, 0, 0.09], [988, 0.12, 0.09], [784, 0.24, 0.22]].forEach(([frequency, delay, duration]) => {
        const oscillator = ctx.createOscillator(); const gain = ctx.createGain();
        oscillator.type = 'square';
        oscillator.frequency.value = frequency; oscillator.connect(gain); gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.055, ctx.currentTime + delay + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + duration);
        oscillator.start(ctx.currentTime + delay); oscillator.stop(ctx.currentTime + delay + duration);
      });
    } catch { /* áudio pode estar desabilitado pelo navegador */ }
  }

  function resetField() { setEntry(''); setMessage('Digite o número do candidato'); }
  async function confirm(choice = 'candidate') {
    if (choice === 'candidate' && (!selected || invalid)) { setMessage('Número incorreto. Tente novamente.'); return; }
    if (!demo && (!electionId || !token)) { setMessage('Informe a eleição e o token liberado pelo mesário.'); return; }
    const audioContext = prepareAudio();
    setBusy(true);
    try {
      if (!demo) {
        const response = await fetch(`${API}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ electionId, token, office, choice, ...(choice === 'candidate' ? { candidateNumber: entry } : {}) }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Falha ao votar.');
      }
      tone(audioContext);
      const nextOffice = offices[offices.indexOf(office) + 1];
      if (nextOffice) { setOffice(nextOffice); resetField(); setMessage(`Voto confirmado. Próximo cargo: ${nextOffice}.`); }
      else { setFinished(true); setMessage(choice === 'blank' ? 'Voto em branco confirmado' : choice === 'null' ? 'Voto nulo confirmado' : 'Voto confirmado'); }
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  function key(value) { if (entry.length < numberLength) { setEntry((old) => old + value); setMessage(''); } }

  return <main className="app-shell">
    <header className="topbar"><div><span className="brand-mark">V</span><span>VOTAÇÃO <b>SIMULADA</b></span></div><span className="status"><i /> AMBIENTE EDUCACIONAL</span></header>
    <section className="setup" aria-label="Configuração da simulação">
      <label>Eleição <input value={electionId} onChange={(e) => setElectionId(e.target.value)} placeholder="ID da eleição" disabled={demo} /></label>
      <label>Token do eleitor <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token de liberação" disabled={demo} /></label>
      <label>Cargo <select value={office} disabled><option value="" disabled>Selecione</option>{offices.map((item) => <option key={item}>{item}</option>)}</select></label>
      <span className="demo-note">{demo ? 'Modo demonstração local — voto não gravado' : 'Voto enviado à API configurada'}</span>
    </section>
    <section className="machine">
      <div className="display-panel">
        <div className="display-head"><div><small>ELEIÇÕES • SIMULAÇÃO</small><h1>SEU VOTO<br/>PARA <strong>{office.toUpperCase()}</strong></h1></div><div className="seal">BR<br/><b>VOTO</b></div></div>
        <div className="instruction">Digite o número do seu candidato:</div>
        <div className="ballot-area">
          {finished ? <div className="fim">FIM</div> : <>
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
        <div className="keys">{['1','2','3','4','5','6','7','8','9'].map((n) => <button key={n} className="number-key" onClick={() => key(n)} disabled={finished || busy}>{n}</button>)}<button className="number-key zero" onClick={() => key('0')} disabled={finished || busy}>0</button></div>
        <div className="action-keys"><button className="white-key" onClick={() => confirm('blank')} disabled={finished || busy}>BRANCO</button><button className="orange-key" onClick={() => finished ? null : resetField()} disabled={busy}>CORRIGE</button><button className="green-key" onClick={() => confirm(invalid ? 'null' : 'candidate')} disabled={finished || busy}>CONFIRMA <span>↵</span></button></div>
        {finished && demo && <button className="again" onClick={() => { setFinished(false); setToken(''); setOffice(offices[0] ?? ''); resetField(); }}>REINICIAR DEMONSTRAÇÃO</button>}
      </div>
    </section>
    <footer className="page-foot"><span>Projeto didático • Não utilizar em eleições reais</span><span>Confirme os dados antes de registrar</span></footer>
  </main>;
}
