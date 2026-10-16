import React from 'react';
import { createRoot } from 'react-dom/client';
import Urna from './urna.jsx';
import Admin from './admin.jsx';
import './style.css';
import './urna-3d.css';
const Page = new URLSearchParams(location.search).get('admin') === '1' ? Admin : Urna;
createRoot(document.getElementById('root')).render(<React.StrictMode><Page /></React.StrictMode>);
