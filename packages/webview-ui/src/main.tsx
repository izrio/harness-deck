import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/index.css';
import { watchAccent } from './theme.ts';
import { isIdeWebviewEnvironment } from './transport.ts';

watchAccent();

if (
  !isIdeWebviewEnvironment() &&
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  window.location.protocol !== 'vscode-webview:'
) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
