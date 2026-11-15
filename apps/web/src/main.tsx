import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Landing } from './landing/Landing';
import { resolveRoute, rewriteLegacyUrl } from './router';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './styles.css';
import './landing/landing.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in index.html');

// Legacy deep links (the app used to live at the bare origin: /#missions,
// /missions, …) are rewritten in place to /app#… before resolving.
rewriteLegacyUrl();
const route = resolveRoute(window.location.pathname, window.location.hash);

createRoot(container).render(
  <StrictMode>{route.page === 'landing' ? <Landing /> : <App />}</StrictMode>,
);
