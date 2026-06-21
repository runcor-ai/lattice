import { createRouter, createWebHashHistory } from 'vue-router';

const RosterView = () => import('./views/RosterView.vue');
const InstantiateView = () => import('./views/InstantiateView.vue');
const InspectView = () => import('./views/InspectView.vue');
const NewCompanyView = () => import('./views/NewCompanyView.vue');
const VisualizeView = () => import('./views/VisualizeView.vue');
const ForecastView = () => import('./views/ForecastView.vue');

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: RosterView },
    { path: '/instantiate', component: InstantiateView },
    { path: '/new-company', component: NewCompanyView },
    { path: '/lattice/:id', component: InspectView, props: true },
    { path: '/lattice/:id/visualize', component: VisualizeView, props: true },
    { path: '/lattice/:id/forecast', component: ForecastView, props: true },
  ],
});
