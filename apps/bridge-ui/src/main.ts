import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { router } from './router.js';
// Self-hosted typefaces (offline console — no CDN). IBM Plex: sans for chrome,
// mono for all figures/IDs/timestamps (the instrument-readout voice).
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles/tokens.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
