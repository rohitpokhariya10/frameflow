import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import './styles.css';
import { loadEditorFonts } from './features/text/fonts';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<div className="font-loading" role="status">Preparing your workspace…</div>);
void loadEditorFonts().then(() => {
  root.render(<React.StrictMode><Provider store={store}><App /></Provider></React.StrictMode>);
}).catch(() => {
  root.render(<div className="font-loading" role="alert"><p>We couldn’t load the editor fonts.</p><button className="button" onClick={() => location.reload()}>Try again</button></div>);
});
