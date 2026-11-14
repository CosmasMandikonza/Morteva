import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
